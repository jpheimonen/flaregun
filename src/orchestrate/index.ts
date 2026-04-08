/**
 * Orchestrator: `flaregun up` and `flaregun down` command handlers.
 *
 * The orchestrator ties together nearly every component into a cohesive runtime.
 * `flaregun up` is the primary way users run flaregun: it validates config,
 * syncs Cloudflare state, starts the admin UI, starts local services, runs the
 * tunnel, and blocks until shutdown.
 *
 * `flaregun down` performs a graceful shutdown by signaling the running `up` process.
 *
 * All subsystem dependencies are injectable for testability, following the UpDeps
 * pattern from the personal-homepage project.
 */

import { resolve, dirname } from "path";
import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from "fs";
import { spawn, type Subprocess } from "bun";

import type { CloudflareClient } from "../cloudflare/index.js";
import { createClient } from "../cloudflare/index.js";
import { loadConfig, type FlaregunConfig } from "../config/index.js";
import type { CloudflareCredentials } from "../env/index.js";
import { loadAndValidateEnv } from "../env/index.js";
import { loadLockFile, saveLockFile, type LockState } from "../lock/index.js";
import { binaryExists } from "../process/index.js";
import { Supervisor, type SupervisedServiceConfig } from "../process/supervisor.js";
import { AdminServer } from "../admin/server.js";
import type { AdminServerDeps, PagesServiceInfo } from "../admin/types.js";
import { syncFull } from "../sync/index.js";
import type { SyncCredentials, SaveLockFn } from "../sync/index.js";
import { syncTunnelIngress } from "../sync/ingress.js";
import { createHotReloadEngine } from "../sync/hot-reload.js";

// --- Types ---

/** Result returned by handleUp and handleDown */
export interface CommandResult {
  success: boolean;
  error?: string;
}

/** Dependencies injectable into the up command handler for testability */
export interface UpCommandDeps {
  /** Config loader — defaults to loadConfig */
  loadConfigFn?: (configPath?: string) => FlaregunConfig;
  /** Environment loader — defaults to loadAndValidateEnv */
  loadEnvFn?: (configPath: string, context: "up") => CloudflareCredentials;
  /** Lock file loader — defaults to loadLockFile */
  loadLockFn?: (path: string) => LockState;
  /** Lock file saver — defaults to saveLockFile */
  saveLockFn?: (path: string, state: LockState) => void;
  /** Client factory — defaults to createClient */
  createClientFn?: (credentials: CloudflareCredentials) => CloudflareClient;
  /** Binary existence checker — defaults to binaryExists */
  binaryExistsFn?: (name: string) => Promise<boolean>;
  /** Full sync engine — defaults to syncFull */
  syncFn?: typeof syncFull;
  /** Tunnel ingress sync — defaults to syncTunnelIngress (from ingress module) */
  syncIngressFn?: (
    client: CloudflareClient,
    config: FlaregunConfig,
    accountId: string,
    tunnelId: string,
    adminPort: number,
  ) => Promise<void>;
  /** Supervisor factory — defaults to creating a new Supervisor() */
  createSupervisorFn?: () => Supervisor;
  /** Admin server factory — defaults to creating new AdminServer(deps) */
  createAdminServerFn?: (deps: AdminServerDeps) => AdminServer;
  /** Hot-reload engine factory — defaults to createHotReloadEngine */
  createHotReloadEngineFn?: typeof createHotReloadEngine;
  /** Tunnel spawner — defaults to spawning cloudflared */
  spawnTunnelFn?: (token: string) => Subprocess;
  /** PID file writer — defaults to atomic write */
  writePidFileFn?: (pidPath: string, pid: number) => void;
  /** PID file deleter — defaults to deletePidFile */
  deletePidFileFn?: (pidPath: string) => void;
  /** Register signal handler — defaults to process.on */
  onSignalFn?: (signal: string, handler: () => void) => void;
  /** Exit the process — defaults to process.exit */
  exitFn?: (code: number) => void;
  /** Get current process PID — defaults to process.pid */
  getProcessPidFn?: () => number;
  /** Output function for normal messages — defaults to console.log */
  stdout?: (msg: string) => void;
  /** Output function for error messages — defaults to console.error */
  stderr?: (msg: string) => void;
  /** Path to the pre-built SPA directory for the admin UI */
  spaDir?: string;
}

/** Dependencies injectable into the down command handler for testability */
export interface DownCommandDeps {
  /** PID file reader — defaults to readPidFile */
  readPidFileFn?: (pidPath: string) => number | null;
  /** PID file deleter — defaults to deletePidFile */
  deletePidFileFn?: (pidPath: string) => void;
  /** Check if process is running — defaults to isProcessRunning */
  isProcessRunningFn?: (pid: number) => boolean;
  /** Process signal sender — defaults to process.kill */
  killProcessFn?: (pid: number, signal: string) => void;
  /** Output function for normal messages — defaults to console.log */
  stdout?: (msg: string) => void;
  /** Output function for error messages — defaults to console.error */
  stderr?: (msg: string) => void;
}

// --- PID File Management ---

/**
 * Writes a PID file atomically (write to temp file, then rename).
 * This prevents `down` from reading a partially written file.
 */
export function writePidFile(pidPath: string, pid: number): void {
  const tmpPath = `${pidPath}.tmp.${Date.now()}`;
  writeFileSync(tmpPath, String(pid), "utf-8");
  renameSync(tmpPath, pidPath);
}

/**
 * Reads the PID from a PID file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) {
    return null;
  }
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

/**
 * Deletes the PID file if it exists.
 */
export function deletePidFile(pidPath: string): void {
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Best effort — ignore errors (file already deleted, permissions, etc.)
  }
}

/**
 * Checks if a process with the given PID is still running.
 * Uses the `kill(pid, 0)` trick — sends no signal but checks existence.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Tunnel Management ---

/**
 * Default tunnel spawner: runs `cloudflared tunnel run --token <token>`.
 */
function defaultSpawnTunnel(token: string): Subprocess {
  return spawn(["cloudflared", "tunnel", "run", "--token", token], {
    stdout: "inherit",
    stderr: "inherit",
  });
}

// --- Startup Summary ---

/**
 * Formats and prints the startup summary.
 */
function printStartupSummary(
  config: FlaregunConfig,
  supervisor: Supervisor,
  adminPort: number,
  stdout: (msg: string) => void,
): void {
  stdout("\n========================================");
  stdout("  Flaregun — Up Summary");
  stdout("========================================\n");

  const states = supervisor.getAllServiceStates();

  // Local services
  const localServices = Object.entries(config.services).filter(
    ([, s]) => s.type === "local",
  );
  if (localServices.length > 0) {
    stdout("  Local services:");
    for (const [name, service] of localServices) {
      const info = states.get(name);
      const state = info?.state ?? "unknown";
      const url = `https://${service.subdomain}.${config.domain}`;
      stdout(`    ${state === "running" ? "✓" : "○"} ${name} [${state}] — ${url}`);
    }
  }

  // Pages services
  const pagesServices = Object.entries(config.services).filter(
    ([, s]) => s.type === "pages",
  );
  if (pagesServices.length > 0) {
    stdout("\n  Pages services:");
    for (const [name, service] of pagesServices) {
      const url = `https://${service.subdomain}.${config.domain}`;
      stdout(`    ○ ${name} [deployed via Pages] — ${url}`);
    }
  }

  stdout(`\n  Admin UI: https://admin.${config.domain}`);
  stdout(`    (local: http://localhost:${adminPort})`);
  stdout("\n  Cloudflare Tunnel: active");
  stdout("========================================\n");
}

// --- Up Command Handler ---

/**
 * Handles the `flaregun up` command.
 *
 * Startup sequence:
 * 1. Load and validate config
 * 2. Load environment variables
 * 3. Load lock file
 * 4. Check prerequisites (cloudflared binary)
 * 5. Initialize SDK client
 * 6. Run full sync (without admin port)
 * 7. Start admin UI backend
 * 8. Start local services via supervisor
 * 9. Update tunnel ingress with admin port
 * 10. Start cloudflared tunnel
 * 11. Print startup summary
 * 12. Write PID file
 * 13. Block on tunnel process
 */
export async function handleUp(
  configPath?: string,
  deps: UpCommandDeps = {},
): Promise<CommandResult> {
  const {
    loadConfigFn = loadConfig,
    loadEnvFn = loadAndValidateEnv,
    loadLockFn = loadLockFile,
    saveLockFn: saveLockFileFn = saveLockFile,
    createClientFn = createClient,
    binaryExistsFn = binaryExists,
    syncFn = syncFull,
    syncIngressFn = syncTunnelIngress,
    createSupervisorFn = () => new Supervisor(),
    createAdminServerFn = (adminDeps: AdminServerDeps) => new AdminServer(adminDeps),
    createHotReloadEngineFn = createHotReloadEngine,
    spawnTunnelFn = defaultSpawnTunnel,
    writePidFileFn = writePidFile,
    deletePidFileFn = deletePidFile,
    onSignalFn = (signal: string, handler: () => void) => {
      process.on(signal, handler);
    },
    exitFn = (code: number) => process.exit(code),
    getProcessPidFn = () => process.pid,
    stdout = console.log,
    stderr = console.error,
    spaDir = resolve(import.meta.dir, "../../admin-ui/dist"),
  } = deps;

  // --- Step 1: Load and validate config ---
  let config: FlaregunConfig;
  try {
    config = loadConfigFn(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Config error: ${msg}`);
    return { success: false, error: msg };
  }

  // Resolve paths relative to the config file
  const resolvedConfigPath = configPath ?? resolve(process.cwd(), "flaregun.yml");
  const configDir = dirname(resolvedConfigPath);
  const lockPath = resolve(configDir, "flaregun.lock");
  const pidPath = resolve(configDir, ".flaregun.pid");

  // --- Step 2: Load and validate environment ---
  let credentials: CloudflareCredentials;
  try {
    credentials = loadEnvFn(resolvedConfigPath, "up");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Environment error: ${msg}`);
    return { success: false, error: msg };
  }

  // --- Step 3: Load lock file ---
  let lockState: LockState;
  try {
    lockState = loadLockFn(lockPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Lock file error: ${msg}`);
    return { success: false, error: msg };
  }

  // --- Step 4: Check prerequisites ---
  const hasCloudflared = await binaryExistsFn("cloudflared");
  if (!hasCloudflared) {
    const msg =
      "cloudflared is not installed or not found on PATH.\n" +
      "Install it from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
    stderr(msg);
    return { success: false, error: msg };
  }

  // --- Step 5: Initialize SDK client ---
  const client = createClientFn(credentials);

  // Build sync credentials
  const tunnelId = lockState.tunnel?.id ?? "";
  const syncCredentials: SyncCredentials = {
    accountId: credentials.accountId,
    zoneId: credentials.zoneId,
    tunnelId,
  };

  const saveLock: SaveLockFn = (state: LockState) => {
    saveLockFileFn(lockPath, state);
  };

  // --- Step 6: Run full sync (without admin port — admin not started yet) ---
  // Use a placeholder port of 0; the admin ingress will be updated in step 9.
  stdout("Syncing Cloudflare state...");
  try {
    const syncResult = await syncFn(
      client,
      config,
      syncCredentials,
      lockState,
      saveLock,
      0, // Placeholder — admin port not yet known
    );

    // Check for critical sync failures
    const criticalFailure = syncResult.steps.find(
      (s) =>
        !s.success &&
        s.step !== "redirect-rules" &&
        !(s.step === "tunnel-ingress" && !tunnelId) &&
        !(s.step === "dns-records" && !tunnelId),
    );
    if (criticalFailure) {
      const msg = `Sync failed at step "${criticalFailure.step}": ${criticalFailure.error}`;
      stderr(msg);
      return { success: false, error: msg };
    }
    stdout("✓ Sync complete");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Sync error: ${msg}`);
    return { success: false, error: msg };
  }

  // --- Step 7: Start admin UI backend ---
  const supervisor = createSupervisorFn();

  // Build Pages service info for the admin UI
  const pagesServices: PagesServiceInfo[] = Object.entries(config.services)
    .filter(([, s]) => s.type === "pages")
    .map(([name, s]) => ({
      name,
      subdomain: s.subdomain,
      deployed: !!lockState.pages[name],
    }));

  // Create hot-reload engine
  const hotReloadEngine = createHotReloadEngineFn({
    credentials: syncCredentials,
    saveLock,
    adminPort: 0, // Will be updated after admin starts
  });

  const adminServerDeps: AdminServerDeps = {
    supervisor,
    hotReloadEngine,
    cloudflareClient: client,
    lockState,
    configPath: resolvedConfigPath,
    spaDir,
    pagesServices,
  };

  const adminServer = createAdminServerFn(adminServerDeps);
  let adminPort: number;

  stdout("Starting admin UI backend...");
  try {
    adminPort = await adminServer.start();
    stdout(`✓ Admin UI backend listening on port ${adminPort}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Failed to start admin backend: ${msg}`);
    return { success: false, error: msg };
  }

  // --- Step 8: Start local services via the process supervisor ---
  const localServices = Object.entries(config.services).filter(
    ([, s]) => s.type === "local",
  );

  stdout("Starting local services...");
  for (const [name, service] of localServices) {
    const svcConfig: SupervisedServiceConfig = {
      name,
      command: service.command!,
      maxRetries: service.max_retries,
    };
    try {
      await supervisor.startService(svcConfig);
      stdout(`  ✓ ${name} started`);
    } catch (err) {
      // Services that fail enter the supervisor's normal crash → backoff → retry cycle
      stdout(
        `  ○ ${name} failed to start initially (supervisor will retry): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Step 9: Update tunnel ingress with admin port ---
  if (tunnelId) {
    stdout("Updating tunnel ingress with admin port...");
    try {
      await syncIngressFn(
        client,
        config,
        credentials.accountId,
        tunnelId,
        adminPort,
      );
      stdout("✓ Tunnel ingress updated");
    } catch (err) {
      // Non-fatal — tunnel will still work for services, just admin may not be routed correctly
      stderr(
        `Warning: Failed to update tunnel ingress with admin port: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Step 10: Start cloudflared tunnel ---
  stdout("Starting cloudflared tunnel...");
  const tunnelToken = credentials.tunnelToken!;
  let tunnelProc: Subprocess;
  try {
    tunnelProc = spawnTunnelFn(tunnelToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Failed to start tunnel: ${msg}`);
    // Shut down what we've started
    await supervisor.shutdown();
    adminServer.stop();
    return { success: false, error: msg };
  }

  // --- Step 11: Print startup summary ---
  printStartupSummary(config, supervisor, adminPort, stdout);

  // --- Step 12: Write PID file ---
  try {
    writePidFileFn(pidPath, getProcessPidFn());
  } catch (err) {
    stderr(
      `Warning: Failed to write PID file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Signal handling ---
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) {
      stdout("Force exiting...");
      exitFn(1);
      return;
    }
    isShuttingDown = true;
    stdout("Shutting down...");

    // 1. Stop the cloudflared tunnel first
    try {
      tunnelProc.kill();
    } catch {
      // Tunnel may already be dead
    }

    // 2. Stop all local services via the supervisor
    try {
      await supervisor.shutdown();
    } catch {
      // Best effort
    }

    // 3. Stop the admin UI backend
    try {
      adminServer.stop();
    } catch {
      // Best effort
    }

    // 4. Delete PID file
    try {
      deletePidFileFn(pidPath);
    } catch {
      // Best effort
    }

    // 5. Exit
    exitFn(0);
  };

  onSignalFn("SIGINT", shutdown);
  onSignalFn("SIGTERM", shutdown);

  // --- Monitor tunnel for unexpected exit ---
  tunnelProc.exited.then((code) => {
    if (!isShuttingDown) {
      stderr(
        `Warning: Tunnel process exited unexpectedly with code ${code}. ` +
          `Services continue running locally but are not accessible from the internet.`,
      );
      // Optionally attempt a single restart
      try {
        const restartedTunnel = spawnTunnelFn(tunnelToken);
        stdout("Attempting tunnel restart...");
        restartedTunnel.exited.then((restartCode) => {
          if (!isShuttingDown) {
            stderr(
              `Tunnel restart also exited with code ${restartCode}. Running without tunnel.`,
            );
          }
        });
      } catch {
        stderr("Failed to restart tunnel. Running without tunnel.");
      }
    }
  });

  // --- Step 13: Block on tunnel process ---
  // We block by waiting on the tunnel's exit promise.
  // The process will remain here until the tunnel exits or a signal is received.
  await tunnelProc.exited;

  // If we reach here without shutting down, the tunnel exited on its own.
  // The exit handler above already logged a warning. We keep running
  // so services remain accessible locally.
  // In practice, the signal handler or a second tunnel exit will end the process.

  return { success: true };
}

// --- Down Command Handler ---

/**
 * Handles the `flaregun down` command.
 *
 * Reads the PID file, checks if the process is running, and sends SIGTERM.
 * Handles stale PID files (process not running).
 * Does NOT modify Cloudflare state.
 */
export async function handleDown(
  configPath?: string,
  deps: DownCommandDeps = {},
): Promise<CommandResult> {
  const {
    readPidFileFn = readPidFile,
    deletePidFileFn = deletePidFile,
    isProcessRunningFn = isProcessRunning,
    killProcessFn = (pid: number, signal: string) => {
      process.kill(pid, signal as NodeJS.Signals);
    },
    stdout = console.log,
    stderr = console.error,
  } = deps;

  // Resolve PID file path
  const resolvedConfigPath = configPath ?? resolve(process.cwd(), "flaregun.yml");
  const configDir = dirname(resolvedConfigPath);
  const pidPath = resolve(configDir, ".flaregun.pid");

  // Read PID file
  const pid = readPidFileFn(pidPath);

  if (pid === null) {
    stdout("No running flaregun instance found (no PID file).");
    return { success: true };
  }

  // Check if process is still running
  if (!isProcessRunningFn(pid)) {
    stdout("No running flaregun instance found (stale PID file). Cleaning up.");
    deletePidFileFn(pidPath);
    return { success: true };
  }

  // Send SIGTERM to trigger the up process's shutdown sequence
  try {
    killProcessFn(pid, "SIGTERM");
    stdout(`Sent shutdown signal to flaregun (PID ${pid}).`);
    return { success: true };
  } catch (err) {
    const msg = `Failed to signal process ${pid}: ${err instanceof Error ? err.message : String(err)}`;
    stderr(msg);
    return { success: false, error: msg };
  }
}
