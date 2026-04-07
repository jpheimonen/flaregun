/**
 * Shared build-scaffold-copy function.
 *
 * Handles the build -> scaffold -> copy-functions sequence for a single
 * Pages service. Used by both the deploy pipeline (step 009) and the
 * standalone build command (step 010).
 */

import { existsSync } from "fs";
import { resolve } from "path";
import type { ServiceConfig } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import type { CommandRunner } from "../process/index.js";
import { scaffoldFunctions } from "./scaffold.js";
import { copyFunctionsToDistDir } from "./copy-functions.js";

// --- Types ---

/** Result of the build-scaffold-copy sequence for a single service */
export interface BuildResult {
  success: boolean;
  error?: string;
  /** Whether a build command was executed */
  built: boolean;
  /** Whether scaffolding was triggered */
  scaffolded: boolean;
  /** Whether functions were copied into dist */
  functionsCopied: boolean;
}

// --- Build-Scaffold-Copy ---

/**
 * Runs the build -> scaffold -> copy-functions sequence for a single
 * Pages service.
 *
 * 1. Runs the service's build command (if declared) via the command runner.
 *    Fails on non-zero exit.
 * 2. If the service declares cloud resources and no functions directory exists,
 *    invokes the scaffolder to create a starter functions directory.
 * 3. If a functions directory exists (pre-existing or just scaffolded), copies
 *    it into the service's dist/functions/ directory.
 *
 * @param serviceName - The service name key from the config
 * @param service - The service configuration
 * @param projectRoot - The root directory of the project (for resolving paths)
 * @param lockState - The current lock file state
 * @param runner - The command runner for executing build commands
 * @returns Result indicating success or failure with details
 */
export async function buildScaffoldCopy(
  serviceName: string,
  service: ServiceConfig,
  projectRoot: string,
  lockState: LockState,
  runner: CommandRunner,
): Promise<BuildResult> {
  const result: BuildResult = {
    success: true,
    built: false,
    scaffolded: false,
    functionsCopied: false,
  };

  // Step 1: Run build command (if declared)
  if (service.build) {
    const buildArgs = service.build.split(/\s+/);
    const buildResult = await runner(buildArgs, projectRoot);

    if (buildResult.exitCode !== 0) {
      return {
        success: false,
        error: `Build command failed for "${serviceName}": ${buildResult.stderr || buildResult.stdout || `exit code ${buildResult.exitCode}`}`,
        built: false,
        scaffolded: false,
        functionsCopied: false,
      };
    }
    result.built = true;
  }

  // Step 2: Scaffold functions (if service has cloud resources and no functions dir)
  const hasCloudResources = service.database || service.bucket || service.kv;
  const functionsPath = resolve(projectRoot, service.functions ?? "functions");

  if (hasCloudResources && !existsSync(functionsPath)) {
    scaffoldFunctions(service, projectRoot);
    result.scaffolded = true;
  }

  // Step 3: Copy functions into dist/functions/ (if functions dir exists)
  const resolvedFunctionsPath = resolve(
    projectRoot,
    service.functions ?? "functions",
  );

  if (existsSync(resolvedFunctionsPath)) {
    const distPath = resolve(projectRoot, service.dist ?? "dist/");
    copyFunctionsToDistDir(resolvedFunctionsPath, distPath);
    result.functionsCopied = true;
  }

  return result;
}
