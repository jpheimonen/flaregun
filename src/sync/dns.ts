/**
 * Sync engine: DNS record management.
 *
 * Ensures all required CNAME DNS records exist for the current config:
 * - Wildcard CNAME (*.domain → tunnelId.cfargotunnel.com) for tunnel routing
 * - Per-Pages-service CNAME (subdomain.domain → project.pages.dev) for custom domains
 * - www CNAME (www.domain → primary Pages project.pages.dev)
 *
 * Handles removal of DNS records for Pages services no longer in config.
 * All records use proxied: true and ttl: 1 (automatic).
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig } from "../config/index.js";
import { collectPages } from "./access.js";
import { resourceName } from "../naming.js";

/** Shape of a DNS record from the Cloudflare API. */
interface DnsRecord {
  id?: string;
  name: string;
  type: string;
  content?: string;
}

/** A desired CNAME record derived from config. */
interface DesiredCname {
  name: string;
  content: string;
  /** The service name this record belongs to (null for wildcard/www) */
  serviceName: string | null;
}

/**
 * Syncs DNS records for the current config.
 *
 * - Creates/skips wildcard CNAME for tunnel routing
 * - Creates/skips per-Pages-service CNAMEs for custom subdomain attachment
 * - Creates/updates www CNAME to the appropriate Pages project
 * - Deletes CNAME records for Pages services removed from config
 *
 * @param client - Cloudflare SDK client
 * @param config - Parsed flaregun config
 * @param zoneId - Cloudflare zone ID
 * @param tunnelId - Cloudflare tunnel ID
 */
export async function syncDnsRecords(
  client: CloudflareClient,
  config: FlaregunConfig,
  zoneId: string,
  tunnelId: string,
): Promise<void> {
  // 1. List all existing CNAME records in the zone
  const existingRecords = await collectPages<DnsRecord>(
    client.dns.records.list({ zone_id: zoneId, type: "CNAME" }),
  );

  // 2. Build the set of desired CNAME records
  const desired = buildDesiredCnames(config, tunnelId);

  // 3. Reconcile: create, update, or skip each desired record
  for (const want of desired) {
    const existing = existingRecords.find(
      (r) => r.name === want.name && r.type === "CNAME",
    );

    if (existing && existing.content === want.content) {
      // Already exists with correct content — skip
      continue;
    }

    if (existing) {
      // Exists but with different content — update in place
      await client.dns.records.update(existing.id!, {
        zone_id: zoneId,
        name: want.name,
        type: "CNAME",
        content: want.content,
        ttl: 1,
        proxied: true,
      });
    } else {
      // Does not exist — create
      await client.dns.records.create({
        zone_id: zoneId,
        name: want.name,
        type: "CNAME",
        content: want.content,
        ttl: 1,
        proxied: true,
      });
    }
  }

  // 4. Handle removals: delete per-service CNAME records for removed Pages services
  //    A record is considered a stale managed record if:
  //    - It's a CNAME pointing to *.pages.dev (created by flaregun for a Pages service)
  //    - It's not the wildcard record (*.domain) or www record (www.domain)
  //    - It's not in the current desired set
  const desiredNames = new Set(desired.map((d) => d.name));
  const wildcardName = `*.${config.domain}`;
  const wwwName = `www.${config.domain}`;

  for (const existing of existingRecords) {
    if (existing.type !== "CNAME") continue;
    if (existing.name === wildcardName || existing.name === wwwName) continue;
    if (desiredNames.has(existing.name)) continue;

    // Only delete records that look like they were managed by flaregun
    // (pointing to a *.pages.dev target)
    if (existing.content?.endsWith(".pages.dev")) {
      await (
        client.dns.records as unknown as {
          delete: (id: string, params: { zone_id: string }) => Promise<void>;
        }
      ).delete(existing.id!, { zone_id: zoneId });
    }
  }
}

/**
 * Builds the full set of desired CNAME records from the config.
 */
function buildDesiredCnames(
  config: FlaregunConfig,
  tunnelId: string,
): DesiredCname[] {
  const desired: DesiredCname[] = [];

  // Wildcard CNAME: *.domain → tunnelId.cfargotunnel.com
  desired.push({
    name: `*.${config.domain}`,
    content: `${tunnelId}.cfargotunnel.com`,
    serviceName: null,
  });

  // Per-Pages-service CNAMEs
  for (const [name, service] of Object.entries(config.services)) {
    if (service.type !== "pages") continue;

    const projectName = resourceName(config.domain, name);
    desired.push({
      name: `${service.subdomain}.${config.domain}`,
      content: `${projectName}.pages.dev`,
      serviceName: name,
    });
  }

  // www CNAME: points to the first Pages service found (or first service overall)
  // The www record points to whichever Pages project serves the www subdomain
  const wwwService = findWwwPagesService(config);
  if (wwwService) {
    const projectName = resourceName(config.domain, wwwService);
    desired.push({
      name: `www.${config.domain}`,
      content: `${projectName}.pages.dev`,
      serviceName: null,
    });
  }

  return desired;
}

/**
 * Finds the Pages service that should serve the www subdomain.
 * Looks for a service with subdomain "www" first, then falls back to the first Pages service.
 * Returns the service name (key) or null if no Pages services exist.
 */
function findWwwPagesService(config: FlaregunConfig): string | null {
  // First: look for a Pages service with subdomain "www"
  for (const [name, service] of Object.entries(config.services)) {
    if (service.type === "pages" && service.subdomain === "www") {
      return name;
    }
  }

  // Fallback: first Pages service alphabetically
  const pagesServices = Object.entries(config.services)
    .filter(([, s]) => s.type === "pages")
    .sort(([a], [b]) => a.localeCompare(b));

  return pagesServices.length > 0 ? pagesServices[0][0] : null;
}

