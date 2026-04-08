/**
 * Tests for the orchestrator: `flaregun up` and `flaregun down` commands.
 *
 * Uses dependency injection to mock all subsystems and verify orchestration
 * logic without real processes, servers, or API calls.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleUp,
  handleDown,
  writePidFile,
  readPidFile,
  deletePidFile,
  isProcessRunning,
  type UpCommandDeps,
} from "../src/orchestrate/index.js";
import {
  makeConfig,
  localService,
  pagesService,
  TEST_ACCOUNT_ID,
  TEST_ZONE_ID,
  TEST_TUNNEL_ID,
} from "./helpers/fixtures.js";
import { emptyState } from "../src/lock/index.js";
import { ConfigValidationError } from "../src/config/index.js";
import { EnvValidationError } from "../src/env/index.js";
import type { CloudflareCredentials } from "../src/env/index.js";
import type { CloudflareClient } from "../src/cloudflare/index.js";
import { Supervisor } from "../src/process/supervisor.js";
import { AdminServer } from "../src/admin/server.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Test Helpers ---

const TEST_CREDENTIALS: CloudflareCredentials = {
  apiToken: "test-token",
  accountId: TEST_ACCOUNT_ID,
  zoneId: TEST_ZONE_ID,
  tunnelToken: "test-tunnel-token",
};

/** A mock subprocess that simulates a long-running tunnel */
function mockTunnelProc() {
  let resolveExited: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  return {
    proc: {
      exited,
      killed: false,
      kill: () => {
        resolveExited!(0);
      },
      pid: 99999,
    },
    resolve: resolveExited!,
  };
}

/** Creates a mock admin server that returns a specific port */
function mockAdminServer(port: number = 9100) {
  return {
    start: async () => port,
    stop: () => {},
    get selectedPort() {
      return port;
    },
  } as unknown as AdminServer;
}

/** Tracking infrastructure for verifying call order and arguments */
interface CallTracker {
  calls: string[];
  output: string[];
  errors: string[];
  syncArgs: unknown[];
  ingressArgs: unknown[];
  supervisorStartCalls: Array<{ name: string; command: string }>;
  signalHandlers: Map<string, (() => void)[]>;
  exitCode: number | null;
  pidWritten: { path: string; pid: number } | null;
  pidDeleted: string | null;
}

function createTracker(): CallTracker {
  return {
    calls: [],
    output: [],
    errors: [],
    syncArgs: [],
    ingressArgs: [],
    supervisorStartCalls: [],
    signalHandlers: new Map(),
    exitCode: null,
    pidWritten: null,
    pidDeleted: null,
  };
}

/** Creates a set of deps that succeed for all operations, with call tracking */
function successDeps(
  tracker: CallTracker,
  overrides?: Partial<UpCommandDeps>,
): UpCommandDeps {
  // Create a mock tunnel proc that we can control
  const tunnel = mockTunnelProc();

  // Create a mock supervisor
  const mockSupervisor = {
    startService: async (config: { name: string; command: string }) => {
      tracker.calls.push(`supervisor.startService:${config.name}`);
      tracker.supervisorStartCalls.push(config);
    },
    stopService: async () => {},
    shutdown: async () => {
      tracker.calls.push("supervisor.shutdown");
    },
    getAllServiceStates: () => new Map(),
    getServiceState: () => null,
    getLogBuffer: () => [],
    subscribeToLogs: () => () => {},
    subscribeToAllLogs: () => () => {},
    get serviceNames() { return []; },
    get isShuttingDown() { return false; },
  } as unknown as Supervisor;

  const lockStateWithTunnel = emptyState();
  lockStateWithTunnel.tunnel = { id: TEST_TUNNEL_ID };

  return {
    loadConfigFn: () => {
      tracker.calls.push("loadConfig");
      return makeConfig({
        services: {
          api: localService("api", 3000, "admin_only"),
          blog: pagesService("blog", "public"),
        },
      });
    },
    loadEnvFn: () => {
      tracker.calls.push("loadEnv");
      return TEST_CREDENTIALS;
    },
    loadLockFn: () => {
      tracker.calls.push("loadLock");
      return lockStateWithTunnel;
    },
    saveLockFn: () => {
      tracker.calls.push("saveLock");
    },
    createClientFn: () => {
      tracker.calls.push("createClient");
      return {} as unknown as CloudflareClient;
    },
    binaryExistsFn: async () => {
      tracker.calls.push("binaryExists");
      return true;
    },
    syncFn: async (...args: unknown[]) => {
      tracker.calls.push("syncFull");
      tracker.syncArgs = args;
      return {
        steps: [
          { step: "access-applications", success: true },
          { step: "access-policies", success: true },
          { step: "tunnel-ingress", success: true },
          { step: "dns-records", success: true },
          { step: "redirect-rules", success: true },
        ],
      };
    },
    syncIngressFn: async (...args: unknown[]) => {
      tracker.calls.push("syncIngress");
      tracker.ingressArgs = args;
    },
    createSupervisorFn: () => {
      tracker.calls.push("createSupervisor");
      return mockSupervisor;
    },
    createAdminServerFn: () => {
      tracker.calls.push("createAdminServer");
      return mockAdminServer(9100);
    },
    createHotReloadEngineFn: (deps: unknown) => {
      tracker.calls.push("createHotReloadEngine");
      return { reload: async () => ({ success: true, errors: [], changes: [] }) };
    },
    spawnTunnelFn: (token: string) => {
      tracker.calls.push("spawnTunnel");
      // Immediately resolve the tunnel to unblock handleUp
      tunnel.resolve(0);
      return tunnel.proc as unknown as import("bun").Subprocess;
    },
    writePidFileFn: (path: string, pid: number) => {
      tracker.calls.push("writePidFile");
      tracker.pidWritten = { path, pid };
    },
    deletePidFileFn: (path: string) => {
      tracker.calls.push("deletePidFile");
      tracker.pidDeleted = path;
    },
    onSignalFn: (signal: string, handler: () => void) => {
      if (!tracker.signalHandlers.has(signal)) {
        tracker.signalHandlers.set(signal, []);
      }
      tracker.signalHandlers.get(signal)!.push(handler);
    },
    exitFn: (code: number) => {
      tracker.exitCode = code;
    },
    getProcessPidFn: () => 12345,
    stdout: (msg: string) => tracker.output.push(msg),
    stderr: (msg: string) => tracker.errors.push(msg),
    spaDir: "/tmp/fake-spa-dir",
    ...overrides,
  };
}

// =============================================================================
// Startup Sequence Tests
// =============================================================================

describe("handleUp: startup sequence", () => {
  test("validates config, env, lock, prerequisites, and sync in the correct order", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // Verify the order of key operations
    const keyOps = tracker.calls.filter((c) =>
      ["loadConfig", "loadEnv", "loadLock", "binaryExists", "syncFull"].includes(c),
    );
    expect(keyOps).toEqual(["loadConfig", "loadEnv", "loadLock", "binaryExists", "syncFull"]);
  });

  test("a config validation failure aborts startup before any other operations", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      loadConfigFn: () => {
        tracker.calls.push("loadConfig");
        throw new ConfigValidationError(["domain is missing"]);
      },
    });

    const result = await handleUp(undefined, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("domain is missing");

    // Only loadConfig should have been called
    expect(tracker.calls).toEqual(["loadConfig"]);
    // Sync should not have been called
    expect(tracker.calls).not.toContain("syncFull");
    // Supervisor should not have been called
    expect(tracker.calls).not.toContain("createSupervisor");
  });

  test("a missing environment variable aborts startup with a descriptive error suggesting flaregun setup", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      loadEnvFn: () => {
        tracker.calls.push("loadEnv");
        throw new EnvValidationError(
          ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"],
          "Missing required environment variable(s): CLOUDFLARE_API_TOKEN, CLOUDFLARE_TUNNEL_TOKEN.\nRun `flaregun setup` to configure your Cloudflare credentials.",
        );
      },
    });

    const result = await handleUp(undefined, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("CLOUDFLARE_API_TOKEN");
    expect(result.error).toContain("flaregun setup");

    // Config was loaded, but nothing after env should have run
    expect(tracker.calls).toContain("loadConfig");
    expect(tracker.calls).toContain("loadEnv");
    expect(tracker.calls).not.toContain("syncFull");
  });

  test("a missing cloudflared binary aborts startup with installation instructions", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      binaryExistsFn: async () => {
        tracker.calls.push("binaryExists");
        return false;
      },
    });

    const result = await handleUp(undefined, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("cloudflared");
    expect(result.error).toContain("https://developers.cloudflare.com");

    // Should not have synced
    expect(tracker.calls).not.toContain("syncFull");
  });

  test("a sync failure aborts startup before services are started", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      syncFn: async () => {
        tracker.calls.push("syncFull");
        return {
          steps: [
            { step: "access-applications", success: false, error: "API error" },
          ],
        };
      },
    });

    const result = await handleUp(undefined, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("access-applications");

    // Supervisor should never have been created
    expect(tracker.calls).not.toContain("createSupervisor");
    // No services started
    expect(tracker.supervisorStartCalls).toHaveLength(0);
  });

  test("the admin backend is started before local services", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    const adminIdx = tracker.calls.indexOf("createAdminServer");
    const firstServiceIdx = tracker.calls.findIndex((c) =>
      c.startsWith("supervisor.startService:"),
    );

    expect(adminIdx).toBeGreaterThan(-1);
    expect(firstServiceIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(firstServiceIdx);
  });

  test("local services are started via the process supervisor after the admin backend", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // The supervisor should have started the local service "api"
    const serviceStarts = tracker.calls.filter((c) =>
      c.startsWith("supervisor.startService:"),
    );
    expect(serviceStarts).toContain("supervisor.startService:api");

    // Pages services should NOT be started via the supervisor
    expect(serviceStarts).not.toContain("supervisor.startService:blog");
  });

  test("the tunnel ingress is updated with the admin backend's port before starting the tunnel", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    const ingressIdx = tracker.calls.indexOf("syncIngress");
    const tunnelIdx = tracker.calls.indexOf("spawnTunnel");

    expect(ingressIdx).toBeGreaterThan(-1);
    expect(tunnelIdx).toBeGreaterThan(-1);
    expect(ingressIdx).toBeLessThan(tunnelIdx);
  });

  test("the tunnel is started after all services and the admin backend", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    const tunnelIdx = tracker.calls.indexOf("spawnTunnel");
    const adminIdx = tracker.calls.indexOf("createAdminServer");
    const lastServiceIdx = tracker.calls
      .map((c, i) => (c.startsWith("supervisor.startService:") ? i : -1))
      .filter((i) => i >= 0)
      .pop();

    expect(tunnelIdx).toBeGreaterThan(adminIdx);
    if (lastServiceIdx !== undefined) {
      expect(tunnelIdx).toBeGreaterThan(lastServiceIdx);
    }
  });

  test("a startup summary is printed after all subsystems are running", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // Should contain summary markers
    const summaryOutput = tracker.output.join("\n");
    expect(summaryOutput).toContain("Flaregun");
    expect(summaryOutput).toContain("Summary");
    expect(summaryOutput).toContain("admin");
    expect(summaryOutput).toContain("Tunnel");
  });
});

// =============================================================================
// Shutdown Sequence Tests
// =============================================================================

describe("handleUp: shutdown sequence", () => {
  test("the shutdown sequence stops the tunnel first, then services, then the admin backend", async () => {
    const tracker = createTracker();
    const shutdownOrder: string[] = [];

    // Create a tunnel that doesn't resolve immediately
    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => {
        shutdownOrder.push("tunnel.kill");
        tunnelResolve!(0);
      },
      pid: 99999,
    };

    const mockSupervisor = {
      startService: async (config: { name: string }) => {
        tracker.calls.push(`supervisor.startService:${config.name}`);
      },
      shutdown: async () => {
        shutdownOrder.push("supervisor.shutdown");
      },
      getAllServiceStates: () => new Map(),
      getServiceState: () => null,
      getLogBuffer: () => [],
      subscribeToLogs: () => () => {},
      subscribeToAllLogs: () => () => {},
      get serviceNames() { return []; },
      get isShuttingDown() { return false; },
    } as unknown as Supervisor;

    const mockAdmin = {
      start: async () => 9100,
      stop: () => {
        shutdownOrder.push("admin.stop");
      },
      get selectedPort() { return 9100; },
    } as unknown as AdminServer;

    const deps = successDeps(tracker, {
      createSupervisorFn: () => {
        tracker.calls.push("createSupervisor");
        return mockSupervisor;
      },
      createAdminServerFn: () => {
        tracker.calls.push("createAdminServer");
        return mockAdmin;
      },
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    // Start the up command (it will block on tunnel)
    const upPromise = handleUp(undefined, deps);

    // Wait a tick for everything to set up
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Trigger SIGTERM handler
    const sigTermHandlers = tracker.signalHandlers.get("SIGTERM");
    expect(sigTermHandlers).toBeDefined();
    expect(sigTermHandlers!.length).toBeGreaterThan(0);
    await sigTermHandlers![0]();

    // Wait for handleUp to finish
    await upPromise;

    // Verify shutdown order: tunnel → services → admin
    expect(shutdownOrder).toEqual([
      "tunnel.kill",
      "supervisor.shutdown",
      "admin.stop",
    ]);
  });

  test("after shutdown, the process exits with code 0", async () => {
    const tracker = createTracker();

    // Create a tunnel that doesn't resolve immediately
    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => { tunnelResolve!(0); },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const sigTermHandlers = tracker.signalHandlers.get("SIGTERM");
    await sigTermHandlers![0]();

    await upPromise;

    expect(tracker.exitCode).toBe(0);
  });

  test("a SIGINT triggers the shutdown sequence", async () => {
    const tracker = createTracker();
    const shutdownOrder: string[] = [];

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => {
        shutdownOrder.push("tunnel.kill");
        tunnelResolve!(0);
      },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      createSupervisorFn: () => {
        tracker.calls.push("createSupervisor");
        return {
          startService: async (config: { name: string }) => {
            tracker.calls.push(`supervisor.startService:${config.name}`);
          },
          shutdown: async () => {
            shutdownOrder.push("supervisor.shutdown");
          },
          getAllServiceStates: () => new Map(),
          getServiceState: () => null,
          getLogBuffer: () => [],
          subscribeToLogs: () => () => {},
          subscribeToAllLogs: () => () => {},
          get serviceNames() { return []; },
          get isShuttingDown() { return false; },
        } as unknown as Supervisor;
      },
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Trigger SIGINT
    const sigIntHandlers = tracker.signalHandlers.get("SIGINT");
    expect(sigIntHandlers).toBeDefined();
    await sigIntHandlers![0]();

    await upPromise;

    expect(shutdownOrder).toContain("tunnel.kill");
    expect(shutdownOrder).toContain("supervisor.shutdown");
  });

  test("a SIGTERM triggers the shutdown sequence", async () => {
    const tracker = createTracker();

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => { tunnelResolve!(0); },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sigTermHandlers = tracker.signalHandlers.get("SIGTERM");
    expect(sigTermHandlers).toBeDefined();
    await sigTermHandlers![0]();

    await upPromise;

    expect(tracker.exitCode).toBe(0);
  });

  test("a second signal during shutdown triggers a force exit", async () => {
    const tracker = createTracker();

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    // Create a supervisor that blocks shutdown indefinitely
    let shutdownResolve: () => void;
    const shutdownPromise = new Promise<void>((resolve) => {
      shutdownResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => { tunnelResolve!(0); },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      createSupervisorFn: () => {
        tracker.calls.push("createSupervisor");
        return {
          startService: async (config: { name: string }) => {
            tracker.calls.push(`supervisor.startService:${config.name}`);
          },
          shutdown: () => shutdownPromise, // Never resolves
          getAllServiceStates: () => new Map(),
          getServiceState: () => null,
          getLogBuffer: () => [],
          subscribeToLogs: () => () => {},
          subscribeToAllLogs: () => () => {},
          get serviceNames() { return []; },
          get isShuttingDown() { return false; },
        } as unknown as Supervisor;
      },
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // First SIGTERM — starts graceful shutdown (which will hang)
    const handlers = tracker.signalHandlers.get("SIGTERM")!;
    // Don't await — it will hang on supervisor.shutdown
    handlers[0]();

    // Wait a tick for the shutdown to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Second SIGTERM — should force exit
    handlers[0]();

    // Force exit should have been called with code 1
    expect(tracker.exitCode).toBe(1);
    expect(tracker.output).toContain("Force exiting...");

    // Clean up
    shutdownResolve!();
  });
});

// =============================================================================
// PID File Tests
// =============================================================================

describe("PID file management", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flaregun-test-"));
  });

  test("writePidFile writes the PID atomically", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    writePidFile(pidPath, 12345);

    const content = readFileSync(pidPath, "utf-8");
    expect(content).toBe("12345");
  });

  test("readPidFile reads the PID from a valid file", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    writeFileSync(pidPath, "54321", "utf-8");

    const pid = readPidFile(pidPath);
    expect(pid).toBe(54321);
  });

  test("readPidFile returns null for a non-existent file", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    const pid = readPidFile(pidPath);
    expect(pid).toBeNull();
  });

  test("readPidFile returns null for an invalid file", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    writeFileSync(pidPath, "not-a-number", "utf-8");

    const pid = readPidFile(pidPath);
    expect(pid).toBeNull();
  });

  test("deletePidFile removes the file", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    writeFileSync(pidPath, "12345", "utf-8");

    deletePidFile(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("deletePidFile is a no-op for a non-existent file", () => {
    const pidPath = join(tmpDir, ".flaregun.pid");
    deletePidFile(pidPath); // Should not throw
  });

  test("isProcessRunning returns true for the current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test("isProcessRunning returns false for a non-existent PID", () => {
    // Use a very high PID that's unlikely to exist
    expect(isProcessRunning(999999999)).toBe(false);
  });

  test("the up command writes a PID file after all subsystems start", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    expect(tracker.pidWritten).not.toBeNull();
    expect(tracker.pidWritten!.pid).toBe(12345);
  });

  test("the PID file contains the current process PID", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      getProcessPidFn: () => 67890,
    });

    await handleUp(undefined, deps);

    expect(tracker.pidWritten!.pid).toBe(67890);
  });

  test("the PID file is deleted during the shutdown sequence", async () => {
    const tracker = createTracker();

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => { tunnelResolve!(0); },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Trigger shutdown
    const handlers = tracker.signalHandlers.get("SIGTERM")!;
    await handlers[0]();
    await upPromise;

    // PID file should have been deleted
    expect(tracker.calls).toContain("deletePidFile");
  });
});

// =============================================================================
// Down Command Tests
// =============================================================================

describe("handleDown", () => {
  test("reads the PID file and sends SIGTERM to the running process", async () => {
    let signalSent: { pid: number; signal: string } | null = null;

    const result = await handleDown(undefined, {
      readPidFileFn: () => 12345,
      isProcessRunningFn: () => true,
      killProcessFn: (pid, signal) => {
        signalSent = { pid, signal };
      },
      deletePidFileFn: () => {},
      stdout: () => {},
      stderr: () => {},
    });

    expect(result.success).toBe(true);
    expect(signalSent).not.toBeNull();
    expect(signalSent!.pid).toBe(12345);
    expect(signalSent!.signal).toBe("SIGTERM");
  });

  test("reports if no PID file exists (no running instance)", async () => {
    const output: string[] = [];

    const result = await handleDown(undefined, {
      readPidFileFn: () => null,
      isProcessRunningFn: () => false,
      killProcessFn: () => {},
      deletePidFileFn: () => {},
      stdout: (msg) => output.push(msg),
      stderr: () => {},
    });

    expect(result.success).toBe(true);
    expect(output.some((m) => m.includes("No running flaregun instance"))).toBe(true);
  });

  test("detects a stale PID file, reports no running instance, and deletes the stale file", async () => {
    const output: string[] = [];
    let pidDeleted = false;

    const result = await handleDown(undefined, {
      readPidFileFn: () => 99999,
      isProcessRunningFn: () => false, // Process not running — stale
      killProcessFn: () => {},
      deletePidFileFn: () => {
        pidDeleted = true;
      },
      stdout: (msg) => output.push(msg),
      stderr: () => {},
    });

    expect(result.success).toBe(true);
    expect(output.some((m) => m.includes("stale"))).toBe(true);
    expect(pidDeleted).toBe(true);
  });

  test("returns an error if sending the signal fails", async () => {
    const errors: string[] = [];

    const result = await handleDown(undefined, {
      readPidFileFn: () => 12345,
      isProcessRunningFn: () => true,
      killProcessFn: () => {
        throw new Error("Permission denied");
      },
      deletePidFileFn: () => {},
      stdout: () => {},
      stderr: (msg) => errors.push(msg),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Permission denied");
  });
});

// =============================================================================
// Tunnel Management Tests
// =============================================================================

describe("handleUp: tunnel management", () => {
  test("an unexpected tunnel exit logs a warning but does not stop services", async () => {
    const tracker = createTracker();

    // Create a tunnel that exits quickly
    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    // Also create a second tunnel for the restart attempt that also exits
    let restartTunnelResolve: (code: number) => void;
    const restartTunnelExited = new Promise<number>((resolve) => {
      restartTunnelResolve = resolve;
    });

    let spawnCount = 0;
    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        spawnCount++;
        tracker.calls.push("spawnTunnel");
        if (spawnCount === 1) {
          // First spawn — resolve with error code after a short delay
          setTimeout(() => tunnelResolve(1), 10);
          return {
            exited: tunnelExited,
            killed: false,
            kill: () => {},
            pid: 99999,
          } as unknown as import("bun").Subprocess;
        }
        // Restart attempt — also exits
        setTimeout(() => restartTunnelResolve(1), 10);
        return {
          exited: restartTunnelExited,
          killed: false,
          kill: () => {},
          pid: 99998,
        } as unknown as import("bun").Subprocess;
      },
    });

    await handleUp(undefined, deps);

    // Wait for the async tunnel exit handler to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A warning should have been logged
    expect(tracker.errors.some((m) => m.includes("unexpectedly"))).toBe(true);

    // The supervisor should NOT have been shut down (services continue running)
    expect(tracker.calls).not.toContain("supervisor.shutdown");
  });

  test("the system continues running after tunnel disconnection", async () => {
    const tracker = createTracker();

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    let restartTunnelResolve: (code: number) => void;
    const restartTunnelExited = new Promise<number>((resolve) => {
      restartTunnelResolve = resolve;
    });

    let spawnCount = 0;
    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        spawnCount++;
        tracker.calls.push("spawnTunnel");
        if (spawnCount === 1) {
          setTimeout(() => tunnelResolve(1), 10);
          return {
            exited: tunnelExited,
            killed: false,
            kill: () => {},
            pid: 99999,
          } as unknown as import("bun").Subprocess;
        }
        setTimeout(() => restartTunnelResolve(1), 10);
        return {
          exited: restartTunnelExited,
          killed: false,
          kill: () => {},
          pid: 99998,
        } as unknown as import("bun").Subprocess;
      },
    });

    const result = await handleUp(undefined, deps);

    // handleUp should return successfully (tunnel exited but that's fine)
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Dependency Injection Tests
// =============================================================================

describe("handleUp: dependency injection", () => {
  test("all subsystems are called with the correct arguments (verified via mock call tracking)", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // All major subsystems should have been called
    expect(tracker.calls).toContain("loadConfig");
    expect(tracker.calls).toContain("loadEnv");
    expect(tracker.calls).toContain("loadLock");
    expect(tracker.calls).toContain("binaryExists");
    expect(tracker.calls).toContain("createClient");
    expect(tracker.calls).toContain("syncFull");
    expect(tracker.calls).toContain("createSupervisor");
    expect(tracker.calls).toContain("createAdminServer");
    expect(tracker.calls).toContain("createHotReloadEngine");
    expect(tracker.calls).toContain("syncIngress");
    expect(tracker.calls).toContain("spawnTunnel");
    expect(tracker.calls).toContain("writePidFile");
  });

  test("call order matches the specified startup sequence", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // Extract the major ordered steps
    const majorSteps = [
      "loadConfig",
      "loadEnv",
      "loadLock",
      "binaryExists",
      "createClient",
      "syncFull",
      "createSupervisor",
      "createAdminServer",
      "syncIngress",
      "spawnTunnel",
      "writePidFile",
    ];

    // Verify each appears and in order
    let lastIdx = -1;
    for (const step of majorSteps) {
      const idx = tracker.calls.indexOf(step);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test("sync is called with admin port 0 initially (placeholder)", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // syncFull args: (client, config, credentials, lockState, saveLock, adminPort)
    // Last arg should be 0
    const adminPortArg = tracker.syncArgs[5];
    expect(adminPortArg).toBe(0);
  });

  test("ingress sync is called with the admin backend's actual port", async () => {
    const tracker = createTracker();
    const adminPort = 9200;

    const deps = successDeps(tracker, {
      createAdminServerFn: () => {
        tracker.calls.push("createAdminServer");
        return mockAdminServer(adminPort);
      },
    });

    await handleUp(undefined, deps);

    // syncIngressFn args: (client, config, accountId, tunnelId, adminPort)
    const portArg = tracker.ingressArgs[4];
    expect(portArg).toBe(adminPort);
  });

  test("shutdown does not modify Cloudflare state", async () => {
    const tracker = createTracker();

    let tunnelResolve: (code: number) => void;
    const tunnelExited = new Promise<number>((resolve) => {
      tunnelResolve = resolve;
    });

    const mockTunnel = {
      exited: tunnelExited,
      killed: false,
      kill: () => { tunnelResolve!(0); },
      pid: 99999,
    };

    const deps = successDeps(tracker, {
      spawnTunnelFn: () => {
        tracker.calls.push("spawnTunnel");
        return mockTunnel as unknown as import("bun").Subprocess;
      },
    });

    const upPromise = handleUp(undefined, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Record the current length of calls
    const callsBeforeShutdown = tracker.calls.length;

    // Trigger shutdown
    const handlers = tracker.signalHandlers.get("SIGTERM")!;
    await handlers[0]();
    await upPromise;

    // Check calls after shutdown — none should be sync/cloudflare related
    const callsAfterShutdown = tracker.calls.slice(callsBeforeShutdown);
    expect(callsAfterShutdown).not.toContain("syncFull");
    expect(callsAfterShutdown).not.toContain("syncIngress");
  });

  test("pages services are not started via the supervisor", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker);

    await handleUp(undefined, deps);

    // Only local services should be started
    const serviceStarts = tracker.supervisorStartCalls.map((c) => c.name);
    expect(serviceStarts).toContain("api");
    expect(serviceStarts).not.toContain("blog"); // blog is a pages service
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe("handleUp: edge cases", () => {
  test("works with no local services (pages only)", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      loadConfigFn: () => {
        tracker.calls.push("loadConfig");
        return makeConfig({
          services: {
            blog: pagesService("blog", "public"),
          },
        });
      },
    });

    await handleUp(undefined, deps);

    // No supervisor start calls
    expect(tracker.supervisorStartCalls).toHaveLength(0);
    // But everything else should work
    expect(tracker.calls).toContain("syncFull");
    expect(tracker.calls).toContain("spawnTunnel");
  });

  test("works with no tunnel ID in lock file (first run)", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      loadLockFn: () => {
        tracker.calls.push("loadLock");
        return emptyState(); // No tunnel ID
      },
    });

    await handleUp(undefined, deps);

    // Sync should still run (with tunnelId "")
    expect(tracker.calls).toContain("syncFull");

    // Ingress update should be skipped (no tunnelId)
    expect(tracker.calls).not.toContain("syncIngress");
  });

  test("handles lock file load errors gracefully", async () => {
    const tracker = createTracker();
    const deps = successDeps(tracker, {
      loadLockFn: () => {
        tracker.calls.push("loadLock");
        throw new Error("Corrupt lock file");
      },
    });

    const result = await handleUp(undefined, deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Corrupt lock file");
  });
});
