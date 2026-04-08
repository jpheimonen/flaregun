/**
 * Wrangler config generator.
 *
 * Produces temporary `wrangler.toml` files for two deployment targets:
 *
 * 1. **Pages projects** — includes `pages_build_output_dir` and D1/R2/KV
 *    bindings derived from the lock file.
 *
 * 2. **Fallback Worker** — includes the worker name, wildcard route pattern,
 *    compatibility date, and entry point.
 *
 * Generated files are written to a temporary directory and consumed by
 * wrangler during deployment. The caller (deploy pipeline) is responsible
 * for cleanup via the tmp utility.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import type { ServiceConfig } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import { lookupResource } from "../lock/index.js";
import { resourceName } from "../naming.js";
import { d1Name } from "../sync/provision.js";
import { createTmpDir } from "./tmp.js";

// --- Error Types ---

/** Thrown when a declared cloud resource has no corresponding lock file entry */
export class MissingResourceError extends Error {
  constructor(
    public readonly serviceName: string,
    public readonly resourceType: string,
  ) {
    super(
      `Service "${serviceName}" declares ${resourceType} but no corresponding ID was found in the lock file. ` +
        `Run the resource provisioner before generating wrangler config.`,
    );
    this.name = "MissingResourceError";
  }
}

// --- Types ---

/** Result of generating a Pages wrangler config */
export interface PagesConfigResult {
  /** Path to the generated wrangler.toml */
  configPath: string;
  /** Path to the temporary directory containing the config */
  tmpDir: string;
}

/** Result of generating a fallback Worker wrangler config */
export interface FallbackConfigResult {
  /** Path to the generated wrangler.toml */
  configPath: string;
  /** Path to the temporary directory containing the config */
  tmpDir: string;
}

// --- Compatibility date ---

/** Fixed compatibility date for generated Worker configs */
const COMPATIBILITY_DATE = "2025-04-01";

/** Expected filename for the fallback Worker source */
const FALLBACK_WORKER_ENTRY = "index.ts";

// --- Pages Config Generator ---

/**
 * Generates a wrangler.toml for deploying a Pages project.
 *
 * The generated config includes:
 * - Project name derived from domain + service name
 * - `pages_build_output_dir` pointing to the service's dist path
 * - D1/R2/KV binding sections for declared cloud resources
 *
 * Throws {@link MissingResourceError} if a declared resource has no lock file entry.
 *
 * @param serviceName - The service name key from the config
 * @param service - The service configuration
 * @param domain - The domain from the flaregun config
 * @param lockState - The current lock file state
 * @returns Paths to the generated config file and temp directory
 */
export function generatePagesConfig(
  serviceName: string,
  service: ServiceConfig,
  domain: string,
  lockState: LockState,
): PagesConfigResult {
  const projectName = resourceName(domain, serviceName);
  const distDir = service.dist ?? "dist/";

  const lines: string[] = [];

  // Project name and build output directory
  lines.push(`name = "${projectName}"`);
  lines.push(`pages_build_output_dir = "${distDir}"`);

  // D1 database binding
  if (service.database) {
    const dbId = lookupResource(lockState, serviceName, "d1_database");
    if (!dbId) {
      throw new MissingResourceError(serviceName, "database (D1)");
    }
    const dbName = d1Name(domain, serviceName);
    lines.push("");
    lines.push("[[d1_databases]]");
    lines.push('binding = "DB"');
    lines.push(`database_name = "${dbName}"`);
    lines.push(`database_id = "${dbId}"`);
  }

  // R2 bucket binding
  if (service.bucket) {
    const bucketName = lookupResource(lockState, serviceName, "r2_bucket");
    if (!bucketName) {
      throw new MissingResourceError(serviceName, "bucket (R2)");
    }
    lines.push("");
    lines.push("[[r2_buckets]]");
    lines.push('binding = "BUCKET"');
    lines.push(`bucket_name = "${bucketName}"`);
  }

  // KV namespace binding
  if (service.kv) {
    const nsId = lookupResource(lockState, serviceName, "kv_namespace");
    if (!nsId) {
      throw new MissingResourceError(serviceName, "kv (KV namespace)");
    }
    lines.push("");
    lines.push("[[kv_namespaces]]");
    lines.push('binding = "KV"');
    lines.push(`id = "${nsId}"`);
  }

  lines.push("");

  // Write to temp directory
  const tmpDir = createTmpDir();
  const configPath = join(tmpDir, "wrangler.toml");
  writeFileSync(configPath, lines.join("\n"), "utf-8");

  return { configPath, tmpDir };
}

// --- Fallback Worker Config Generator ---

/**
 * Generates a wrangler.toml for deploying the fallback Worker.
 *
 * The generated config includes:
 * - Worker name derived from the domain (e.g., "example-com-fallback")
 * - Main entry point pointing to the Worker source file
 * - A fixed compatibility date
 * - A wildcard route matching all subdomains of the domain
 *
 * @param domain - The domain from the flaregun config
 * @returns Paths to the generated config file and temp directory
 */
export function generateFallbackWorkerConfig(domain: string): FallbackConfigResult {
  const workerName = resourceName(domain, "fallback");
  const routePattern = `*.${domain}/*`;

  const lines: string[] = [];

  lines.push(`name = "${workerName}"`);
  lines.push(`main = "${FALLBACK_WORKER_ENTRY}"`);
  lines.push(`compatibility_date = "${COMPATIBILITY_DATE}"`);
  lines.push("");
  lines.push("[[routes]]");
  lines.push(`pattern = "${routePattern}"`);
  lines.push(`zone_name = "${domain}"`);
  lines.push("");

  // Write to temp directory
  const tmpDir = createTmpDir();
  const configPath = join(tmpDir, "wrangler.toml");
  writeFileSync(configPath, lines.join("\n"), "utf-8");

  return { configPath, tmpDir };
}
