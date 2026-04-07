/**
 * Full sync orchestrator.
 *
 * Runs all five sync steps in the correct dependency order:
 * 1. Access applications — returns managed apps for the policy step
 * 2. Access policies — uses managed apps from step 1
 * 3. Tunnel ingress — uses the tunnel ID from credentials
 * 4. DNS records — uses zone ID and tunnel ID from credentials
 * 5. Redirect rules — uses zone ID from credentials (non-fatal on failure)
 *
 * After each step that mutates Cloudflare state, the lock file is saved to persist
 * any new resource IDs.
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig } from "../config/index.js";
import type { LockState } from "../lock/index.js";
import { syncAccessApplications, syncAccessPolicies } from "./access.js";
import { syncTunnelIngress } from "./ingress.js";
import { syncDnsRecords } from "./dns.js";
import { syncRedirectRule } from "./redirects.js";

// --- Types ---

/** Credentials required by the sync orchestrator */
export interface SyncCredentials {
  accountId: string;
  zoneId: string;
  tunnelId: string;
}

/** Result of a single sync step */
export interface StepResult {
  step: string;
  success: boolean;
  error?: string;
}

/** Result of the full sync operation */
export interface SyncResult {
  steps: StepResult[];
}

/** Callback to save the lock file after each mutating step */
export type SaveLockFn = (state: LockState) => void;

// --- Full Sync ---

/**
 * Runs all five sync steps in the correct dependency order.
 *
 * @param client - Cloudflare SDK client
 * @param config - Parsed flaregun config
 * @param credentials - Account ID, zone ID, and tunnel ID
 * @param lockState - Current lock file state (modified in place)
 * @param saveLock - Callback to persist the lock file after each mutating step
 * @param adminPort - Port for the implicit admin backend
 * @returns Summary of which steps were executed and whether each succeeded
 */
export async function syncFull(
  client: CloudflareClient,
  config: FlaregunConfig,
  credentials: SyncCredentials,
  lockState: LockState,
  saveLock: SaveLockFn,
  adminPort: number,
): Promise<SyncResult> {
  const steps: StepResult[] = [];

  // Step 1: Access Applications
  let managedApps;
  try {
    managedApps = await syncAccessApplications(
      client,
      config,
      credentials.accountId,
      lockState,
    );
    saveLock(lockState);
    steps.push({ step: "access-applications", success: true });
  } catch (err) {
    steps.push({
      step: "access-applications",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return { steps };
  }

  // Step 2: Access Policies
  try {
    await syncAccessPolicies(
      client,
      config,
      credentials.accountId,
      managedApps,
    );
    saveLock(lockState);
    steps.push({ step: "access-policies", success: true });
  } catch (err) {
    steps.push({
      step: "access-policies",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return { steps };
  }

  // Step 3: Tunnel Ingress
  try {
    await syncTunnelIngress(
      client,
      config,
      credentials.accountId,
      credentials.tunnelId,
      adminPort,
    );
    saveLock(lockState);
    steps.push({ step: "tunnel-ingress", success: true });
  } catch (err) {
    steps.push({
      step: "tunnel-ingress",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return { steps };
  }

  // Step 4: DNS Records
  try {
    await syncDnsRecords(
      client,
      config,
      credentials.zoneId,
      credentials.tunnelId,
    );
    saveLock(lockState);
    steps.push({ step: "dns-records", success: true });
  } catch (err) {
    steps.push({
      step: "dns-records",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return { steps };
  }

  // Step 5: Redirect Rules (non-fatal — zone rulesets permission may not be granted)
  try {
    await syncRedirectRule(client, config, credentials.zoneId);
    saveLock(lockState);
    steps.push({ step: "redirect-rules", success: true });
  } catch (err) {
    steps.push({
      step: "redirect-rules",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal: continue without failing the full sync
  }

  return { steps };
}
