/**
 * Sync engine: Access applications and policies.
 *
 * Ensures Cloudflare Access self-hosted applications and policies exist for every
 * service that requires auth protection. Handles creation, idempotent skipping,
 * and deletion of stale resources.
 *
 * Functions follow the dependency injection pattern: they accept the Cloudflare SDK
 * client, parsed config, account ID, and lock file state as parameters.
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type {
  FlaregunConfig,
  ServiceConfig,
  AccessSelector,
} from "../config/index.js";
import { buildServiceSelectors } from "../config/index.js";
import type { LockState } from "../lock/index.js";

// --- Types ---

/** A managed Access application tracked by the sync engine */
export interface ManagedApp {
  id: string;
  /** Lock state key — service name or ADMIN_LOCK_KEY for implicit admin */
  name: string;
  hostname: string;
}

/** Internal representation of a desired Access application */
interface DesiredApp {
  /** Lock state key — service name or ADMIN_LOCK_KEY */
  key: string;
  /** Full hostname (e.g., "blog.example.com") */
  hostname: string;
}

// --- Constants ---

/** Lock state key for the implicit admin Access application */
export const ADMIN_LOCK_KEY = "__admin";

// --- Pagination helper ---

/**
 * Collects all items from a Cloudflare SDK paginated async iterable into an array.
 * Reusable by future sync steps.
 */
export async function collectPages<T>(
  iterable: AsyncIterable<unknown>,
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item as T);
  }
  return items;
}

// --- Access Application Sync ---

/**
 * Syncs Cloudflare Access self-hosted applications for all services requiring auth protection.
 *
 * - Lists existing Access applications in the account
 * - Creates applications for services with `admin_only` or `authorized` auth
 * - Always creates an application for the implicit `admin` subdomain
 * - Deletes applications for services removed from config or changed to `public`
 * - Stores application IDs in the lock state
 *
 * @returns List of managed applications for use by the policy sync step
 */
export async function syncAccessApplications(
  client: CloudflareClient,
  config: FlaregunConfig,
  accountId: string,
  lockState: LockState,
): Promise<ManagedApp[]> {
  // 1. Build the set of desired applications from current config
  const desired = buildDesiredApps(config);
  const desiredKeys = new Set(desired.map((d) => d.key));

  // 2. List all existing Access applications from Cloudflare
  const existingApps = await collectPages<{
    id?: string;
    name?: string;
    domain?: string;
    type?: string;
  }>(
    client.zeroTrust.access.applications.list({ account_id: accountId }),
  );

  // 3. For each desired application: match existing or create new
  const managedApps: ManagedApp[] = [];

  for (const app of desired) {
    const existing = existingApps.find((e) => e.domain === app.hostname);

    if (existing?.id) {
      // Application exists — reuse it instead of creating a duplicate.
      managedApps.push({
        id: existing.id,
        name: app.key,
        hostname: app.hostname,
      });
      // Only track it in the lock file if flaregun created it: the lock already
      // points at it and it still has the name flaregun gave it. Apps set up some
      // other way (e.g. by hand or from another machine) stay out of the lock, so
      // removing the service or running destroy never deletes them.
      const createdByFlaregun =
        existing.name === app.key &&
        lockState.access[app.key]?.app_id === existing.id;
      if (!createdByFlaregun) {
        delete lockState.access[app.key];
      }
    } else {
      // Create new self-hosted Access application
      const created = (await client.zeroTrust.access.applications.create({
        account_id: accountId,
        name: app.key,
        domain: app.hostname,
        type: "self_hosted",
      } as Parameters<typeof client.zeroTrust.access.applications.create>[0])) as {
        id?: string;
      };

      const appId = created.id!;
      managedApps.push({
        id: appId,
        name: app.key,
        hostname: app.hostname,
      });
      lockState.access[app.key] = { app_id: appId };
    }
  }

  // 4. Handle removals — delete stale applications tracked in lock file
  //    but no longer in the desired set
  for (const [key, entry] of Object.entries(lockState.access)) {
    if (!desiredKeys.has(key)) {
      await (
        client.zeroTrust.access.applications as unknown as {
          delete: (id: string, params: { account_id: string }) => Promise<void>;
        }
      ).delete(entry.app_id, { account_id: accountId });
      delete lockState.access[key];
    }
  }

  return managedApps;
}

/**
 * Builds the list of desired Access applications from the current config.
 * Includes all non-public services plus the implicit admin subdomain.
 */
function buildDesiredApps(config: FlaregunConfig): DesiredApp[] {
  const desired: DesiredApp[] = [];

  // Config services with non-public auth
  for (const [name, service] of Object.entries(config.services)) {
    if (service.auth === "public") continue;

    desired.push({
      key: name,
      hostname: `${service.subdomain}.${config.domain}`,
    });
  }

  // Implicit admin service — always present
  desired.push({
    key: ADMIN_LOCK_KEY,
    hostname: `admin.${config.domain}`,
  });

  return desired;
}

// --- Access Policy Sync ---

/**
 * Syncs Cloudflare Access policies for each managed application.
 *
 * - Creates a policy named after the lock key when the app doesn't have one, at a
 *   precedence above any policies already on the app
 * - Updates that policy when selectors have changed (detected via JSON comparison),
 *   keeping its precedence
 * - Leaves policies with other names alone
 * - Skips unchanged policies (idempotent)
 *
 * Policies for deleted applications are implicitly cleaned up when the application
 * is deleted (Cloudflare cascades policy deletion).
 */
export async function syncAccessPolicies(
  client: CloudflareClient,
  config: FlaregunConfig,
  accountId: string,
  managedApps: ManagedApp[],
): Promise<void> {
  for (const app of managedApps) {
    // Build the correct selectors for this app
    const selectors = buildSelectorsForApp(app, config);

    // List existing policies for this application
    const existingPolicies = await collectPages<{
      id?: string;
      name?: string;
      include?: unknown[];
      decision?: string;
      precedence?: number;
    }>(
      client.zeroTrust.access.applications.policies.list(app.id, {
        account_id: accountId,
      }),
    );

    const existingPolicy = existingPolicies.find((p) => p.name === app.name);

    if (!existingPolicy) {
      // Create new policy. Precedence must be unique within the app, and the app
      // may already carry policies flaregun didn't create, so go after them all.
      const highestPrecedence = Math.max(
        0,
        ...existingPolicies.map((p) => p.precedence ?? 0),
      );
      await client.zeroTrust.access.applications.policies.create(app.id, {
        account_id: accountId,
        decision: "allow",
        include: selectors,
        name: app.name,
        precedence: highestPrecedence + 1,
      } as Parameters<
        typeof client.zeroTrust.access.applications.policies.create
      >[1]);
    } else {
      // Check if selectors match
      const currentInclude = existingPolicy.include ?? [];
      if (!selectorsEqual(selectors, currentInclude as AccessSelector[])) {
        // Update policy with new selectors
        await client.zeroTrust.access.applications.policies.update(
          app.id,
          existingPolicy.id!,
          {
            account_id: accountId,
            decision: "allow",
            include: selectors,
            name: app.name,
            precedence: existingPolicy.precedence,
          } as Parameters<
            typeof client.zeroTrust.access.applications.policies.update
          >[2],
        );
      }
      // If selectors match, skip (idempotent)
    }
  }
}

/**
 * Builds the Access selectors for a managed application.
 * For the implicit admin, uses superusers only (admin_only auth).
 * For config services, delegates to buildServiceSelectors.
 */
function buildSelectorsForApp(
  app: ManagedApp,
  config: FlaregunConfig,
): AccessSelector[] {
  if (app.name === ADMIN_LOCK_KEY) {
    // Implicit admin: superusers only
    const adminService: ServiceConfig = {
      subdomain: "admin",
      type: "local",
      auth: "admin_only",
    };
    return buildServiceSelectors(adminService, config.auth.superusers);
  }

  // Config service: look up by name
  const service = config.services[app.name];
  if (!service) {
    // Safety fallback — shouldn't happen in normal operation
    const fallback: ServiceConfig = {
      subdomain: "",
      type: "local",
      auth: "admin_only",
    };
    return buildServiceSelectors(fallback, config.auth.superusers);
  }

  return buildServiceSelectors(service, config.auth.superusers);
}

/** Deep-compare two arrays of AccessSelectors to detect policy changes. */
function selectorsEqual(a: AccessSelector[], b: AccessSelector[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
