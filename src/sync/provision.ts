/**
 * Resource provisioner: D1 databases, R2 buckets, and KV namespaces.
 *
 * Creates cloud resources via the Cloudflare SDK with idempotency based on
 * lock file state. The lock file is the sole source of truth — if a resource
 * ID exists in the lock file, the provisioner trusts it without verifying
 * against Cloudflare.
 *
 * Also provides a destruction function that deletes all tracked resources,
 * continuing on individual failures so that partial teardowns still make
 * progress.
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import { lookupResource, storeResource } from "../lock/index.js";
import { resourceName } from "../naming.js";

// --- Types ---

/** Result of provisioning a single resource */
export interface ProvisionAction {
  service: string;
  resourceType: "d1_database" | "r2_bucket" | "kv_namespace";
  action: "created" | "skipped";
  name: string;
  id?: string;
}

/** Result of the full provisioning operation */
export interface ProvisionResult {
  actions: ProvisionAction[];
}

/** Result of destroying a single resource */
export interface DestroyAction {
  service: string;
  resourceType: "d1_database" | "r2_bucket" | "kv_namespace";
  resourceId: string;
  success: boolean;
  error?: string;
}

/** Result of the full destruction operation */
export interface DestroyResult {
  actions: DestroyAction[];
}

// --- Resource Name Helpers ---

/** Max length for R2 bucket names (most restrictive Cloudflare resource) */
const MAX_RESOURCE_NAME_LENGTH = 63;

/**
 * Appends a type suffix to the base resource name, truncating the base
 * if needed to keep the final name within R2's 63-character limit.
 */
function withSuffix(domain: string, serviceName: string, suffix: string): string {
  const base = resourceName(domain, serviceName);
  const maxBaseLength = MAX_RESOURCE_NAME_LENGTH - suffix.length;
  if (base.length > maxBaseLength) {
    const truncated = base.slice(0, maxBaseLength).replace(/-$/, "");
    return `${truncated}${suffix}`;
  }
  return `${base}${suffix}`;
}

/** Derives a D1 database name from domain and service name */
export function d1Name(domain: string, serviceName: string): string {
  return withSuffix(domain, serviceName, "-db");
}

/** Derives an R2 bucket name from domain and service name */
export function r2Name(domain: string, serviceName: string): string {
  return withSuffix(domain, serviceName, "-bucket");
}

/** Derives a KV namespace title from domain and service name */
export function kvName(domain: string, serviceName: string): string {
  return withSuffix(domain, serviceName, "-kv");
}

// --- Provisioning ---

/**
 * Provisions all declared cloud resources for a set of Pages services.
 *
 * For each eligible service, checks the lock file for existing resource IDs.
 * If found, skips creation. If not found, creates via the SDK and stores the
 * new ID in the lock file.
 *
 * @param client - Cloudflare SDK client (or mock)
 * @param config - Parsed flaregun config
 * @param accountId - Cloudflare account ID
 * @param lockState - In-memory lock file state (mutated in place)
 * @param serviceFilter - Optional list of service names to provision (all if omitted)
 * @returns Summary of what was provisioned
 */
export async function provisionResources(
  client: CloudflareClient,
  config: FlaregunConfig,
  accountId: string,
  lockState: LockState,
  serviceFilter?: string[],
): Promise<ProvisionResult> {
  const actions: ProvisionAction[] = [];

  // Type assertion for the client's D1/R2/KV methods
  const typedClient = client as unknown as {
    d1: {
      database: {
        create: (params: {
          account_id: string;
          name: string;
        }) => Promise<{ uuid: string; name: string }>;
      };
    };
    r2: {
      buckets: {
        create: (params: {
          account_id: string;
          name: string;
        }) => Promise<{ name: string }>;
      };
    };
    kv: {
      namespaces: {
        create: (params: {
          account_id: string;
          title: string;
        }) => Promise<{ id: string; title: string }>;
      };
    };
  };

  for (const [serviceName, service] of Object.entries(config.services)) {
    // Skip local services — cloud resources only apply to Pages services
    if (service.type !== "pages") {
      continue;
    }

    // Apply service name filter if provided
    if (serviceFilter && !serviceFilter.includes(serviceName)) {
      continue;
    }

    // Skip services with no cloud resource declarations
    if (!service.database && !service.bucket && !service.kv) {
      continue;
    }

    // D1 database
    if (service.database) {
      const existing = lookupResource(lockState, serviceName, "d1_database");
      if (existing) {
        actions.push({
          service: serviceName,
          resourceType: "d1_database",
          action: "skipped",
          name: d1Name(config.domain, serviceName),
          id: existing,
        });
      } else {
        const name = d1Name(config.domain, serviceName);
        const result = await typedClient.d1.database.create({
          account_id: accountId,
          name,
        });
        storeResource(lockState, serviceName, "d1_database", result.uuid);
        actions.push({
          service: serviceName,
          resourceType: "d1_database",
          action: "created",
          name,
          id: result.uuid,
        });
      }
    }

    // R2 bucket
    if (service.bucket) {
      const existing = lookupResource(lockState, serviceName, "r2_bucket");
      if (existing) {
        actions.push({
          service: serviceName,
          resourceType: "r2_bucket",
          action: "skipped",
          name: r2Name(config.domain, serviceName),
          id: existing,
        });
      } else {
        const name = r2Name(config.domain, serviceName);
        await typedClient.r2.buckets.create({ account_id: accountId, name });
        storeResource(lockState, serviceName, "r2_bucket", name);
        actions.push({
          service: serviceName,
          resourceType: "r2_bucket",
          action: "created",
          name,
        });
      }
    }

    // KV namespace
    if (service.kv) {
      const existing = lookupResource(lockState, serviceName, "kv_namespace");
      if (existing) {
        actions.push({
          service: serviceName,
          resourceType: "kv_namespace",
          action: "skipped",
          name: kvName(config.domain, serviceName),
          id: existing,
        });
      } else {
        const title = kvName(config.domain, serviceName);
        const result = await typedClient.kv.namespaces.create({
          account_id: accountId,
          title,
        });
        storeResource(lockState, serviceName, "kv_namespace", result.id);
        actions.push({
          service: serviceName,
          resourceType: "kv_namespace",
          action: "created",
          name: title,
          id: result.id,
        });
      }
    }
  }

  return { actions };
}

// --- Destruction ---

/**
 * Deletes all D1/R2/KV resources tracked in the lock file.
 *
 * Iterates through all pages entries in the lock file and deletes each
 * resource via the SDK. Continues on individual failures so that partial
 * teardowns still make progress. Successfully deleted resources are removed
 * from the lock file; failed ones remain for retry.
 *
 * @param client - Cloudflare SDK client (or mock)
 * @param accountId - Cloudflare account ID
 * @param lockState - In-memory lock file state (mutated in place)
 * @returns Summary report of success/failure per resource
 */
export async function destroyResources(
  client: CloudflareClient,
  accountId: string,
  lockState: LockState,
): Promise<DestroyResult> {
  const actions: DestroyAction[] = [];

  // Type assertion for the client's D1/R2/KV methods
  const typedClient = client as unknown as {
    d1: {
      database: {
        delete: (
          databaseId: string,
          params: { account_id: string },
        ) => Promise<void>;
      };
    };
    r2: {
      buckets: {
        delete: (
          bucketName: string,
          params: { account_id: string },
        ) => Promise<void>;
      };
    };
    kv: {
      namespaces: {
        delete: (
          namespaceId: string,
          params: { account_id: string },
        ) => Promise<void>;
      };
    };
  };

  for (const [serviceName, entry] of Object.entries(lockState.pages)) {
    // D1 database
    if (entry.d1_database_id) {
      const resourceId = entry.d1_database_id;
      try {
        await typedClient.d1.database.delete(resourceId, {
          account_id: accountId,
        });
        // Remove from lock state on success
        delete lockState.pages[serviceName].d1_database_id;
        actions.push({
          service: serviceName,
          resourceType: "d1_database",
          resourceId,
          success: true,
        });
      } catch (err) {
        actions.push({
          service: serviceName,
          resourceType: "d1_database",
          resourceId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // R2 bucket
    if (entry.r2_bucket_name) {
      const resourceId = entry.r2_bucket_name;
      try {
        await typedClient.r2.buckets.delete(resourceId, {
          account_id: accountId,
        });
        // Remove from lock state on success
        delete lockState.pages[serviceName].r2_bucket_name;
        actions.push({
          service: serviceName,
          resourceType: "r2_bucket",
          resourceId,
          success: true,
        });
      } catch (err) {
        actions.push({
          service: serviceName,
          resourceType: "r2_bucket",
          resourceId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // KV namespace
    if (entry.kv_namespace_id) {
      const resourceId = entry.kv_namespace_id;
      try {
        await typedClient.kv.namespaces.delete(resourceId, {
          account_id: accountId,
        });
        // Remove from lock state on success
        delete lockState.pages[serviceName].kv_namespace_id;
        actions.push({
          service: serviceName,
          resourceType: "kv_namespace",
          resourceId,
          success: true,
        });
      } catch (err) {
        actions.push({
          service: serviceName,
          resourceType: "kv_namespace",
          resourceId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { actions };
}
