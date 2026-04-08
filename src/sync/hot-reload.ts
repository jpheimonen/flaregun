/**
 * Hot-reload engine.
 *
 * Accepts old and new parsed configs, computes the diff, and applies the
 * appropriate actions — starting/stopping services, updating Access policies,
 * refreshing tunnel ingress — without interrupting unaffected services.
 *
 * Resilient by design: a failure in one action does not prevent other actions
 * from being applied. The engine collects errors and returns them so the admin
 * UI can report which changes succeeded and which failed.
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig, ServiceDiff } from "../config/index.js";
import { diffConfigs } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import type { Supervisor, SupervisedServiceConfig } from "../process/supervisor.js";
import type { IHotReloadEngine, HotReloadResult } from "../admin/types.js";
import { syncAccessApplications, syncAccessPolicies } from "./access.js";
import { syncTunnelIngress } from "./ingress.js";
import type { SaveLockFn } from "./index.js";
import type { SyncCredentials } from "./index.js";

// --- Types ---

/** Dependencies injected into the hot-reload engine */
export interface HotReloadDeps {
  /** Cloudflare credentials (account ID, zone ID, tunnel ID) */
  credentials: SyncCredentials;
  /** Callback to persist the lock file to disk */
  saveLock: SaveLockFn;
  /** Port the admin backend is listening on (for ingress rules) */
  adminPort: number;
}

/** Mutable context passed through hot-reload operations to collect results */
interface ReloadContext {
  client: CloudflareClient;
  newConfig: FlaregunConfig;
  lockState: LockState;
  supervisor: Supervisor;
  deps: HotReloadDeps;
  changes: string[];
  errors: string[];
  cloudflareModified: boolean;
}

// --- Hot-Reload Engine ---

/**
 * Creates a hot-reload engine that implements IHotReloadEngine.
 *
 * The engine is configured with persistent dependencies (credentials, lock save
 * callback, admin port) at construction time. The per-reload dependencies (client,
 * lockState, supervisor) are passed to each `reload()` call.
 */
export function createHotReloadEngine(deps: HotReloadDeps): IHotReloadEngine {
  return {
    async reload(
      oldConfig: FlaregunConfig,
      newConfig: FlaregunConfig,
      client: CloudflareClient,
      lockState: LockState,
      supervisor: Supervisor,
    ): Promise<HotReloadResult> {
      return applyHotReload(
        oldConfig,
        newConfig,
        client,
        lockState,
        supervisor,
        deps,
      );
    },
  };
}

// --- Shared Helpers ---

/**
 * Runs the full Access sync (applications + policies) and records the outcome.
 *
 * This is the single point of truth for the "sync Access apps and policies"
 * pattern that recurs throughout the hot-reload engine. On success, records
 * a change message and marks Cloudflare as modified. On failure, records
 * an error message without interrupting other operations.
 */
async function syncAccessWithErrorHandling(
  ctx: ReloadContext,
  successMessage: string,
  failurePrefix: string,
): Promise<void> {
  try {
    const managedApps = await syncAccessApplications(
      ctx.client,
      ctx.newConfig,
      ctx.deps.credentials.accountId,
      ctx.lockState,
    );
    await syncAccessPolicies(
      ctx.client,
      ctx.newConfig,
      ctx.deps.credentials.accountId,
      managedApps,
    );
    ctx.cloudflareModified = true;
    ctx.changes.push(successMessage);
  } catch (err) {
    ctx.errors.push(
      `${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Pushes updated tunnel ingress configuration and records the outcome.
 */
async function syncIngressWithErrorHandling(
  ctx: ReloadContext,
  successMessage: string,
  failurePrefix: string,
): Promise<void> {
  try {
    await syncTunnelIngress(
      ctx.client,
      ctx.newConfig,
      ctx.deps.credentials.accountId,
      ctx.deps.credentials.tunnelId,
      ctx.deps.adminPort,
    );
    ctx.changes.push(successMessage);
  } catch (err) {
    ctx.errors.push(
      `${failurePrefix}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// --- Core Logic ---

/**
 * Core hot-reload logic. Computes the diff and applies all necessary changes.
 *
 * This function never throws — all errors are captured in the result object.
 */
async function applyHotReload(
  oldConfig: FlaregunConfig,
  newConfig: FlaregunConfig,
  client: CloudflareClient,
  lockState: LockState,
  supervisor: Supervisor,
  deps: HotReloadDeps,
): Promise<HotReloadResult> {
  const ctx: ReloadContext = {
    client,
    newConfig,
    lockState,
    supervisor,
    deps,
    changes: [],
    errors: [],
    cloudflareModified: false,
  };

  // 1. Check for domain change — not supported via hot-reload (must be checked first)
  if (oldConfig.domain !== newConfig.domain) {
    return {
      success: false,
      errors: [
        "Domain change detected: cannot change domain via hot-reload. Stop flaregun, update the config, and restart for a full re-sync.",
      ],
      changes: [],
    };
  }

  // 2. Compute the diff
  const diff = diffConfigs(oldConfig, newConfig);

  // 3. Check for empty diff — no changes needed
  if (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.modified.size === 0 &&
    !diff.globalAuthChanged
  ) {
    return { success: true, errors: [], changes: [] };
  }

  // 4. Process added services
  for (const name of diff.added) {
    await processAddedService(name, ctx);
  }

  // 5. Process removed services
  for (const name of diff.removed) {
    await processRemovedService(name, oldConfig, ctx);
  }

  // 6. Process modified services
  for (const [name, serviceDiff] of diff.modified) {
    const oldService = oldConfig.services[name];
    const newService = newConfig.services[name];
    await processServiceModification(name, oldService, newService, serviceDiff, ctx);
  }

  // 7. Handle global auth changes
  if (diff.globalAuthChanged) {
    await processGlobalAuthChange(oldConfig, newConfig, ctx);
  }

  // 8. Save lock file if Cloudflare resources were modified
  if (ctx.cloudflareModified) {
    try {
      deps.saveLock(lockState);
      ctx.changes.push("Saved lock file");
    } catch (err) {
      ctx.errors.push(
        `Failed to save lock file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    success: ctx.errors.length === 0,
    errors: ctx.errors,
    changes: ctx.changes,
  };
}

// --- Per-change processors ---

/** Handles a newly added service: start local process, create Access app, update ingress. */
async function processAddedService(
  name: string,
  ctx: ReloadContext,
): Promise<void> {
  const service = ctx.newConfig.services[name];

  // Start local services via the supervisor
  if (service.type === "local") {
    try {
      const svcConfig: SupervisedServiceConfig = {
        name,
        command: service.command!,
        maxRetries: service.max_retries,
      };
      await ctx.supervisor.startService(svcConfig);
      ctx.changes.push(`Started service "${name}"`);
    } catch (err) {
      ctx.errors.push(
        `Failed to start service "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Create Access app/policy for non-public services
  if (service.auth !== "public") {
    await syncAccessWithErrorHandling(
      ctx,
      `Created Access application for "${name}"`,
      `Failed to create Access application for "${name}"`,
    );
  }

  // Update tunnel ingress for local services
  if (service.type === "local") {
    await syncIngressWithErrorHandling(
      ctx,
      `Updated tunnel ingress for added service "${name}"`,
      `Failed to update tunnel ingress for "${name}"`,
    );
  }
}

/** Handles a removed service: stop local process, delete Access app, update ingress. */
async function processRemovedService(
  name: string,
  oldConfig: FlaregunConfig,
  ctx: ReloadContext,
): Promise<void> {
  const oldService = oldConfig.services[name];

  // Stop local services
  if (oldService.type === "local") {
    try {
      await ctx.supervisor.stopService(name);
      ctx.changes.push(`Stopped service "${name}"`);
    } catch (err) {
      ctx.errors.push(
        `Failed to stop service "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Delete Access app/policy for non-public services
  if (oldService.auth !== "public") {
    await syncAccessWithErrorHandling(
      ctx,
      `Deleted Access application for "${name}"`,
      `Failed to delete Access application for "${name}"`,
    );
  }

  // Update tunnel ingress for local services (removed service is automatically absent)
  if (oldService.type === "local") {
    await syncIngressWithErrorHandling(
      ctx,
      `Updated tunnel ingress after removing "${name}"`,
      `Failed to update tunnel ingress after removing "${name}"`,
    );
  }
}

/**
 * Processes modifications for a single service based on its diff.
 * Handles port changes, command changes, auth changes, users changes,
 * max_retries changes, and pages-only changes.
 */
async function processServiceModification(
  name: string,
  oldService: FlaregunConfig["services"][string],
  newService: FlaregunConfig["services"][string],
  serviceDiff: ServiceDiff,
  ctx: ReloadContext,
): Promise<void> {
  const runtimeFields = new Set(serviceDiff.runtime);

  // Pages-only changes — explicitly skip (no-op)
  if (serviceDiff.pagesOnly.length > 0 && serviceDiff.runtime.length === 0) {
    ctx.changes.push(
      `Service "${name}" has Pages-only changes (${serviceDiff.pagesOnly.join(", ")}) — no runtime action needed`,
    );
    return;
  }

  // If there are pages-only fields alongside runtime fields, note them
  if (serviceDiff.pagesOnly.length > 0) {
    ctx.changes.push(
      `Service "${name}" has Pages-only changes (${serviceDiff.pagesOnly.join(", ")}) — skipped (runtime changes applied separately)`,
    );
  }

  const portChanged = runtimeFields.has("port");
  const commandChanged = runtimeFields.has("command");
  const authChanged = runtimeFields.has("auth");
  const usersChanged = runtimeFields.has("users");
  const maxRetriesChanged = runtimeFields.has("max_retries");

  // Handle port or command changes — restart the service
  if ((portChanged || commandChanged) && newService.type === "local") {
    try {
      const svcConfig: SupervisedServiceConfig = {
        name,
        command: newService.command!,
        maxRetries: newService.max_retries,
      };
      await ctx.supervisor.stopService(name);
      await ctx.supervisor.startService(svcConfig);
      if (portChanged && commandChanged) {
        ctx.changes.push(`Restarted service "${name}" (port and command changed)`);
      } else if (portChanged) {
        ctx.changes.push(`Restarted service "${name}" (port changed)`);
      } else {
        ctx.changes.push(`Restarted service "${name}" (command changed)`);
      }
    } catch (err) {
      ctx.errors.push(
        `Failed to restart service "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Update tunnel ingress if port changed
    if (portChanged) {
      await syncIngressWithErrorHandling(
        ctx,
        `Updated tunnel ingress for "${name}" (port changed)`,
        `Failed to update tunnel ingress for "${name}"`,
      );
    }
  }

  // Handle auth changes
  if (authChanged) {
    const oldAuth = oldService.auth;
    const newAuth = newService.auth;

    let changeDescription: string;
    if (oldAuth === "public" && newAuth !== "public") {
      changeDescription = `Created Access application for "${name}" (auth changed from public to ${newAuth})`;
    } else if (oldAuth !== "public" && newAuth === "public") {
      changeDescription = `Deleted Access application for "${name}" (auth changed from ${oldAuth} to public)`;
    } else {
      changeDescription = `Updated Access policy for "${name}" (auth changed from ${oldAuth} to ${newAuth})`;
    }

    await syncAccessWithErrorHandling(
      ctx,
      changeDescription,
      `Failed to update Access for "${name}" auth change`,
    );
  }

  // Handle users list changes (without auth mode change)
  if (usersChanged && !authChanged) {
    await syncAccessWithErrorHandling(
      ctx,
      `Updated Access policy for "${name}" (users list changed)`,
      `Failed to update Access policy for "${name}" users change`,
    );
  }

  // Handle max_retries changes (no restart needed — new limit takes effect on next crash)
  if (maxRetriesChanged && !portChanged && !commandChanged && newService.type === "local") {
    ctx.changes.push(
      `Updated max_retries for "${name}" to ${newService.max_retries ?? "unlimited"} (takes effect on next crash)`,
    );
  }
}

/** Handles changes to the global auth section (provider and superusers). */
async function processGlobalAuthChange(
  oldConfig: FlaregunConfig,
  newConfig: FlaregunConfig,
  ctx: ReloadContext,
): Promise<void> {
  // Check if identity provider changed (not programmatically actionable)
  if (oldConfig.auth.provider !== newConfig.auth.provider) {
    ctx.changes.push(
      `Identity provider changed from "${oldConfig.auth.provider}" to "${newConfig.auth.provider}" — update Cloudflare Access configuration in the portal manually`,
    );
  }

  // Check if superusers changed — update all non-public Access policies
  const superusersChanged =
    JSON.stringify(oldConfig.auth.superusers) !== JSON.stringify(newConfig.auth.superusers);

  if (superusersChanged) {
    await syncAccessWithErrorHandling(
      ctx,
      "Updated all Access policies for superuser change",
      "Failed to update Access policies for superuser change",
    );
  }
}
