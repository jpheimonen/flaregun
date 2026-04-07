/**
 * Sync engine: Tunnel ingress configuration.
 *
 * Pushes a complete set of tunnel ingress rules derived from the current config.
 * The entire ingress array is rebuilt from scratch each time and pushed as a full
 * replacement — removed services are implicitly absent from the next push.
 *
 * Local services map subdomain.domain → http://localhost:port. An implicit admin
 * rule is always added. Pages services are excluded (served by Cloudflare Pages,
 * not the tunnel).
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig } from "../config/index.js";

/** A single tunnel ingress rule. */
export interface IngressRule {
  hostname: string;
  service: string;
}

/**
 * Syncs the tunnel ingress configuration by pushing a complete replacement.
 *
 * - Builds an ingress rule for every local service: subdomain.domain → http://localhost:port
 * - Adds an implicit admin rule: admin.domain → http://localhost:adminPort
 * - Excludes Pages services (they are served by Cloudflare Pages via custom domains)
 * - Sorts all rules alphabetically by hostname for deterministic ordering
 * - Appends a catch-all 404 rule as the last entry
 * - Pushes the entire set via configurations.update (full replacement)
 *
 * @param client - Cloudflare SDK client
 * @param config - Parsed flaregun config
 * @param accountId - Cloudflare account ID
 * @param tunnelId - Cloudflare tunnel ID
 * @param adminPort - Port for the implicit admin backend
 */
export async function syncTunnelIngress(
  client: CloudflareClient,
  config: FlaregunConfig,
  accountId: string,
  tunnelId: string,
  adminPort: number,
): Promise<void> {
  // Build ingress rules for local services only (not Pages)
  const ingressRules: IngressRule[] = [];

  for (const [, service] of Object.entries(config.services)) {
    if (service.type === "pages") continue; // Pages services use Cloudflare Pages, not the tunnel

    ingressRules.push({
      hostname: `${service.subdomain}.${config.domain}`,
      service: `http://localhost:${service.port}`,
    });
  }

  // Add implicit admin ingress rule
  ingressRules.push({
    hostname: `admin.${config.domain}`,
    service: `http://localhost:${adminPort}`,
  });

  // Sort alphabetically by hostname for deterministic ordering
  ingressRules.sort((a, b) => a.hostname.localeCompare(b.hostname));

  // Append catch-all 404 rule (always last)
  const fullIngress = [
    ...ingressRules,
    { hostname: "", service: "http_status:404" },
  ];

  // Push the entire ingress configuration as a full replacement
  await client.zeroTrust.tunnels.cloudflared.configurations.update(tunnelId, {
    account_id: accountId,
    config: {
      ingress: fullIngress,
    },
  });
}
