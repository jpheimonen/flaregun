/**
 * Destroy command handler.
 *
 * Orchestrates the complete teardown of all Cloudflare resources managed by
 * flaregun. This is the inverse of setup/deploy/up — it removes Access apps,
 * the tunnel, DNS records, redirect rules, the fallback Worker, Pages projects,
 * and cloud resources (D1/R2/KV).
 *
 * Design principles:
 * - Continue-on-failure: each deletion category runs independently. A failure
 *   in one does not prevent subsequent categories from executing.
 * - Lock file resilience: the lock file is saved after each category so that
 *   progress is preserved if the command is interrupted.
 * - Retry-friendly: resources that failed to delete remain in the lock file,
 *   so re-running `flaregun destroy` retries only the failures.
 * - Dependency injection: all subsystems are injectable for testability.
 */

import { resolve, dirname } from "path";
import type { CloudflareClient } from "../cloudflare/index.js";
import { createClient } from "../cloudflare/index.js";
import { loadConfig, type FlaregunConfig } from "../config/index.js";
import type { CloudflareCredentials } from "../env/index.js";
import { loadAndValidateEnv } from "../env/index.js";
import {
  loadLockFile,
  saveLockFile,
  clearState,
  type LockState,
} from "../lock/index.js";
import { collectPages } from "../sync/access.js";
import { destroyResources } from "../sync/provision.js";

// --- Types ---

/** Error record for a single failed deletion */
export interface DeletionError {
  category: string;
  resource: string;
  error: string;
}

/** Summary of a single deletion category */
export interface CategorySummary {
  category: string;
  deleted: number;
  failed: number;
  errors: DeletionError[];
}

/** Full result of the destroy command */
export interface DestroyCommandResult {
  success: boolean;
  categories: CategorySummary[];
  error?: string;
}

/** Confirmation prompt function type */
export type ConfirmFn = (domain: string, summary: string) => Promise<boolean>;

/** Dependencies injectable into the destroy command handler for testability */
export interface DestroyCommandDeps {
  /** Config loader — defaults to loadConfig */
  loadConfigFn?: (configPath?: string) => FlaregunConfig;
  /** Environment loader — defaults to loadAndValidateEnv */
  loadEnvFn?: (configPath: string, context: "destroy") => CloudflareCredentials;
  /** Lock file loader — defaults to loadLockFile */
  loadLockFn?: (path: string) => LockState;
  /** Lock file saver — defaults to saveLockFile */
  saveLockFn?: (path: string, state: LockState) => void;
  /** Client factory — defaults to createClient */
  createClientFn?: (credentials: CloudflareCredentials) => CloudflareClient;
  /** Confirmation prompt — defaults to interactive stdin prompt */
  confirmFn?: ConfirmFn;
  /** Resource provisioner destruction function — defaults to destroyResources */
  destroyResourcesFn?: typeof destroyResources;
  /** Output function for normal messages — defaults to console.log */
  stdout?: (msg: string) => void;
  /** Output function for error messages — defaults to console.error */
  stderr?: (msg: string) => void;
}

// --- Lock file emptiness check ---

/** Returns true if the lock state has no tracked resources */
function isLockEmpty(state: LockState): boolean {
  const hasPages = Object.keys(state.pages).length > 0;
  const hasAccess = Object.keys(state.access).length > 0;
  const hasTunnel = !!state.tunnel;
  const hasWorker = !!state.worker;
  return !hasPages && !hasAccess && !hasTunnel && !hasWorker;
}

// --- Resource summary for confirmation prompt ---

/** Builds a human-readable summary of resources to be deleted */
export function buildResourceSummary(lockState: LockState): string {
  const lines: string[] = [];

  const accessCount = Object.keys(lockState.access).length;
  if (accessCount > 0) {
    lines.push(`  - ${accessCount} Access application(s)`);
  }

  if (lockState.tunnel) {
    lines.push(`  - 1 Cloudflare Tunnel`);
  }

  const pagesCount = Object.keys(lockState.pages).length;
  if (pagesCount > 0) {
    lines.push(`  - ${pagesCount} Pages project(s)`);
  }

  // Count cloud resources
  let d1Count = 0;
  let r2Count = 0;
  let kvCount = 0;
  for (const entry of Object.values(lockState.pages)) {
    if (entry.d1_database_id) d1Count++;
    if (entry.r2_bucket_name) r2Count++;
    if (entry.kv_namespace_id) kvCount++;
  }
  if (d1Count > 0) lines.push(`  - ${d1Count} D1 database(s)`);
  if (r2Count > 0) lines.push(`  - ${r2Count} R2 bucket(s)`);
  if (kvCount > 0) lines.push(`  - ${kvCount} KV namespace(s)`);

  if (lockState.worker) {
    lines.push(`  - 1 fallback Worker`);
  }

  lines.push(`  - DNS records (wildcard, per-service, www CNAMEs)`);
  lines.push(`  - Redirect rules (bare domain redirect)`);

  return lines.join("\n");
}

// --- Default confirmation prompt ---

/** Default interactive confirmation prompt using stdin/stdout */
async function defaultConfirm(domain: string, summary: string): Promise<boolean> {
  // Abort if not a TTY
  if (!process.stdin.isTTY) {
    console.error("Error: flaregun destroy requires interactive confirmation (stdin must be a TTY).");
    return false;
  }

  console.log("\n⚠️  WARNING: This will permanently delete all Cloudflare resources managed by flaregun.\n");
  console.log("The following resources will be deleted:\n");
  console.log(summary);
  console.log("\nThis operation is IRREVERSIBLE. Data in D1 databases and R2 buckets will be permanently lost.\n");
  console.log(`To confirm, type the domain name: ${domain}\n`);

  // Read a line from stdin
  const input = await new Promise<string>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });

  return input === domain;
}

// --- Teardown Steps ---

/** Step 1: Delete Access applications */
async function deleteAccessApplications(
  client: CloudflareClient,
  lockState: LockState,
  zoneId: string,
  saveLock: () => void,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Access applications",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  const accessEntries = Object.entries(lockState.access);
  if (accessEntries.length === 0) return summary;

  const typedClient = client as unknown as {
    zeroTrust: {
      access: {
        applications: {
          delete: (appId: string, params: { zone_id: string }) => Promise<void>;
        };
      };
    };
  };

  for (const [serviceName, entry] of accessEntries) {
    try {
      await typedClient.zeroTrust.access.applications.delete(entry.app_id, {
        zone_id: zoneId,
      });
      delete lockState.access[serviceName];
      summary.deleted++;
    } catch (err) {
      summary.failed++;
      summary.errors.push({
        category: "Access applications",
        resource: `${serviceName} (${entry.app_id})`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  saveLock();
  return summary;
}

/** Step 2: Delete the tunnel */
async function deleteTunnel(
  client: CloudflareClient,
  lockState: LockState,
  accountId: string,
  saveLock: () => void,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Tunnel",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  if (!lockState.tunnel) return summary;

  const tunnelId = lockState.tunnel.id;

  const typedClient = client as unknown as {
    zeroTrust: {
      tunnels: {
        cloudflared: {
          delete: (
            tunnelId: string,
            params: { account_id: string; body: Record<string, never> },
          ) => Promise<void>;
        };
      };
    };
  };

  try {
    await typedClient.zeroTrust.tunnels.cloudflared.delete(tunnelId, {
      account_id: accountId,
      body: {},
    });
    lockState.tunnel = undefined;
    summary.deleted++;
  } catch (err) {
    summary.failed++;
    summary.errors.push({
      category: "Tunnel",
      resource: tunnelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  saveLock();
  return summary;
}

/** Step 3: Delete DNS records */
async function deleteDnsRecords(
  client: CloudflareClient,
  config: FlaregunConfig,
  zoneId: string,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "DNS records",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  interface DnsRecord {
    id?: string;
    name: string;
    type: string;
    content?: string;
  }

  // List all CNAME records in the zone
  const existingRecords = await collectPages<DnsRecord>(
    client.dns.records.list({ zone_id: zoneId, type: "CNAME" }),
  );

  const domain = config.domain;
  const wildcardName = `*.${domain}`;
  const wwwName = `www.${domain}`;

  // Identify records managed by flaregun:
  // 1. Wildcard CNAME (*.domain)
  // 2. Per-Pages-service CNAMEs (subdomain.domain → *.pages.dev)
  // 3. www CNAME (www.domain)
  const toDelete: DnsRecord[] = [];

  for (const record of existingRecords) {
    if (record.type !== "CNAME") continue;

    // Wildcard record
    if (record.name === wildcardName) {
      toDelete.push(record);
      continue;
    }

    // www record
    if (record.name === wwwName) {
      toDelete.push(record);
      continue;
    }

    // Per-Pages-service CNAME pointing to *.pages.dev
    if (
      record.name.endsWith(`.${domain}`) &&
      record.content?.endsWith(".pages.dev")
    ) {
      toDelete.push(record);
      continue;
    }
  }

  const typedClient = client as unknown as {
    dns: {
      records: {
        delete: (recordId: string, params: { zone_id: string }) => Promise<void>;
      };
    };
  };

  for (const record of toDelete) {
    try {
      await typedClient.dns.records.delete(record.id!, { zone_id: zoneId });
      summary.deleted++;
    } catch (err) {
      summary.failed++;
      summary.errors.push({
        category: "DNS records",
        resource: record.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/** Step 4: Delete redirect rules */
async function deleteRedirectRules(
  client: CloudflareClient,
  config: FlaregunConfig,
  zoneId: string,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Redirect rules",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  const redirectExpression = `(http.host eq "${config.domain}")`;

  interface RedirectRule {
    id?: string;
    expression?: string;
    action?: string;
    description?: string;
    action_parameters?: unknown;
  }

  interface RedirectRuleset {
    id?: string;
    rules?: RedirectRule[];
  }

  // Try to get existing redirect rules
  let existingRuleset: RedirectRuleset | null = null;

  try {
    const result = await client.rulesets.phases.get(
      "http_request_dynamic_redirect",
      { zone_id: zoneId },
    );
    existingRuleset = result as unknown as RedirectRuleset;
  } catch {
    // Phase ruleset doesn't exist — nothing to delete
    return summary;
  }

  const existingRules = existingRuleset?.rules ?? [];

  // Find the flaregun-managed rule
  const flaregunRuleIndex = existingRules.findIndex(
    (rule) => rule.expression === redirectExpression,
  );

  if (flaregunRuleIndex === -1) {
    // No matching rule found — nothing to delete
    return summary;
  }

  // Build updated rules without the flaregun rule
  const updatedRules = existingRules
    .filter((_, idx) => idx !== flaregunRuleIndex)
    .map((rule) => ({
      id: rule.id,
      expression: rule.expression!,
      action: rule.action! as "redirect",
      description: rule.description,
      action_parameters: rule.action_parameters,
    }));

  try {
    await client.rulesets.phases.update("http_request_dynamic_redirect", {
      zone_id: zoneId,
      rules: updatedRules,
    } as Parameters<typeof client.rulesets.phases.update>[1]);
    summary.deleted++;
  } catch (err) {
    summary.failed++;
    summary.errors.push({
      category: "Redirect rules",
      resource: `bare-domain redirect for ${config.domain}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return summary;
}

/** Step 5: Delete the fallback Worker */
async function deleteFallbackWorker(
  client: CloudflareClient,
  lockState: LockState,
  accountId: string,
  saveLock: () => void,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Worker",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  if (!lockState.worker) return summary;

  const workerName = lockState.worker.name;

  const typedClient = client as unknown as {
    workers: {
      scripts: {
        delete: (
          scriptName: string,
          params: { account_id: string },
        ) => Promise<void>;
      };
    };
  };

  try {
    await typedClient.workers.scripts.delete(workerName, {
      account_id: accountId,
    });
    lockState.worker = undefined;
    summary.deleted++;
  } catch (err) {
    summary.failed++;
    summary.errors.push({
      category: "Worker",
      resource: workerName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  saveLock();
  return summary;
}

/** Step 6: Delete Pages projects */
async function deletePagesProjects(
  client: CloudflareClient,
  lockState: LockState,
  accountId: string,
  saveLock: () => void,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Pages projects",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  const pagesEntries = Object.entries(lockState.pages);
  if (pagesEntries.length === 0) return summary;

  const typedClient = client as unknown as {
    pages: {
      projects: {
        delete: (
          projectName: string,
          params: { account_id: string },
        ) => Promise<void>;
      };
    };
  };

  for (const [serviceName, entry] of pagesEntries) {
    if (!entry.project_name) continue;

    try {
      await typedClient.pages.projects.delete(entry.project_name, {
        account_id: accountId,
      });
      // Clear project_name but keep entry so resource IDs survive lock file reload.
      // loadLockFile requires project_name to be a string to parse the entry;
      // setting it to "" preserves D1/R2/KV IDs if the process is interrupted
      // before step 7 deletes them.
      lockState.pages[serviceName].project_name = "";
      summary.deleted++;
    } catch (err) {
      summary.failed++;
      summary.errors.push({
        category: "Pages projects",
        resource: `${serviceName} (${entry.project_name})`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  saveLock();
  return summary;
}

/** Step 7: Delete cloud resources (D1, R2, KV) */
async function deleteCloudResources(
  client: CloudflareClient,
  lockState: LockState,
  accountId: string,
  destroyResourcesFn: typeof destroyResources,
  saveLock: () => void,
): Promise<CategorySummary> {
  const summary: CategorySummary = {
    category: "Cloud resources",
    deleted: 0,
    failed: 0,
    errors: [],
  };

  const result = await destroyResourcesFn(client, accountId, lockState);

  for (const action of result.actions) {
    if (action.success) {
      summary.deleted++;
    } else {
      summary.failed++;
      summary.errors.push({
        category: `Cloud resources (${action.resourceType})`,
        resource: `${action.service} (${action.resourceId})`,
        error: action.error ?? "Unknown error",
      });
    }
  }

  saveLock();
  return summary;
}

// --- Summary formatting ---

/** Formats the final completion summary */
export function formatDestroySummary(categories: CategorySummary[]): string {
  const lines: string[] = ["\n--- Destroy Summary ---\n"];

  let totalDeleted = 0;
  let totalFailed = 0;

  for (const cat of categories) {
    totalDeleted += cat.deleted;
    totalFailed += cat.failed;

    if (cat.deleted === 0 && cat.failed === 0) continue;

    if (cat.failed === 0) {
      lines.push(`✓ ${cat.category}: ${cat.deleted} deleted`);
    } else if (cat.deleted === 0) {
      lines.push(`✗ ${cat.category}: ${cat.failed} failed`);
    } else {
      lines.push(
        `⚠ ${cat.category}: ${cat.deleted} deleted, ${cat.failed} failed`,
      );
    }

    for (const err of cat.errors) {
      lines.push(`    - ${err.resource}: ${err.error}`);
    }
  }

  lines.push("");

  if (totalFailed === 0 && totalDeleted > 0) {
    lines.push("All Cloudflare resources have been successfully removed.");
    lines.push(
      "The .env and flaregun.yml files remain — remove them manually if no longer needed.",
    );
  } else if (totalFailed > 0) {
    lines.push(
      `Completed with ${totalFailed} failure(s). The lock file retains entries for failed resources.`,
    );
    lines.push("Re-run `flaregun destroy` to retry the failed deletions.");
    lines.push(
      "The .env and flaregun.yml files remain — remove them manually if no longer needed.",
    );
  } else {
    lines.push("No resources were found to delete.");
  }

  return lines.join("\n");
}

// --- Main Command Handler ---

/**
 * Handles the `flaregun destroy` command.
 *
 * @param configPath - Optional path to flaregun.yml (defaults to cwd)
 * @param deps - Injectable dependencies for testability
 * @returns Command result with success/failure and category details
 */
export async function handleDestroy(
  configPath?: string,
  deps: DestroyCommandDeps = {},
): Promise<DestroyCommandResult> {
  const {
    loadConfigFn = loadConfig,
    loadEnvFn = loadAndValidateEnv,
    loadLockFn = loadLockFile,
    saveLockFn: saveLockFileFn = saveLockFile,
    createClientFn = createClient,
    confirmFn = defaultConfirm,
    destroyResourcesFn = destroyResources,
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
    return { success: false, categories: [], error: msg };
  }

  // Resolve paths
  const resolvedConfigPath =
    configPath ?? resolve(process.cwd(), "flaregun.yml");
  const configDir = dirname(resolvedConfigPath);
  const lockPath = resolve(configDir, "flaregun.lock");

  // Step 2: Load and validate environment
  let credentials: CloudflareCredentials;
  try {
    credentials = loadEnvFn(resolvedConfigPath, "destroy");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Environment error: ${msg}`);
    return { success: false, categories: [], error: msg };
  }

  // Step 3: Load lock file
  let lockState: LockState;
  try {
    lockState = loadLockFn(lockPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Lock file error: ${msg}`);
    return { success: false, categories: [], error: msg };
  }

  // Check if lock file is empty
  if (isLockEmpty(lockState)) {
    stdout("Nothing to destroy — no resources tracked in the lock file.");
    return { success: true, categories: [] };
  }

  // Step 4: Initialize SDK client
  const client = createClientFn(credentials);

  // Step 5: Confirmation prompt
  const summary = buildResourceSummary(lockState);
  const confirmed = await confirmFn(config.domain, summary);

  if (!confirmed) {
    stdout("Destroy cancelled.");
    return { success: true, categories: [] };
  }

  // Helper to save the lock file
  const saveLock = () => {
    saveLockFileFn(lockPath, lockState);
  };

  // --- Execute teardown sequence ---
  const categories: CategorySummary[] = [];

  // Step 1: Delete Access applications
  const accessResult = await deleteAccessApplications(
    client,
    lockState,
    credentials.zoneId,
    saveLock,
  );
  categories.push(accessResult);

  // Step 2: Delete the tunnel
  const tunnelResult = await deleteTunnel(
    client,
    lockState,
    credentials.accountId,
    saveLock,
  );
  categories.push(tunnelResult);

  // Step 3: Delete DNS records
  const dnsResult = await deleteDnsRecords(client, config, credentials.zoneId);
  categories.push(dnsResult);

  // Step 4: Delete redirect rules
  const redirectResult = await deleteRedirectRules(
    client,
    config,
    credentials.zoneId,
  );
  categories.push(redirectResult);

  // Step 5: Delete the fallback Worker
  const workerResult = await deleteFallbackWorker(
    client,
    lockState,
    credentials.accountId,
    saveLock,
  );
  categories.push(workerResult);

  // Step 6: Delete Pages projects
  const pagesResult = await deletePagesProjects(
    client,
    lockState,
    credentials.accountId,
    saveLock,
  );
  categories.push(pagesResult);

  // Step 7: Delete cloud resources (D1, R2, KV)
  const cloudResult = await deleteCloudResources(
    client,
    lockState,
    credentials.accountId,
    destroyResourcesFn,
    saveLock,
  );
  categories.push(cloudResult);

  // Step 8: Final lock file cleanup
  const hasFailures = categories.some((c) => c.failed > 0);

  if (!hasFailures) {
    // All resources deleted — clear the lock file
    clearState(lockState);
    saveLock();
  } else {
    // Clean up pages entries that have no remaining fields (project_name was cleared
    // to "" in step 6 and resource IDs were deleted in step 7)
    for (const [serviceName, entry] of Object.entries(lockState.pages)) {
      const remaining = Object.values(entry).filter((v) => v !== undefined && v !== "");
      if (remaining.length === 0) {
        delete lockState.pages[serviceName];
      }
    }
    saveLock();
  }

  // Print summary
  const allSuccess = !hasFailures;
  stdout(formatDestroySummary(categories));

  return {
    success: allSuccess,
    categories,
  };
}
