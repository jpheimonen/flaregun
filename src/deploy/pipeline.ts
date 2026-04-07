/**
 * Deploy pipeline orchestrator.
 *
 * Manages the full deployment lifecycle for Pages services and the fallback
 * Worker. Ties together the build-scaffold-copy sequence, resource provisioner,
 * wrangler config generator, wrangler CLI invocation, and custom domain
 * attachment.
 *
 * Key design decisions:
 * - Service deploys run in parallel (they are independent)
 * - A failure in one service does not prevent others from deploying
 * - The fallback Worker deploys concurrently with service deploys
 * - All wrangler/build commands use injectable CommandRunner for testability
 * - The pipeline produces a per-service summary report
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig, ServiceConfig } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import { storeResource } from "../lock/index.js";
import type { CommandRunner } from "../process/index.js";
import { binaryExists } from "../process/index.js";
import { resourceName } from "../naming.js";
import { provisionResources } from "../sync/provision.js";
import { generatePagesConfig, generateFallbackWorkerConfig } from "./wrangler.js";
import { cleanupTmpDir, createTmpDir } from "./tmp.js";
import { buildScaffoldCopy } from "./build.js";
import { writeWorkerSource } from "../worker/generate.js";

// --- Types ---

/** Result of deploying a single Pages service */
export interface ServiceDeployResult {
  service: string;
  success: boolean;
  error?: string;
}

/** Result of deploying the fallback Worker */
export interface WorkerDeployResult {
  success: boolean;
  error?: string;
}

/** Summary line for a single deployment target */
export interface DeploySummaryEntry {
  name: string;
  type: "pages" | "worker";
  success: boolean;
  error?: string;
}

/** Result of the entire deploy pipeline */
export interface DeployPipelineResult {
  success: boolean;
  summary: DeploySummaryEntry[];
}

// --- Project-not-found detection ---

/** Checks whether a wrangler error indicates a missing Pages project. */
function isProjectNotFoundError(stdout: string, stderr: string): boolean {
  const output = stderr + stdout;
  return (
    output.includes("could not find") ||
    output.includes("not found") ||
    output.includes("does not exist")
  );
}

// --- Custom domain attachment ---

/** Type for the Pages project domains API methods */
interface PagesDomainsAPI {
  pages: {
    projects: {
      domains: {
        get: (params: {
          project_name: string;
          domain_name: string;
          account_id: string;
        }) => Promise<{ id?: string; domain?: string }>;
        create: (params: {
          project_name: string;
          account_id: string;
          body: { name: string };
        }) => Promise<{ id?: string; domain?: string }>;
      };
    };
  };
}

/**
 * Attaches a custom domain to a Pages project if not already attached.
 *
 * Checks the project's existing custom domains via the Cloudflare SDK.
 * If the domain is already present, skips. If not, adds it.
 */
async function attachCustomDomain(
  client: CloudflareClient,
  accountId: string,
  projectName: string,
  customDomain: string,
): Promise<void> {
  const typedClient = client as unknown as PagesDomainsAPI;

  try {
    // Check if domain is already attached
    await typedClient.pages.projects.domains.get({
      project_name: projectName,
      domain_name: customDomain,
      account_id: accountId,
    });
    // Domain exists — no action needed
    return;
  } catch {
    // Domain not found — proceed to create
  }

  await typedClient.pages.projects.domains.create({
    project_name: projectName,
    account_id: accountId,
    body: { name: customDomain },
  });
}

// --- Per-service deploy ---

/**
 * Deploys a single Pages service through the complete deployment sequence.
 *
 * Steps:
 * 1. Build -> scaffold -> copy functions (shared function)
 * 2. Provision cloud resources (D1/R2/KV)
 * 3. Generate wrangler.toml
 * 4. Run wrangler pages deploy (with project-not-found retry)
 * 5. Attach custom domain
 * 6. Cleanup temp files
 */
export async function deployService(
  serviceName: string,
  service: ServiceConfig,
  config: FlaregunConfig,
  lockState: LockState,
  client: CloudflareClient,
  accountId: string,
  projectRoot: string,
  runner: CommandRunner,
): Promise<ServiceDeployResult> {
  let tmpDir: string | undefined;

  try {
    // Step 1: Build -> scaffold -> copy functions
    const buildResult = await buildScaffoldCopy(
      serviceName,
      service,
      projectRoot,
      lockState,
      runner,
    );
    if (!buildResult.success) {
      return {
        service: serviceName,
        success: false,
        error: buildResult.error,
      };
    }

    // Step 2: Provision cloud resources
    await provisionResources(
      client,
      config,
      accountId,
      lockState,
      [serviceName],
    );

    // Step 3: Generate wrangler.toml
    const pagesConfig = generatePagesConfig(
      serviceName,
      service,
      config.domain,
      lockState,
    );
    tmpDir = pagesConfig.tmpDir;

    // Step 4: Deploy via wrangler
    const projectName = resourceName(config.domain, serviceName);
    const deployArgs = [
      "wrangler",
      "pages",
      "deploy",
      "--config",
      pagesConfig.configPath,
    ];

    const firstAttempt = await runner(deployArgs, projectRoot);

    if (firstAttempt.exitCode !== 0) {
      if (!isProjectNotFoundError(firstAttempt.stdout, firstAttempt.stderr)) {
        return {
          service: serviceName,
          success: false,
          error: `wrangler pages deploy failed: ${firstAttempt.stderr || firstAttempt.stdout}`,
        };
      }

      // Project doesn't exist — create and retry
      const createArgs = [
        "wrangler",
        "pages",
        "project",
        "create",
        projectName,
        "--production-branch",
        "main",
      ];
      const createResult = await runner(createArgs, projectRoot);
      if (createResult.exitCode !== 0) {
        return {
          service: serviceName,
          success: false,
          error: `Failed to create Pages project "${projectName}": ${createResult.stderr || createResult.stdout}`,
        };
      }

      // Retry deploy
      const retryResult = await runner(deployArgs, projectRoot);
      if (retryResult.exitCode !== 0) {
        return {
          service: serviceName,
          success: false,
          error: `wrangler pages deploy failed after project creation: ${retryResult.stderr || retryResult.stdout}`,
        };
      }
    }

    // Store project name in lock file
    storeResource(lockState, serviceName, "pages_project", projectName);

    // Step 5: Attach custom domain
    const customDomain = `${service.subdomain}.${config.domain}`;
    await attachCustomDomain(client, accountId, projectName, customDomain);

    return { service: serviceName, success: true };
  } catch (err) {
    return {
      service: serviceName,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Step 6: Cleanup temp files
    if (tmpDir) {
      cleanupTmpDir(tmpDir);
    }
  }
}

// --- Fallback Worker deploy ---

/**
 * Generates and deploys the fallback Worker.
 *
 * Steps:
 * 1. Create temp directory
 * 2. Generate Worker source
 * 3. Generate wrangler.toml
 * 4. Deploy via wrangler
 * 5. Store Worker name in lock file
 * 6. Cleanup
 */
export async function deployFallbackWorker(
  config: FlaregunConfig,
  lockState: LockState,
  projectRoot: string,
  runner: CommandRunner,
): Promise<WorkerDeployResult> {
  let tmpDir: string | undefined;

  try {
    // Step 1: Create temp directory
    tmpDir = createTmpDir();

    // Step 2: Generate Worker source
    writeWorkerSource(tmpDir, {
      domain: config.domain,
      downPagePath: config.down_page,
      basePath: projectRoot,
    });

    // Step 3: Generate wrangler.toml (writes to its own temp dir)
    const workerConfig = generateFallbackWorkerConfig(config.domain);
    // Copy the wrangler.toml content into our temp dir
    const wranglerTomlContent = readFileSync(workerConfig.configPath, "utf-8");
    writeFileSync(join(tmpDir, "wrangler.toml"), wranglerTomlContent, "utf-8");
    cleanupTmpDir(workerConfig.tmpDir);

    // Step 4: Deploy via wrangler
    const deployResult = await runner(["wrangler", "deploy"], tmpDir);

    if (deployResult.exitCode !== 0) {
      return {
        success: false,
        error: `Fallback Worker deploy failed: ${deployResult.stderr || deployResult.stdout}`,
      };
    }

    // Step 5: Store Worker name in lock file
    const workerName = resourceName(config.domain, "fallback");
    lockState.worker = { name: workerName };

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Step 6: Cleanup
    if (tmpDir) {
      cleanupTmpDir(tmpDir);
    }
  }
}

// --- Pipeline orchestrator ---

/**
 * Deploys all (or filtered) Pages services and the fallback Worker.
 *
 * - Checks wrangler availability first
 * - Identifies eligible Pages services (with optional name filter)
 * - Deploys services in parallel
 * - Deploys fallback Worker concurrently with services
 * - Produces a per-service summary report
 * - Returns overall success/failure
 */
export async function deployPipeline(
  config: FlaregunConfig,
  lockState: LockState,
  client: CloudflareClient,
  accountId: string,
  projectRoot: string,
  runner: CommandRunner,
  serviceFilter?: string[],
): Promise<DeployPipelineResult> {
  const summary: DeploySummaryEntry[] = [];

  // Prerequisite check: wrangler available
  const hasWrangler = await binaryExists("wrangler");
  if (!hasWrangler) {
    return {
      success: false,
      summary: [
        {
          name: "wrangler",
          type: "worker",
          success: false,
          error:
            "wrangler is not installed or not found on PATH. Install it with: bun add -g wrangler",
        },
      ],
    };
  }

  // Identify eligible Pages services
  const eligibleServices: [string, ServiceConfig][] = [];
  const filterErrors: DeploySummaryEntry[] = [];

  if (serviceFilter && serviceFilter.length > 0) {
    for (const name of serviceFilter) {
      const service = config.services[name];
      if (!service) {
        filterErrors.push({
          name,
          type: "pages",
          success: false,
          error: `Service "${name}" not found in config`,
        });
        continue;
      }
      if (service.type !== "pages") {
        filterErrors.push({
          name,
          type: "pages",
          success: false,
          error: `Service "${name}" is not a Pages service (type: ${service.type})`,
        });
        continue;
      }
      eligibleServices.push([name, service]);
    }
  } else {
    // No filter — deploy all Pages services
    for (const [name, service] of Object.entries(config.services)) {
      if (service.type === "pages") {
        eligibleServices.push([name, service]);
      }
    }
  }

  // Add filter errors to summary
  summary.push(...filterErrors);

  // Launch all service deploys and fallback Worker concurrently
  const servicePromises = eligibleServices.map(([name, service]) =>
    deployService(
      name,
      service,
      config,
      lockState,
      client,
      accountId,
      projectRoot,
      runner,
    ),
  );

  const workerPromise = deployFallbackWorker(
    config,
    lockState,
    projectRoot,
    runner,
  );

  // Wait for all to complete
  const [serviceResults, workerResult] = await Promise.all([
    Promise.all(servicePromises),
    workerPromise,
  ]);

  // Collect service results into summary
  for (const result of serviceResults) {
    summary.push({
      name: result.service,
      type: "pages",
      success: result.success,
      error: result.error,
    });
  }

  // Collect Worker result into summary
  summary.push({
    name: "fallback-worker",
    type: "worker",
    success: workerResult.success,
    error: workerResult.error,
  });

  // Overall success: all entries must be successful
  const allSuccess = summary.every((entry) => entry.success);

  return { success: allSuccess, summary };
}

// --- Summary formatting ---

/**
 * Formats the deploy pipeline result as a human-readable summary string.
 */
export function formatDeploySummary(result: DeployPipelineResult): string {
  const lines: string[] = [];

  lines.push("========================================");
  lines.push("  Deploy Summary");
  lines.push("========================================");
  lines.push("");

  for (const entry of result.summary) {
    const status = entry.success ? "\u2713 deployed" : "\u2717 failed";
    const typeLabel = entry.type === "pages" ? "Pages" : "Worker";
    let line = `  ${typeLabel} (${entry.name}): ${status}`;
    if (entry.error) {
      line += ` — ${entry.error}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push("========================================");

  return lines.join("\n");
}
