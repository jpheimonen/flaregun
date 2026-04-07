import { spawn, type Subprocess } from "bun";

// --- Types ---

/** Lifecycle states for a supervised service */
export type ServiceState =
  | "starting"
  | "running"
  | "crashed"
  | "restarting"
  | "stopped";

/** A single log entry captured from a child process */
export interface LogEntry {
  timestamp: Date;
  source: "stdout" | "stderr";
  line: string;
  service: string;
}

/** Callback type for log subscribers */
export type LogSubscriber = (entry: LogEntry) => void;

/** Per-service runtime state tracked by the supervisor */
export interface ServiceInfo {
  state: ServiceState;
  /** Time of last transition to "running" */
  runningSince: Date | null;
  /** Number of restarts since the supervisor started managing this service */
  restartCount: number;
  /** Exit code or error message from the most recent crash */
  lastCrashReason: string | null;
}

/** Configuration for a service to be supervised */
export interface SupervisedServiceConfig {
  name: string;
  command: string;
  /** Maximum number of automatic restarts. undefined = infinite */
  maxRetries?: number;
}

/** Injectable timing constants for the supervisor */
export interface SupervisorTimingConfig {
  /** Duration (ms) to wait after spawn before considering a process stable. Default: 500 */
  stabilityWindowMs: number;
  /** Duration (ms) a service must remain running before backoff resets. Default: 30000 */
  backoffResetMs: number;
  /** Graceful shutdown timeout (ms) before force-killing. Default: 5000 */
  gracefulShutdownMs: number;
  /** Initial backoff delay (ms) after first crash. Default: 1000 */
  initialBackoffMs: number;
  /** Maximum backoff delay (ms). Default: 30000 */
  maxBackoffMs: number;
  /** Rolling log buffer max entries per service. Default: 1000 */
  logBufferSize: number;
}

const DEFAULT_TIMING: SupervisorTimingConfig = {
  stabilityWindowMs: 500,
  backoffResetMs: 30000,
  gracefulShutdownMs: 5000,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  logBufferSize: 1000,
};

// --- Rolling Log Buffer ---

export class RollingLogBuffer {
  private entries: LogEntry[];
  private head: number = 0;
  private count: number = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.entries = new Array(capacity);
  }

  /** Append a log entry to the buffer. Evicts oldest if full. */
  push(entry: LogEntry): void {
    const idx = (this.head + this.count) % this.capacity;
    this.entries[idx] = entry;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      // Buffer full — advance head (evict oldest)
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Return all entries in order (oldest first). */
  getAll(): LogEntry[] {
    const result: LogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.entries[(this.head + i) % this.capacity]);
    }
    return result;
  }

  /** Current number of entries in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Clear all entries. */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

// --- Internal per-service state ---

interface ManagedService {
  config: SupervisedServiceConfig;
  state: ServiceState;
  proc: Subprocess | null;
  /** Monotonically increasing generation counter to detect stale exit handlers */
  generation: number;
  runningSince: Date | null;
  restartCount: number;
  consecutiveCrashes: number;
  lastCrashReason: string | null;
  logBuffer: RollingLogBuffer;
  subscribers: Set<LogSubscriber>;
  /** Timer for the backoff delay before restart */
  backoffTimer: ReturnType<typeof setTimeout> | null;
  /** Timer for the backoff reset after sustained running */
  backoffResetTimer: ReturnType<typeof setTimeout> | null;
  /** Timer for the stability window */
  stabilityTimer: ReturnType<typeof setTimeout> | null;
}

// --- Supervisor ---

export class Supervisor {
  private services: Map<string, ManagedService> = new Map();
  private globalSubscribers: Set<LogSubscriber> = new Set();
  private timing: SupervisorTimingConfig;
  private shuttingDown: boolean = false;

  constructor(timing?: Partial<SupervisorTimingConfig>) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  // --- Service Management API ---

  /**
   * Start supervising a service. Spawns the process and enters the state machine.
   * If the service is already managed and not stopped, this is a no-op.
   */
  async startService(config: SupervisedServiceConfig): Promise<void> {
    const existing = this.services.get(config.name);
    if (existing && existing.state !== "stopped") {
      return; // Already running or in lifecycle
    }

    const svc: ManagedService = existing ?? {
      config,
      state: "stopped" as ServiceState,
      proc: null,
      generation: 0,
      runningSince: null,
      restartCount: 0,
      consecutiveCrashes: 0,
      lastCrashReason: null,
      logBuffer: new RollingLogBuffer(this.timing.logBufferSize),
      subscribers: new Set(),
      backoffTimer: null,
      backoffResetTimer: null,
      stabilityTimer: null,
    };

    // Update config in case it changed
    svc.config = config;

    // Reset lifecycle counters — starting a stopped service is a fresh supervision session
    svc.restartCount = 0;
    svc.consecutiveCrashes = 0;
    svc.lastCrashReason = null;

    this.services.set(config.name, svc);
    await this.spawnProcess(svc);
  }

  /**
   * Stop a supervised service. Sends SIGTERM, waits for graceful exit,
   * then force-kills if needed. Transitions to stopped.
   */
  async stopService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) return;

    if (svc.state === "stopped") return;

    // Cancel any pending timers
    this.clearTimers(svc);

    // Increment generation to invalidate any pending exit handlers
    svc.generation++;

    // Grab the process reference before nulling it
    const proc = svc.proc;
    svc.proc = null;

    this.transitionTo(svc, "stopped");

    if (proc && !proc.killed) {
      await this.terminateProcessHandle(proc);
    }
  }

  /**
   * Restart a supervised service. Stops the current process (if running)
   * and starts a new one. Resets restart count and backoff state.
   */
  async restartService(name: string): Promise<void> {
    const svc = this.services.get(name);
    if (!svc) return;

    // Stop current process if running
    this.clearTimers(svc);

    // Increment generation to invalidate any pending exit handlers
    svc.generation++;

    // Grab the process reference before nulling it
    const proc = svc.proc;
    svc.proc = null;

    if (proc && !proc.killed) {
      await this.terminateProcessHandle(proc);
    }

    // Reset counters
    svc.restartCount = 0;
    svc.consecutiveCrashes = 0;
    svc.lastCrashReason = null;

    // Spawn fresh
    await this.spawnProcess(svc);
  }

  /**
   * Get the current state info for a specific service.
   */
  getServiceState(name: string): ServiceInfo | null {
    const svc = this.services.get(name);
    if (!svc) return null;
    return {
      state: svc.state,
      runningSince: svc.runningSince,
      restartCount: svc.restartCount,
      lastCrashReason: svc.lastCrashReason,
    };
  }

  /**
   * Get states for all supervised services.
   */
  getAllServiceStates(): Map<string, ServiceInfo> {
    const result = new Map<string, ServiceInfo>();
    for (const [name, svc] of this.services) {
      result.set(name, {
        state: svc.state,
        runningSince: svc.runningSince,
        restartCount: svc.restartCount,
        lastCrashReason: svc.lastCrashReason,
      });
    }
    return result;
  }

  /**
   * Get the log buffer contents for a specific service.
   */
  getLogBuffer(name: string): LogEntry[] {
    const svc = this.services.get(name);
    if (!svc) return [];
    return svc.logBuffer.getAll();
  }

  /**
   * Subscribe to log events for a specific service.
   * Returns an unsubscribe function.
   */
  subscribeToLogs(name: string, callback: LogSubscriber): () => void {
    const svc = this.services.get(name);
    if (!svc) {
      // Return a no-op unsubscribe if service doesn't exist
      return () => {};
    }
    svc.subscribers.add(callback);
    return () => {
      svc.subscribers.delete(callback);
    };
  }

  /**
   * Subscribe to log events for ALL services.
   * Returns an unsubscribe function.
   */
  subscribeToAllLogs(callback: LogSubscriber): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  /**
   * Graceful shutdown: stop all services.
   * Sends SIGTERM to all processes, waits for graceful timeout, then force-kills.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Cancel all timers first to prevent restarts during shutdown
    for (const svc of this.services.values()) {
      this.clearTimers(svc);
      // Increment generation to invalidate exit handlers
      svc.generation++;
    }

    // Collect all processes that need termination
    const terminationPromises: Promise<void>[] = [];
    for (const svc of this.services.values()) {
      const proc = svc.proc;
      svc.proc = null;
      this.transitionTo(svc, "stopped");

      if (proc && !proc.killed) {
        terminationPromises.push(this.terminateProcessHandle(proc));
      }
    }

    // Wait for all terminations to complete
    await Promise.all(terminationPromises);

    this.shuttingDown = false;
  }

  /**
   * Check if the supervisor is currently shutting down.
   */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Get the list of managed service names.
   */
  get serviceNames(): string[] {
    return Array.from(this.services.keys());
  }

  // --- Internal Methods ---

  private async spawnProcess(svc: ManagedService): Promise<void> {
    this.transitionTo(svc, "starting");

    // Increment generation for this new spawn cycle
    const gen = ++svc.generation;

    try {
      // Spawn via shell to handle complex commands (quotes, pipes, etc.)
      const proc = spawn(["sh", "-c", svc.config.command], {
        stdout: "pipe",
        stderr: "pipe",
      });

      svc.proc = proc;

      // Start capturing stdout/stderr
      this.captureStream(svc, proc.stdout, "stdout");
      this.captureStream(svc, proc.stderr, "stderr");

      // Race stability window against process exit
      const raceResult = await Promise.race([
        proc.exited.then((code) => ({ type: "exited" as const, code })),
        new Promise<{ type: "stable" }>((resolve) => {
          svc.stabilityTimer = setTimeout(
            () => resolve({ type: "stable" }),
            this.timing.stabilityWindowMs,
          );
        }),
      ]);

      svc.stabilityTimer = null;

      // If generation changed, another operation (stop/restart) took over
      if (svc.generation !== gen) return;

      if (raceResult.type === "exited") {
        // Process exited during stability window — immediate crash
        const exitCode = raceResult.code;
        svc.lastCrashReason = `Process exited with code ${exitCode}`;
        svc.proc = null;
        this.transitionTo(svc, "crashed");
        this.handleCrash(svc);
        return;
      }

      // Process survived stability window — it's running
      this.transitionTo(svc, "running");
      svc.runningSince = new Date();

      // Start backoff reset timer: if the process runs for the sustained period,
      // reset the consecutive crash counter
      svc.backoffResetTimer = setTimeout(() => {
        if (svc.generation === gen) {
          svc.consecutiveCrashes = 0;
        }
        svc.backoffResetTimer = null;
      }, this.timing.backoffResetMs);

      // Monitor for unexpected exit
      proc.exited.then((code) => {
        // Only handle if this is still the same generation (not stopped/restarted)
        if (svc.generation === gen && svc.state === "running") {
          svc.lastCrashReason = `Process exited with code ${code}`;
          svc.proc = null;
          if (svc.backoffResetTimer) {
            clearTimeout(svc.backoffResetTimer);
            svc.backoffResetTimer = null;
          }
          this.transitionTo(svc, "crashed");
          this.handleCrash(svc);
        }
      });
    } catch (err) {
      if (svc.generation !== gen) return;
      svc.lastCrashReason = `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`;
      svc.proc = null;
      this.transitionTo(svc, "crashed");
      this.handleCrash(svc);
    }
  }

  private handleCrash(svc: ManagedService): void {
    if (this.shuttingDown) return;

    svc.consecutiveCrashes++;

    // Check max retries
    if (
      svc.config.maxRetries !== undefined &&
      svc.restartCount >= svc.config.maxRetries
    ) {
      this.transitionTo(svc, "stopped");
      return;
    }

    // Schedule restart with exponential backoff
    this.transitionTo(svc, "restarting");
    const delay = this.calculateBackoff(svc.consecutiveCrashes);

    svc.backoffTimer = setTimeout(() => {
      svc.backoffTimer = null;
      svc.restartCount++;
      this.spawnProcess(svc);
    }, delay);
  }

  private calculateBackoff(consecutiveCrashes: number): number {
    // Exponential backoff: initialBackoff * 2^(crashes-1), capped at maxBackoff
    const delay =
      this.timing.initialBackoffMs * Math.pow(2, consecutiveCrashes - 1);
    return Math.min(delay, this.timing.maxBackoffMs);
  }

  /**
   * Terminate a process handle. Sends SIGTERM, waits for graceful exit,
   * then force-kills if the timeout elapses.
   */
  private async terminateProcessHandle(proc: Subprocess): Promise<void> {
    if (proc.killed) return;

    // Send SIGTERM
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process might already be dead
      return;
    }

    // Race graceful timeout against process exit
    const result = await Promise.race([
      proc.exited.then(() => ({ type: "exited" as const })),
      new Promise<{ type: "timeout" }>((resolve) =>
        setTimeout(
          () => resolve({ type: "timeout" }),
          this.timing.gracefulShutdownMs,
        ),
      ),
    ]);

    if (result.type === "timeout") {
      // Force kill
      try {
        proc.kill("SIGKILL");
        // Wait for the process to actually die
        await proc.exited;
      } catch {
        // Already dead or can't be killed — that's fine
      }
    }
  }

  private captureStream(
    svc: ManagedService,
    stream: ReadableStream<Uint8Array> | null,
    source: "stdout" | "stderr",
  ): void {
    if (!stream) return;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = partial + decoder.decode(value, { stream: true });
          const lines = text.split("\n");

          // Last element is either empty (if text ended with \n) or a partial line
          partial = lines.pop() ?? "";

          for (const line of lines) {
            if (line.length === 0) continue;
            const entry: LogEntry = {
              timestamp: new Date(),
              source,
              line,
              service: svc.config.name,
            };
            svc.logBuffer.push(entry);
            this.notifySubscribers(svc, entry);
          }
        }

        // Flush any remaining partial line
        if (partial.length > 0) {
          const entry: LogEntry = {
            timestamp: new Date(),
            source,
            line: partial,
            service: svc.config.name,
          };
          svc.logBuffer.push(entry);
          this.notifySubscribers(svc, entry);
          partial = "";
        }
      } catch {
        // Stream closed or errored — normal during shutdown
      }
    };

    read();
  }

  private notifySubscribers(svc: ManagedService, entry: LogEntry): void {
    for (const cb of svc.subscribers) {
      try {
        cb(entry);
      } catch {
        // Subscriber errors don't affect the supervisor
      }
    }
    for (const cb of this.globalSubscribers) {
      try {
        cb(entry);
      } catch {
        // Subscriber errors don't affect the supervisor
      }
    }
  }

  private transitionTo(svc: ManagedService, newState: ServiceState): void {
    svc.state = newState;
    if (newState === "stopped" || newState === "crashed") {
      svc.runningSince = null;
    }
  }

  private clearTimers(svc: ManagedService): void {
    if (svc.backoffTimer) {
      clearTimeout(svc.backoffTimer);
      svc.backoffTimer = null;
    }
    if (svc.backoffResetTimer) {
      clearTimeout(svc.backoffResetTimer);
      svc.backoffResetTimer = null;
    }
    if (svc.stabilityTimer) {
      clearTimeout(svc.stabilityTimer);
      svc.stabilityTimer = null;
    }
  }
}
