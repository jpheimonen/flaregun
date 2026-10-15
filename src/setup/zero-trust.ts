/**
 * Zero Trust setup through the API: the Access organization (team domain) and
 * at least one login method, so Access can protect services.
 */

import type { CloudflareClient } from "../cloudflare/index.js";

export interface Organization {
  name: string;
  authDomain: string;
}

/** Returns the account's Zero Trust organization, or null if it has none yet. */
export async function getOrganization(
  client: CloudflareClient,
  accountId: string,
): Promise<Organization | null> {
  try {
    const org = (await client.zeroTrust.organizations.list({ account_id: accountId })) as {
      name?: string;
      auth_domain?: string;
    };
    if (!org?.auth_domain) return null;
    return { name: org.name ?? "", authDomain: org.auth_domain };
  } catch {
    return null;
  }
}

/** Team names to try, from the most to the least readable. Team names are global. */
export function teamNameCandidates(domain: string, random: () => string = randomSuffix): string[] {
  const label = domain.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const full = domain.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const candidates = [label, full, `${full}-${random()}`];
  return [...new Set(candidates)];
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/**
 * Creates the Zero Trust organization. Tries a few team names because they are
 * shared across all Cloudflare customers. Throws the last error if none work.
 */
export async function createOrganization(
  client: CloudflareClient,
  accountId: string,
  domain: string,
): Promise<Organization> {
  let lastError: unknown;
  for (const team of teamNameCandidates(domain)) {
    const authDomain = `${team}.cloudflareaccess.com`;
    try {
      await client.zeroTrust.organizations.create({
        account_id: accountId,
        name: team,
        auth_domain: authDomain,
      });
      return { name: team, authDomain };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export interface LoginMethod {
  type: string;
  created: boolean;
}

/**
 * Makes sure the account has a login method for Access. Uses the first one that
 * exists; otherwise adds One-time PIN, which emails a code and needs no outside
 * identity provider.
 */
export async function ensureLoginMethod(
  client: CloudflareClient,
  accountId: string,
): Promise<LoginMethod> {
  const existing: Array<{ type?: string }> = [];
  for await (const idp of client.zeroTrust.identityProviders.list({ account_id: accountId })) {
    existing.push(idp as { type?: string });
  }
  const first = existing.find((idp) => idp.type);
  if (first?.type) return { type: first.type, created: false };

  await client.zeroTrust.identityProviders.create({
    account_id: accountId,
    name: "One-time PIN",
    type: "onetimepin",
    config: {},
  } as Parameters<typeof client.zeroTrust.identityProviders.create>[0]);
  return { type: "onetimepin", created: true };
}
