/**
 * Build command handler.
 *
 * Implements `flaregun build [service-names...]` — runs build commands for
 * all or filtered services, triggers scaffolding for services with cloud
 * resources but no functions/ directory, copies functions/ into dist/functions/,
 * and reports per-service results.
 *
 * Unlike the deploy command, the build command does NOT require Cloudflare
 * credentials. It only performs local operations (build commands, file copies),
 * making it suitable for CI environments without API tokens.
 *
 * The build-scaffold-copy sequence is shared with the deploy pipeline via
 * the buildScaffoldCopy function in build.ts.
 */

import type { FlaregunConfig, ServiceConfig } from "../config/index.js";
import { loadConfig } from "../config/index.js";
import { emptyState } from "../lock/index.js";
import type { CommandRunner } from "../process/index.js";
import { runCommand } from "../process/index.js";
import { buildScaffoldCopy } from "./build.js";

// --- Types ---

/** Status of an individual service build */
export type BuildStatus = "success" | "skipped" | "failed";

/** Result for a single service in the build command */
export interface ServiceBuildEntry {
  name: string;
  status: BuildStatus;
  error?: string;
  /** Note for skipped services (e.g., "no build command") */
  note?: string;
}

/** Result of the entire build command */
export interface BuildCommandResult {
  success: boolean;
  entries: ServiceBuildEntry[];
}

/** Dependencies injectable into the build command handler for testability */
export interface BuildCommandDeps {
  /** Config loader — defaults to loadConfig */
  loadConfigFn?: (configPath?: string) => FlaregunConfig;
  /** Command runner — defaults to runCommand */
  runner?: CommandRunner;
  /** Output function for normal messages — defaults to console.log */
  stdout?: (msg: string) => void;
  /** Output function for error messages — defaults to console.error */
  stderr?: (msg: string) => void;
}

// --- Build Command ---

/**
 * Handles the `flaregun build` command.
 *
 * @param filters - Optional service name arguments for filtering
 * @param configPath - Optional path to flaregun.yml (defaults to cwd)
 * @param deps - Injectable dependencies for testability
 * @returns Command result with per-service entries and overall success
 */
export async function handleBuild(
  filters: string[] = [],
  configPath?: string,
  deps: BuildCommandDeps = {},
): Promise<BuildCommandResult> {
  const {
    loadConfigFn = loadConfig,
    runner = runCommand,
    stdout = console.log,
    stderr = console.error,
  } = deps;

  // Step 1: Load and validate config (no credentials needed)
  let config: FlaregunConfig;
  try {
    config = loadConfigFn(configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Config error: ${msg}`);
    return { success: false, entries: [] };
  }

  // Step 2: Identify eligible services
  const entries: ServiceBuildEntry[] = [];
  const eligibleServices: [string, ServiceConfig][] = [];

  if (filters.length > 0) {
    // Filtered mode: only build named services
    for (const name of filters) {
      const service = config.services[name];

      if (!service) {
        // Named service does not exist in config
        entries.push({
          name,
          status: "failed",
          error: `Service "${name}" not found in config`,
        });
        continue;
      }

      if (service.type === "pages") {
        // Pages services are always eligible
        eligibleServices.push([name, service]);
      } else if (service.type === "local") {
        if (service.build) {
          // Local service with a build field is eligible
          eligibleServices.push([name, service]);
        } else {
          // Local service without a build field — skip with note
          entries.push({
            name,
            status: "skipped",
            note: `Local service "${name}" has no build command — skipped`,
          });
        }
      }
    }
  } else {
    // Unfiltered mode: select all Pages services
    for (const [name, service] of Object.entries(config.services)) {
      if (service.type === "pages") {
        eligibleServices.push([name, service]);
      }
    }
  }

  // Step 3: Execute per-service build
  const lockState = emptyState();

  for (const [serviceName, service] of eligibleServices) {
    // If the service has no build command, mark it as skipped.
    // The build command's primary purpose is running build commands;
    // services without one have nothing to do.
    if (!service.build) {
      entries.push({
        name: serviceName,
        status: "skipped",
        note: `Service "${serviceName}" has no build command — skipped`,
      });
      continue;
    }

    // Run the shared build-scaffold-copy sequence
    const buildResult = await buildScaffoldCopy(
      serviceName,
      service,
      process.cwd(),
      lockState,
      runner,
    );

    if (!buildResult.success) {
      entries.push({
        name: serviceName,
        status: "failed",
        error: buildResult.error,
      });
    } else {
      entries.push({
        name: serviceName,
        status: "success",
      });
    }
  }

  // Step 4: Report results
  stdout(formatBuildSummary(entries));

  // Step 5: Determine exit code
  const hasFailure = entries.some((e) => e.status === "failed");

  return {
    success: !hasFailure,
    entries,
  };
}

// --- Summary formatting ---

/**
 * Formats the build command results as a human-readable summary string.
 */
export function formatBuildSummary(entries: ServiceBuildEntry[]): string {
  const lines: string[] = [];

  lines.push("========================================");
  lines.push("  Build Summary");
  lines.push("========================================");
  lines.push("");

  if (entries.length === 0) {
    lines.push("  No services to build.");
  } else {
    for (const entry of entries) {
      let statusLabel: string;
      switch (entry.status) {
        case "success":
          statusLabel = "\u2713 built";
          break;
        case "skipped":
          statusLabel = "- skipped";
          break;
        case "failed":
          statusLabel = "\u2717 failed";
          break;
      }

      let line = `  ${entry.name}: ${statusLabel}`;
      if (entry.error) {
        line += ` — ${entry.error}`;
      }
      if (entry.note) {
        line += ` — ${entry.note}`;
      }
      lines.push(line);
    }
  }

  lines.push("");
  lines.push("========================================");

  return lines.join("\n");
}
