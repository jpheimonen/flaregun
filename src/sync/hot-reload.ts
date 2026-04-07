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
  const changes: string[] = [];
  const errors: string[] = [];
  let cloudflareModified = false;

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
    const service = newConfig.services[name];

    // Start local services via the supervisor
    if (service.type === "local") {
      try {
        const svcConfig: SupervisedServiceConfig = {
          name,
          command: service.command!,
          maxRetries: service.max_retries,
        };
        await supervisor.startService(svcConfig);
        changes.push(`Started service "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to start service "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Create Access app/policy for non-public services
    if (service.auth !== "public") {
      try {
        const managedApps = await syncAccessApplications(
          client,
          newConfig,
          deps.credentials.accountId,
          lockState,
        );
        await syncAccessPolicies(
          client,
          newConfig,
          deps.credentials.accountId,
          managedApps,
        );
        cloudflareModified = true;
        changes.push(`Created Access application for "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to create Access application for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Update tunnel ingress for local services
    if (service.type === "local") {
      try {
        await syncTunnelIngress(
          client,
          newConfig,
          deps.credentials.accountId,
          deps.credentials.tunnelId,
          deps.adminPort,
        );
        changes.push(`Updated tunnel ingress for added service "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to update tunnel ingress for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 5. Process removed services
  for (const name of diff.removed) {
    const oldService = oldConfig.services[name];

    // Stop local services
    if (oldService.type === "local") {
      try {
        await supervisor.stopService(name);
        changes.push(`Stopped service "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to stop service "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Delete Access app/policy for non-public services
    if (oldService.auth !== "public") {
      try {
        const managedApps = await syncAccessApplications(
          client,
          newConfig,
          deps.credentials.accountId,
          lockState,
        );
        await syncAccessPolicies(
          client,
          newConfig,
          deps.credentials.accountId,
          managedApps,
        );
        cloudflareModified = true;
        changes.push(`Deleted Access application for "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to delete Access application for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Update tunnel ingress for local services (removed service is automatically absent)
    if (oldService.type === "local") {
      try {
        await syncTunnelIngress(
          client,
          newConfig,
          deps.credentials.accountId,
          deps.credentials.tunnelId,
          deps.adminPort,
        );
        changes.push(`Updated tunnel ingress after removing "${name}"`);
      } catch (err) {
        errors.push(
          `Failed to update tunnel ingress after removing "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 6. Process modified services
  for (const [name, serviceDiff] of diff.modified) {
    const oldService = oldConfig.services[name];
    const newService = newConfig.services[name];

    // Handle runtime field changes
    await processServiceModification(
      name,
      oldService,
      newService,
      serviceDiff,
      client,
      newConfig,
      lockState,
      supervisor,
      deps,
      changes,
      errors,
      (flag: boolean) => {
        if (flag) cloudflareModified = true;
      },
    );
  }

  // 7. Handle global auth changes
  if (diff.globalAuthChanged) {
    // Check if identity provider changed (not programmatically actionable)
    if (oldConfig.auth.provider !== newConfig.auth.provider) {
      changes.push(
        `Identity provider changed from "${oldConfig.auth.provider}" to "${newConfig.auth.provider}" — update Cloudflare Access configuration in the portal manually`,
      );
    }

    // Check if superusers changed — update all non-public Access policies
    const oldSuperusers = oldConfig.auth.superusers;
    const newSuperusers = newConfig.auth.superusers;
    const superusersChanged =
      JSON.stringify(oldSuperusers) !== JSON.stringify(newSuperusers);

    if (superusersChanged) {
      try {
        const managedApps = await syncAccessApplications(
          client,
          newConfig,
          deps.credentials.accountId,
          lockState,
        );
        await syncAccessPolicies(
          client,
          newConfig,
          deps.credentials.accountId,
          managedApps,
        );
        cloudflareModified = true;
        changes.push("Updated all Access policies for superuser change");
      } catch (err) {
        errors.push(
          `Failed to update Access policies for superuser change: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 8. Save lock file if Cloudflare resources were modified
  if (cloudflareModified) {
    try {
      deps.saveLock(lockState);
      changes.push("Saved lock file");
    } catch (err) {
      errors.push(
        `Failed to save lock file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    success: errors.length === 0,
    errors,
    changes,
  };
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
  client: CloudflareClient,
  newConfig: FlaregunConfig,
  lockState: LockState,
  supervisor: Supervisor,
  deps: HotReloadDeps,
  changes: string[],
  errors: string[],
  setCloudflareModified: (flag: boolean) => void,
): Promise<void> {
  const runtimeFields = new Set(serviceDiff.runtime);

  // Pages-only changes — explicitly skip (no-op)
  if (serviceDiff.pagesOnly.length > 0 && serviceDiff.runtime.length === 0) {
    changes.push(
      `Service "${name}" has Pages-only changes (${serviceDiff.pagesOnly.join(", ")}) — no runtime action needed`,
    );
    return;
  }

  // If there are pages-only fields alongside runtime fields, note them
  if (serviceDiff.pagesOnly.length > 0) {
    changes.push(
      `Service "${name}" has Pages-only changes (${serviceDiff.pagesOnly.join(", ")}) — skipped (runtime changes applied separately)`,
    );
  }

  // Port changed (local service) — restart + update ingress
  const portChanged = runtimeFields.has("port");
  // Command changed (local service) — restart
  const commandChanged = runtimeFields.has("command");
  // Auth changed
  const authChanged = runtimeFields.has("auth");
  // Users changed
  const usersChanged = runtimeFields.has("users");
  // max_retries changed
  const maxRetriesChanged = runtimeFields.has("max_retries");

  // Handle port or command changes — restart the service
  if ((portChanged || commandChanged) && newService.type === "local") {
    try {
      // Update the supervisor config and restart
      const svcConfig: SupervisedServiceConfig = {
        name,
        command: newService.command!,
        maxRetries: newService.max_retries,
      };
      // Stop the old instance first, then start with new config
      await supervisor.stopService(name);
      await supervisor.startService(svcConfig);
      if (portChanged && commandChanged) {
        changes.push(`Restarted service "${name}" (port and command changed)`);
      } else if (portChanged) {
        changes.push(`Restarted service "${name}" (port changed)`);
      } else {
        changes.push(`Restarted service "${name}" (command changed)`);
      }
    } catch (err) {
      errors.push(
        `Failed to restart service "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Update tunnel ingress if port changed
    if (portChanged) {
      try {
        await syncTunnelIngress(
          client,
          newConfig,
          deps.credentials.accountId,
          deps.credentials.tunnelId,
          deps.adminPort,
        );
        changes.push(`Updated tunnel ingress for "${name}" (port changed)`);
      } catch (err) {
        errors.push(
          `Failed to update tunnel ingress for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Handle auth changes
  if (authChanged) {
    const oldAuth = oldService.auth;
    const newAuth = newService.auth;

    try {
      const managedApps = await syncAccessApplications(
        client,
        newConfig,
        deps.credentials.accountId,
        lockState,
      );
      await syncAccessPolicies(
        client,
        newConfig,
        deps.credentials.accountId,
        managedApps,
      );
      setCloudflareModified(true);

      if (oldAuth === "public" && newAuth !== "public") {
        changes.push(
          `Created Access application for "${name}" (auth changed from public to ${newAuth})`,
        );
      } else if (oldAuth !== "public" && newAuth === "public") {
        changes.push(
          `Deleted Access application for "${name}" (auth changed from ${oldAuth} to public)`,
        );
      } else {
        changes.push(
          `Updated Access policy for "${name}" (auth changed from ${oldAuth} to ${newAuth})`,
        );
      }
    } catch (err) {
      errors.push(
        `Failed to update Access for "${name}" auth change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Handle users list changes (without auth mode change)
  if (usersChanged && !authChanged) {
    try {
      const managedApps = await syncAccessApplications(
        client,
        newConfig,
        deps.credentials.accountId,
        lockState,
      );
      await syncAccessPolicies(
        client,
        newConfig,
        deps.credentials.accountId,
        managedApps,
      );
      setCloudflareModified(true);
      changes.push(`Updated Access policy for "${name}" (users list changed)`);
    } catch (err) {
      errors.push(
        `Failed to update Access policy for "${name}" users change: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Handle max_retries changes (no restart needed — new limit takes effect on next crash)
  if (maxRetriesChanged && !portChanged && !commandChanged && newService.type === "local") {
    changes.push(
      `Updated max_retries for "${name}" to ${newService.max_retries ?? "unlimited"} (takes effect on next crash)`,
    );
  }
}
