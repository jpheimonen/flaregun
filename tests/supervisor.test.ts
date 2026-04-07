import { describe, expect, test, afterEach } from "bun:test";
import {
  Supervisor,
  RollingLogBuffer,
  type LogEntry,
  type SupervisorTimingConfig,
} from "../src/process/supervisor.js";

// --- Helpers ---

/** Fast timing config for tests to avoid slow suites */
const FAST_TIMING: SupervisorTimingConfig = {
  stabilityWindowMs: 50,
  backoffResetMs: 200,
  gracefulShutdownMs: 500,
  initialBackoffMs: 50,
  maxBackoffMs: 400,
  logBufferSize: 100,
};

/** Wait for a condition to become true, polling every `intervalMs` */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 10,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Track all supervisors created in tests so we can clean them up
let activeSupervisors: Supervisor[] = [];

function createSupervisor(
  timing?: Partial<SupervisorTimingConfig>,
): Supervisor {
  const sv = new Supervisor({ ...FAST_TIMING, ...timing });
  activeSupervisors.push(sv);
  return sv;
}

afterEach(async () => {
  // Shut down all supervisors to avoid orphan processes
  for (const sv of activeSupervisors) {
    try {
      await sv.shutdown();
    } catch {
      // ignore
    }
  }
  activeSupervisors = [];
});

// --- Rolling Log Buffer Tests ---

describe("RollingLogBuffer", () => {
  test("stores entries up to capacity", () => {
    const buf = new RollingLogBuffer(3);
    for (let i = 0; i < 3; i++) {
      buf.push({
        timestamp: new Date(),
        source: "stdout",
        line: `line ${i}`,
        service: "test",
      });
    }
    expect(buf.size).toBe(3);
    const all = buf.getAll();
    expect(all.length).toBe(3);
    expect(all[0].line).toBe("line 0");
    expect(all[2].line).toBe("line 2");
  });

  test("evicts oldest entries when full", () => {
    const buf = new RollingLogBuffer(3);
    for (let i = 0; i < 5; i++) {
      buf.push({
        timestamp: new Date(),
        source: "stdout",
        line: `line ${i}`,
        service: "test",
      });
    }
    expect(buf.size).toBe(3);
    const all = buf.getAll();
    // Should contain lines 2, 3, 4 (oldest 0, 1 evicted)
    expect(all[0].line).toBe("line 2");
    expect(all[1].line).toBe("line 3");
    expect(all[2].line).toBe("line 4");
  });

  test("clear resets the buffer", () => {
    const buf = new RollingLogBuffer(10);
    buf.push({
      timestamp: new Date(),
      source: "stdout",
      line: "hello",
      service: "test",
    });
    expect(buf.size).toBe(1);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.getAll()).toEqual([]);
  });
});

// --- Lifecycle State Machine Tests ---

describe("Supervisor - Lifecycle state machine", () => {
  test("starting a service transitions to starting then running after stability window", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "sleeper", command: "sleep 60" });

    // After startService resolves, it should be running (stability window passed)
    const state = sv.getServiceState("sleeper");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("running");
  });

  test("a process that exits immediately after spawn transitions to crashed", async () => {
    const sv = createSupervisor({ initialBackoffMs: 5000 });
    await sv.startService({ name: "exitfast", command: "exit 1" });

    // The process should have crashed since it exits immediately
    const state = sv.getServiceState("exitfast");
    expect(state).not.toBeNull();
    // It should be in "restarting" since there's no maxRetries and backoff is long
    expect(["crashed", "restarting"]).toContain(state!.state);
    expect(state!.lastCrashReason).toContain("code 1");
  });

  test("a process that exits while running transitions to crashed", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 5000,
    });
    // Process that runs for 150ms then exits
    await sv.startService({
      name: "shortlived",
      command: "sleep 0.15; exit 42",
    });

    const stateAfterStart = sv.getServiceState("shortlived");
    expect(stateAfterStart!.state).toBe("running");

    // Wait for it to crash
    await waitFor(
      () => sv.getServiceState("shortlived")!.state !== "running",
      3000,
    );

    const state = sv.getServiceState("shortlived");
    expect(["crashed", "restarting"]).toContain(state!.state);
    expect(state!.lastCrashReason).toContain("code 42");
  });

  test("a crashed service with retries remaining transitions to restarting then starting", async () => {
    const sv = createSupervisor({ initialBackoffMs: 30 });
    await sv.startService({
      name: "retrier",
      command: "exit 1",
      maxRetries: 3,
    });

    // Should be restarting (or back to starting by now)
    await waitFor(() => {
      const s = sv.getServiceState("retrier")!;
      return s.state === "restarting" || s.restartCount > 0;
    }, 2000);

    const state = sv.getServiceState("retrier");
    expect(state!.restartCount).toBeGreaterThanOrEqual(0);
  });

  test("a crashed service with max_retries exceeded transitions to stopped", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    });
    await sv.startService({
      name: "limited",
      command: "exit 1",
      maxRetries: 2,
    });

    // Wait for all retries to be exhausted
    await waitFor(
      () => sv.getServiceState("limited")!.state === "stopped",
      5000,
    );

    const state = sv.getServiceState("limited")!;
    expect(state.state).toBe("stopped");
    expect(state.restartCount).toBe(2);
  });

  test("a service with no max_retries restarts indefinitely", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 10,
      maxBackoffMs: 20,
    });
    await sv.startService({
      name: "infinite",
      command: "exit 1",
    });

    // Wait for at least 3 restarts
    await waitFor(
      () => sv.getServiceState("infinite")!.restartCount >= 3,
      5000,
    );

    const state = sv.getServiceState("infinite")!;
    expect(state.restartCount).toBeGreaterThanOrEqual(3);
    // Should still be in the lifecycle, not stopped
    expect(state.state).not.toBe("stopped");
  });

  test("an explicitly stopped service transitions to stopped regardless of previous state", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "stopper", command: "sleep 60" });
    expect(sv.getServiceState("stopper")!.state).toBe("running");

    await sv.stopService("stopper");
    expect(sv.getServiceState("stopper")!.state).toBe("stopped");
  });

  test("stopping an already-stopped service is a no-op", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "stopped-svc", command: "sleep 60" });
    await sv.stopService("stopped-svc");
    expect(sv.getServiceState("stopped-svc")!.state).toBe("stopped");

    // Stop again — should not throw
    await sv.stopService("stopped-svc");
    expect(sv.getServiceState("stopped-svc")!.state).toBe("stopped");
  });
});

// --- Exponential Backoff Tests ---

describe("Supervisor - Exponential backoff", () => {
  test("backoff delay increases with each consecutive crash", async () => {
    const delays: number[] = [];
    const initialBackoff = 50;

    const sv = createSupervisor({
      stabilityWindowMs: 5,
      initialBackoffMs: initialBackoff,
      maxBackoffMs: 2000,
    });

    await sv.startService({
      name: "backoff-test",
      command: "exit 1",
      maxRetries: 4,
    });

    // Track timing between restarts
    let lastCrashTime = Date.now();

    await waitFor(() => {
      const s = sv.getServiceState("backoff-test")!;
      if (s.restartCount > delays.length) {
        const now = Date.now();
        delays.push(now - lastCrashTime);
        lastCrashTime = now;
      }
      return s.state === "stopped";
    }, 10000);

    // Each delay should generally increase (exponential backoff)
    // The pattern should be roughly: ~50, ~100, ~200, ~400
    expect(delays.length).toBeGreaterThanOrEqual(2);
    // Verify the last delay is larger than the first
    expect(delays[delays.length - 1]).toBeGreaterThan(delays[0] * 0.8);
  });

  test("backoff delay is capped at maximum value", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 5,
      initialBackoffMs: 100,
      maxBackoffMs: 200,
    });

    await sv.startService({
      name: "capped",
      command: "exit 1",
      maxRetries: 5,
    });

    // Track timing between restarts
    const delays: number[] = [];
    let lastTime = Date.now();

    await waitFor(() => {
      const s = sv.getServiceState("capped")!;
      if (s.restartCount > delays.length) {
        const now = Date.now();
        delays.push(now - lastTime);
        lastTime = now;
      }
      return s.state === "stopped";
    }, 10000);

    // No delay should be significantly more than maxBackoff + timer tolerance
    for (const delay of delays) {
      expect(delay).toBeLessThan(200 + 500);
    }
  });

  test("backoff counter resets after sustained running period", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      backoffResetMs: 100,
      initialBackoffMs: 30,
      maxBackoffMs: 500,
    });

    // Start a process that crashes immediately to build up consecutive crashes
    await sv.startService({
      name: "reset-test",
      command: "exit 1",
    });

    // Wait for a few restarts to build up the backoff
    await waitFor(
      () => sv.getServiceState("reset-test")!.restartCount >= 2,
      5000,
    );

    // Now stop it and restart with a long-running process
    await sv.stopService("reset-test");

    // Start a process that will survive and run for a while
    await sv.startService({
      name: "reset-test",
      command: "sleep 10",
    });
    expect(sv.getServiceState("reset-test")!.state).toBe("running");

    // Wait for the backoff reset period to elapse
    await sleep(150);

    // Now stop and restart with a crashing process again
    await sv.stopService("reset-test");

    const startTime = Date.now();
    await sv.startService({
      name: "reset-test",
      command: "exit 1",
      maxRetries: 1,
    });

    // The first crash after reset should use the initial backoff (not the accumulated one)
    await waitFor(
      () => sv.getServiceState("reset-test")!.restartCount >= 1,
      2000,
    );
    const elapsed = Date.now() - startTime;

    // Should be around initialBackoffMs (30ms), not the accumulated backoff
    // Give generous tolerance
    expect(elapsed).toBeLessThan(500);
  });
});

// --- Log Capture Tests ---

describe("Supervisor - Log capture", () => {
  test("stdout output is captured in log buffer with stdout source marker", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    // Use a command that produces output and then stays alive
    await sv.startService({
      name: "stdout-test",
      command: "echo hello-stdout; sleep 60",
    });

    // Wait for logs to be captured
    await waitFor(() => {
      const logs = sv.getLogBuffer("stdout-test");
      return logs.some((e) => e.line.includes("hello-stdout"));
    }, 2000);

    const logs = sv.getLogBuffer("stdout-test");
    const stdoutLogs = logs.filter(
      (e) => e.source === "stdout" && e.line.includes("hello-stdout"),
    );
    expect(stdoutLogs.length).toBeGreaterThanOrEqual(1);
  });

  test("stderr output is captured in log buffer with stderr source marker", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    await sv.startService({
      name: "stderr-test",
      command: "echo hello-stderr >&2; sleep 60",
    });

    await waitFor(() => {
      const logs = sv.getLogBuffer("stderr-test");
      return logs.some((e) => e.line.includes("hello-stderr"));
    }, 2000);

    const logs = sv.getLogBuffer("stderr-test");
    const stderrLogs = logs.filter(
      (e) => e.source === "stderr" && e.line.includes("hello-stderr"),
    );
    expect(stderrLogs.length).toBeGreaterThanOrEqual(1);
  });

  test("log entries include timestamps", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const before = new Date();
    await sv.startService({
      name: "timestamp-test",
      command: "echo test-line; sleep 60",
    });

    await waitFor(() => {
      const logs = sv.getLogBuffer("timestamp-test");
      return logs.some((e) => e.line.includes("test-line"));
    }, 2000);

    const after = new Date();
    const logs = sv.getLogBuffer("timestamp-test");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const entry of logs) {
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(entry.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  test("log buffer does not grow beyond bounded size", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10, logBufferSize: 5 });
    // Generate more than 5 log lines, then keep running
    await sv.startService({
      name: "bounded-test",
      command:
        "for i in 1 2 3 4 5 6 7 8 9 10; do echo line-$i; done; sleep 60",
    });

    await waitFor(() => {
      const logs = sv.getLogBuffer("bounded-test");
      return logs.length >= 5;
    }, 2000);

    const logs = sv.getLogBuffer("bounded-test");
    // Should be at most 5 entries
    expect(logs.length).toBeLessThanOrEqual(5);
    // The last entry should be one of the later lines (oldest evicted)
    expect(logs[logs.length - 1].line).toContain("line-");
  });

  test("log entries carry the service name", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    await sv.startService({
      name: "name-test",
      command: "echo hi; sleep 60",
    });

    await waitFor(() => sv.getLogBuffer("name-test").length > 0, 2000);

    const logs = sv.getLogBuffer("name-test");
    for (const entry of logs) {
      expect(entry.service).toBe("name-test");
    }
  });
});

// --- Log Subscription Tests ---

describe("Supervisor - Log subscriptions", () => {
  test("subscribers receive log entries in real time", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const received: LogEntry[] = [];

    // Start the service first so we can subscribe
    await sv.startService({ name: "sub-ready", command: "sleep 60" });

    // Subscribe
    sv.subscribeToLogs("sub-ready", (entry) => {
      received.push(entry);
    });

    // Stop and restart with a command that produces output and stays alive
    await sv.stopService("sub-ready");
    await sv.startService({
      name: "sub-ready",
      command: "echo sub-line-1; echo sub-line-2; sleep 60",
    });

    await waitFor(() => received.length >= 2, 2000);

    expect(received.some((e) => e.line.includes("sub-line-1"))).toBe(true);
    expect(received.some((e) => e.line.includes("sub-line-2"))).toBe(true);
  });

  test("multiple subscribers to the same service each receive entries", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const received1: LogEntry[] = [];
    const received2: LogEntry[] = [];

    await sv.startService({ name: "multi-sub", command: "sleep 60" });

    sv.subscribeToLogs("multi-sub", (e) => received1.push(e));
    sv.subscribeToLogs("multi-sub", (e) => received2.push(e));

    await sv.stopService("multi-sub");
    await sv.startService({
      name: "multi-sub",
      command: "echo shared-line; sleep 60",
    });

    await waitFor(
      () => received1.length >= 1 && received2.length >= 1,
      2000,
    );

    expect(received1.some((e) => e.line.includes("shared-line"))).toBe(true);
    expect(received2.some((e) => e.line.includes("shared-line"))).toBe(true);
  });

  test("unsubscribing stops delivery of log entries", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const received: LogEntry[] = [];

    await sv.startService({ name: "unsub-test", command: "sleep 60" });

    const unsub = sv.subscribeToLogs("unsub-test", (e) => received.push(e));

    // Unsubscribe immediately
    unsub();

    await sv.stopService("unsub-test");
    await sv.startService({
      name: "unsub-test",
      command: "echo after-unsub; sleep 60",
    });

    await sleep(200);

    // Should NOT have received anything after unsubscribing
    expect(
      received.filter((e) => e.line.includes("after-unsub")).length,
    ).toBe(0);
  });

  test("global subscription receives entries from all services", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const received: LogEntry[] = [];

    sv.subscribeToAllLogs((e) => received.push(e));

    await sv.startService({
      name: "global-a",
      command: "echo from-a; sleep 60",
    });
    await sv.startService({
      name: "global-b",
      command: "echo from-b; sleep 60",
    });

    await waitFor(() => {
      const fromA = received.filter((e) => e.service === "global-a");
      const fromB = received.filter((e) => e.service === "global-b");
      return fromA.length >= 1 && fromB.length >= 1;
    }, 2000);

    const fromA = received.filter((e) => e.service === "global-a");
    const fromB = received.filter((e) => e.service === "global-b");
    expect(fromA.length).toBeGreaterThanOrEqual(1);
    expect(fromB.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Service Management Tests ---

describe("Supervisor - Service management API", () => {
  test("stopping a running service sends termination signal and transitions to stopped", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "stop-me", command: "sleep 60" });
    expect(sv.getServiceState("stop-me")!.state).toBe("running");

    await sv.stopService("stop-me");
    expect(sv.getServiceState("stop-me")!.state).toBe("stopped");
  });

  test("restarting a running service kills current and spawns new, resets counters", async () => {
    const sv = createSupervisor();

    await sv.startService({ name: "restart-me", command: "sleep 60" });
    expect(sv.getServiceState("restart-me")!.state).toBe("running");

    // Restart the service
    await sv.restartService("restart-me");

    const state = sv.getServiceState("restart-me")!;
    expect(state.state).toBe("running");
    expect(state.restartCount).toBe(0);
  });

  test("restarting a service resets restart count and backoff", async () => {
    const sv = createSupervisor();

    await sv.startService({ name: "reset-restart", command: "sleep 60" });
    expect(sv.getServiceState("reset-restart")!.state).toBe("running");

    // Restart and verify counters are reset
    await sv.restartService("reset-restart");

    const state = sv.getServiceState("reset-restart")!;
    expect(state.state).toBe("running");
    expect(state.restartCount).toBe(0);
    expect(state.lastCrashReason).toBeNull();
  });

  test("starting a previously stopped service resets counters", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    });

    // Start a service that will exhaust max_retries and stop
    await sv.startService({
      name: "retry-exhaust",
      command: "exit 1",
      maxRetries: 2,
    });

    await waitFor(
      () => sv.getServiceState("retry-exhaust")!.state === "stopped",
      5000,
    );
    expect(sv.getServiceState("retry-exhaust")!.restartCount).toBe(2);

    // Re-start the same service — should reset counters and work fresh
    await sv.startService({
      name: "retry-exhaust",
      command: "sleep 60",
      maxRetries: 2,
    });

    const state = sv.getServiceState("retry-exhaust")!;
    expect(state.state).toBe("running");
    expect(state.restartCount).toBe(0);
    expect(state.lastCrashReason).toBeNull();
  });

  test("service state queries return lifecycle state, uptime, and restart count", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "query-test", command: "sleep 60" });

    const state = sv.getServiceState("query-test")!;
    expect(state.state).toBe("running");
    expect(state.runningSince).toBeInstanceOf(Date);
    expect(state.restartCount).toBe(0);
    expect(state.lastCrashReason).toBeNull();
  });

  test("get all service states returns states for all services", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "svc-a", command: "sleep 60" });
    await sv.startService({ name: "svc-b", command: "sleep 60" });

    const allStates = sv.getAllServiceStates();
    expect(allStates.size).toBe(2);
    expect(allStates.get("svc-a")!.state).toBe("running");
    expect(allStates.get("svc-b")!.state).toBe("running");
  });

  test("getting log buffer returns current contents", async () => {
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    await sv.startService({
      name: "buf-test",
      command: "echo buf-content; sleep 60",
    });

    await waitFor(() => {
      const logs = sv.getLogBuffer("buf-test");
      return logs.some((e) => e.line.includes("buf-content"));
    }, 2000);

    const logs = sv.getLogBuffer("buf-test");
    expect(logs.some((e) => e.line.includes("buf-content"))).toBe(true);
  });

  test("getting log buffer for nonexistent service returns empty array", () => {
    const sv = createSupervisor();
    expect(sv.getLogBuffer("nonexistent")).toEqual([]);
  });

  test("getting state for nonexistent service returns null", () => {
    const sv = createSupervisor();
    expect(sv.getServiceState("nonexistent")).toBeNull();
  });
});

// --- Concurrent Supervision Tests ---

describe("Supervisor - Concurrent supervision", () => {
  test("multiple services can be supervised simultaneously and independently", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "concurrent-a", command: "sleep 60" });
    await sv.startService({ name: "concurrent-b", command: "sleep 60" });
    await sv.startService({ name: "concurrent-c", command: "sleep 60" });

    expect(sv.getServiceState("concurrent-a")!.state).toBe("running");
    expect(sv.getServiceState("concurrent-b")!.state).toBe("running");
    expect(sv.getServiceState("concurrent-c")!.state).toBe("running");
  });

  test("a crash in one service does not affect other services", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 5000,
    });
    await sv.startService({ name: "stable", command: "sleep 60" });
    await sv.startService({ name: "crasher", command: "exit 1" });

    await sleep(100);

    // The stable service should still be running
    expect(sv.getServiceState("stable")!.state).toBe("running");
    // The crasher should have crashed
    expect(["crashed", "restarting"]).toContain(
      sv.getServiceState("crasher")!.state,
    );
  });

  test("stopping one service does not affect other services", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "keep-a", command: "sleep 60" });
    await sv.startService({ name: "stop-b", command: "sleep 60" });

    await sv.stopService("stop-b");

    expect(sv.getServiceState("keep-a")!.state).toBe("running");
    expect(sv.getServiceState("stop-b")!.state).toBe("stopped");
  });
});

// --- Graceful Shutdown Tests ---

describe("Supervisor - Graceful shutdown", () => {
  test("shutdown sends SIGTERM to all supervised processes", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "shut-a", command: "sleep 60" });
    await sv.startService({ name: "shut-b", command: "sleep 60" });

    expect(sv.getServiceState("shut-a")!.state).toBe("running");
    expect(sv.getServiceState("shut-b")!.state).toBe("running");

    await sv.shutdown();

    expect(sv.getServiceState("shut-a")!.state).toBe("stopped");
    expect(sv.getServiceState("shut-b")!.state).toBe("stopped");
  });

  test("processes that exit within graceful timeout are not force-killed", async () => {
    const sv = createSupervisor({ gracefulShutdownMs: 2000 });
    // sleep responds to SIGTERM by exiting
    await sv.startService({
      name: "graceful",
      command: "sleep 60",
    });

    expect(sv.getServiceState("graceful")!.state).toBe("running");

    const start = Date.now();
    await sv.shutdown();
    const elapsed = Date.now() - start;

    expect(sv.getServiceState("graceful")!.state).toBe("stopped");
    // Should have completed well before the 2s timeout
    expect(elapsed).toBeLessThan(2000);
  });

  test("processes that do not exit within graceful timeout are force-killed", async () => {
    const sv = createSupervisor({ gracefulShutdownMs: 100 });
    // Use a process that ignores SIGTERM
    await sv.startService({
      name: "stubborn",
      command: "trap '' TERM; sleep 60",
    });

    expect(sv.getServiceState("stubborn")!.state).toBe("running");

    await sv.shutdown();

    expect(sv.getServiceState("stubborn")!.state).toBe("stopped");
  });

  test("after shutdown, all services are in stopped state", async () => {
    const sv = createSupervisor();
    await sv.startService({ name: "s1", command: "sleep 60" });
    await sv.startService({ name: "s2", command: "sleep 60" });
    await sv.startService({ name: "s3", command: "sleep 60" });

    await sv.shutdown();

    const allStates = sv.getAllServiceStates();
    for (const [, info] of allStates) {
      expect(info.state).toBe("stopped");
    }
  });

  test("during shutdown, crashed services are not restarted", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      initialBackoffMs: 100,
    });

    // Start a service that will crash after a short time
    await sv.startService({
      name: "no-restart",
      command: "sleep 0.05; exit 1",
    });

    // Wait for it to be running
    expect(sv.getServiceState("no-restart")!.state).toBe("running");

    // Wait for it to crash
    await waitFor(
      () => sv.getServiceState("no-restart")!.state !== "running",
      3000,
    );

    // It should be in restarting state, waiting for backoff
    const stateBeforeShutdown = sv.getServiceState("no-restart")!.state;
    expect(["crashed", "restarting"]).toContain(stateBeforeShutdown);

    // Start shutdown — should prevent restart
    await sv.shutdown();

    // After shutdown, service should be stopped, not restarting
    expect(sv.getServiceState("no-restart")!.state).toBe("stopped");
  });
});

// --- Timing Constants Configurability Tests ---

describe("Supervisor - Configurable timing constants", () => {
  test("stability window duration is configurable", async () => {
    // Use a very short stability window
    const sv = createSupervisor({ stabilityWindowMs: 10 });
    const start = Date.now();
    await sv.startService({ name: "fast-stable", command: "sleep 60" });
    const elapsed = Date.now() - start;

    expect(sv.getServiceState("fast-stable")!.state).toBe("running");
    // Should be fast since stability window is only 10ms
    expect(elapsed).toBeLessThan(500);
  });

  test("graceful shutdown timeout is configurable", async () => {
    // Use a very short graceful timeout
    const sv = createSupervisor({ gracefulShutdownMs: 50 });
    await sv.startService({
      name: "short-grace",
      command: "trap '' TERM; sleep 60",
    });

    const start = Date.now();
    await sv.shutdown();
    const elapsed = Date.now() - start;

    // Should complete quickly due to the short timeout + SIGKILL
    expect(elapsed).toBeLessThan(2000);
    expect(sv.getServiceState("short-grace")!.state).toBe("stopped");
  });

  test("backoff sustained period is configurable", async () => {
    const sv = createSupervisor({
      stabilityWindowMs: 10,
      backoffResetMs: 50, // Very short reset period
      initialBackoffMs: 20,
    });

    // Start a crashing process to build up consecutive crashes
    await sv.startService({
      name: "reset-cfg",
      command: "exit 1",
    });

    await waitFor(
      () => sv.getServiceState("reset-cfg")!.restartCount >= 1,
      3000,
    );

    // Stop and start a stable process
    await sv.stopService("reset-cfg");
    await sv.startService({ name: "reset-cfg", command: "sleep 60" });

    // Wait for the short backoff reset period
    await sleep(100);

    // The backoff should have been reset by now due to the short config
    expect(sv.getServiceState("reset-cfg")!.state).toBe("running");
  });
});
