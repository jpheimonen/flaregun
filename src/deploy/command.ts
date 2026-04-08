/**
 * Deploy command handler.
 *
 * Wires together config loading, environment validation, sync, and the
 * deploy pipeline. Invoked when the user runs `flaregun deploy`.
 *
 * Execution sequence:
 * 1. Load and validate config (flaregun.yml)
 * 2. Load and validate environment variables
 * 3. Load lock file (flaregun.lock)
 * 4. Check prerequisites (wrangler binary)
 * 5. Initialize Cloudflare SDK client
 * 6. Run full sync engine
 * 7. Run deploy pipeline
 * 8. Report results
 */

import { resolve, dirname } from "path";
import type { CloudflareClient } from "../cloudflare/index.js";
import { createClient } from "../cloudflare/index.js";
import { loadConfig, type FlaregunConfig } from "../config/index.js";
import type { CloudflareCredentials } from "../env/index.js";
import { loadAndValidateEnv } from "../env/index.js";
import { loadLockFile, saveLockFile, type LockState } from "../lock/index.js";
import type { CommandRunner } from "../process/index.js";
import { runCommand, binaryExists } from "../process/index.js";
import { syncFull, type SyncCredentials, type SaveLockFn } from "../sync/index.js";
import {
  deployPipeline,
  formatDeploySummary,
  type DeployPipelineResult,
} from "./pipeline.js";

// --- Types ---

/** Dependencies injectable into the deploy command handler for testability */
export interface DeployCommandDeps {
  /** Config loader — defaults to loadConfig */
  loadConfigFn?: (configPath?: string) => FlaregunConfig;
  /** Environment loader — defaults to loadAndValidateEnv */
  loadEnvFn?: (configPath: string, context: "deploy") => CloudflareCredentials;
  /** Lock file loader — defaults to loadLockFile */
  loadLockFn?: (path: string) => LockState;
  /** Lock file saver — defaults to saveLockFile */
  saveLockFn?: (path: string, state: LockState) => void;
  /** Client factory — defaults to createClient */
  createClientFn?: (credentials: CloudflareCredentials) => CloudflareClient;
  /** Binary existence checker — defaults to binaryExists */
  binaryExistsFn?: (name: string) => Promise<boolean>;
  /** Sync engine — defaults to syncFull */
  syncFn?: typeof syncFull;
  /** Deploy pipeline — defaults to deployPipeline */
  deployFn?: typeof deployPipeline;
  /** Command runner — defaults to runCommand */
  runner?: CommandRunner;
  /** Output function for normal messages — defaults to console.log */
  stdout?: (msg: string) => void;
  /** Output function for error messages — defaults to console.error */
  stderr?: (msg: string) => void;
}

/** Result of the deploy command */
export interface DeployCommandResult {
  success: boolean;
  pipelineResult?: DeployPipelineResult;
  error?: string;
}

// --- Deploy Command ---

/**
 * Handles the `flaregun deploy` command.
 *
 * @param filters - Optional service name arguments for filtering
 * @param configPath - Optional path to flaregun.yml (defaults to cwd)
 * @param deps - Injectable dependencies for testability
 * @returns Command result with success/failure and optional pipeline details
 */
export async function handleDeploy(
  filters: string[] = [],
  configPath?: string,
  deps: DeployCommandDeps = {},
): Promise<DeployCommandResult> {
  const {
    loadConfigFn = loadConfig,
    loadEnvFn = loadAndValidateEnv,
    loadLockFn = loadLockFile,
    saveLockFn: saveLockFileFn = saveLockFile,
    createClientFn = createClient,
    binaryExistsFn = binaryExists,
    syncFn = syncFull,
    deployFn = deployPipeline,
    runner = runCommand,
    stdout = console.log,
    stderr = console.error,
  } = deps;

  // Step 1: Load and validate config
  let config: FlaregunConfig;
  try {
    config = loadConfigFn(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Config error: ${msg}`);
    return { success: false, error: msg };
  }

  // Resolve the config file location for lock file and env file paths
  const resolvedConfigPath = configPath ?? resolve(process.cwd(), "flaregun.yml");
  const configDir = dirname(resolvedConfigPath);
  const lockPath = resolve(configDir, "flaregun.lock");

  // Step 2: Load and validate environment
  let credentials: CloudflareCredentials;
  try {
    credentials = loadEnvFn(resolvedConfigPath, "deploy");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Environment error: ${msg}`);
    return { success: false, error: msg };
  }

  // Step 3: Load lock file
  let lockState: LockState;
  try {
    lockState = loadLockFn(lockPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Lock file error: ${msg}`);
    return { success: false, error: msg };
  }

  // Step 4: Check prerequisites
  const hasWrangler = await binaryExistsFn("wrangler");
  if (!hasWrangler) {
    const msg =
      "wrangler is not installed or not found on PATH. Install it with: bun add -g wrangler";
    stderr(msg);
    return { success: false, error: msg };
  }

  // Step 5: Initialize SDK client
  const client = createClientFn(credentials);

  // Step 6: Run full sync
  // Build sync credentials — tunnelId may not exist yet (first deploy before flaregun up)
  const tunnelId = lockState.tunnel?.id ?? "";
  const syncCredentials: SyncCredentials = {
    accountId: credentials.accountId,
    zoneId: credentials.zoneId,
    tunnelId,
  };

  const saveLock: SaveLockFn = (state: LockState) => {
    saveLockFileFn(lockPath, state);
  };

  if (!tunnelId) {
    stdout(
      "Note: No tunnel ID found in lock file. Tunnel ingress will be configured on first `flaregun up`.",
    );
  }

  try {
    const syncResult = await syncFn(
      client,
      config,
      syncCredentials,
      lockState,
      saveLock,
      8787, // Default admin port
    );

    // Check if any critical sync step failed.
    // When no tunnel ID exists (first deploy before `flaregun up`), tunnel-ingress
    // and dns-records failures are expected and non-critical — those steps need a
    // tunnel to function.
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Sync error: ${msg}`);
    return { success: false, error: msg };
  }

  // Step 7: Run deploy pipeline
  const serviceFilter = filters.length > 0 ? filters : undefined;

  const pipelineResult = await deployFn(
    config,
    lockState,
    client,
    credentials.accountId,
    configDir,
    runner,
    serviceFilter,
  );

  // Save lock file after deploy (resources may have been provisioned)
  saveLock(lockState);

  // Step 8: Report results
  stdout(formatDeploySummary(pipelineResult));

  if (!pipelineResult.success) {
    stderr("Deploy completed with failures.");
  }

  return {
    success: pipelineResult.success,
    pipelineResult,
  };
}
