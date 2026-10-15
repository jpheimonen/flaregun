/**
 * Creates flaregun's own Cloudflare API token through the API.
 *
 * The person (or flaregun, driving their browser) creates a short-lived token
 * from Cloudflare's "Create Additional Tokens" template. Flaregun uses it to
 * create a token with exactly the permissions below, then deletes it. That
 * avoids asking the person to pick a dozen permissions by hand.
 */

import { hostname } from "os";
import type { CloudflareClient } from "../cloudflare/index.js";

/** A permission flaregun asks for, with the reason shown to the person. */
export interface WantedPermission {
  /** Permission group names without the Read/Write suffix; the first match wins. */
  names: string[];
  level: "Read" | "Write";
  why: string;
}

export const WANTED_PERMISSIONS: WantedPermission[] = [
  { names: ["Cloudflare Tunnel", "Argo Tunnel"], level: "Write", why: "create and configure tunnels" },
  { names: ["Access: Apps and Policies"], level: "Write", why: "protect services with Cloudflare Access" },
  {
    names: ["Access: Organizations, Identity Providers, and Groups"],
    level: "Write",
    why: "set up Zero Trust and its login method",
  },
  { names: ["Account Settings"], level: "Read", why: "find your account" },
  { names: ["Zone"], level: "Read", why: "find your domain" },
  { names: ["DNS"], level: "Write", why: "point subdomains at the tunnel" },
  { names: ["Single Redirect", "Dynamic URL Redirects"], level: "Write", why: "redirect the bare domain to www" },
  { names: ["Cloudflare Pages", "Pages"], level: "Write", why: "deploy static sites" },
  { names: ["Workers Scripts"], level: "Write", why: "deploy the fallback Worker" },
  { names: ["Workers Routes"], level: "Write", why: "route the domain to the fallback Worker" },
  { names: ["D1"], level: "Write", why: "create D1 databases" },
  { names: ["Workers R2 Storage"], level: "Write", why: "create R2 buckets" },
  { names: ["Workers KV Storage"], level: "Write", why: "create KV namespaces" },
  { names: ["User Details"], level: "Read", why: "read your email for the admin list" },
  { names: ["Memberships"], level: "Read", why: "list your accounts" },
];

export interface PermissionGroup {
  id: string;
  name: string;
  scopes?: string[];
}

const ACCOUNT_SCOPE = "com.cloudflare.api.account";
const ZONE_SCOPE = "com.cloudflare.api.account.zone";
const USER_SCOPE = "com.cloudflare.api.user";

type Scope = typeof ACCOUNT_SCOPE | typeof ZONE_SCOPE | typeof USER_SCOPE;

export interface SelectedPermission {
  group: PermissionGroup;
  want: WantedPermission;
}

export interface SelectedPermissions {
  byScope: Map<Scope, SelectedPermission[]>;
  /** Wanted permissions Cloudflare doesn't offer under any known name. */
  missing: WantedPermission[];
}

/**
 * Matches wanted permissions to Cloudflare's permission groups by name and
 * sorts them by the resource type they apply to. The API names edit
 * permissions "... Write"; the dashboard shows "... Edit", so both match.
 */
export function selectPermissionGroups(groups: PermissionGroup[]): SelectedPermissions {
  const byName = new Map(groups.map((g) => [g.name.toLowerCase(), g]));
  const byScope = new Map<Scope, SelectedPermission[]>();
  const missing: WantedPermission[] = [];

  for (const want of WANTED_PERMISSIONS) {
    const suffixes = want.level === "Write" ? ["Write", "Edit"] : ["Read"];
    let group: PermissionGroup | undefined;
    for (const name of want.names) {
      for (const suffix of suffixes) {
        group ??= byName.get(`${name} ${suffix}`.toLowerCase());
      }
    }
    const scope = group && scopeOf(group);
    if (!group || !scope) {
      missing.push(want);
      continue;
    }
    byScope.set(scope, [...(byScope.get(scope) ?? []), { group, want }]);
  }

  return { byScope, missing };
}

function scopeOf(group: PermissionGroup): Scope | null {
  const scopes = group.scopes ?? [];
  // Zone groups also list the account scope on some groups; prefer the narrowest.
  if (scopes.includes(ZONE_SCOPE)) return ZONE_SCOPE;
  if (scopes.includes(ACCOUNT_SCOPE)) return ACCOUNT_SCOPE;
  if (scopes.includes(USER_SCOPE)) return USER_SCOPE;
  return null;
}

/**
 * Builds token policies: account permissions on all the person's accounts,
 * zone permissions on all their zones, and user permissions on themselves.
 * User permissions are left out when the user ID isn't known.
 */
export function buildPolicies(
  selected: SelectedPermissions,
  userId: string | null,
): Array<{ effect: "allow"; resources: Record<string, string>; permission_groups: Array<{ id: string }> }> {
  const resources: Record<Scope, Record<string, string> | null> = {
    [ACCOUNT_SCOPE]: { "com.cloudflare.api.account.*": "*" },
    [ZONE_SCOPE]: { "com.cloudflare.api.account.zone.*": "*" },
    [USER_SCOPE]: userId ? { [`com.cloudflare.api.user.${userId}`]: "*" } : null,
  };

  const policies = [];
  for (const [scope, chosen] of selected.byScope) {
    const scopeResources = resources[scope];
    if (!scopeResources || chosen.length === 0) continue;
    policies.push({
      effect: "allow" as const,
      resources: scopeResources,
      permission_groups: chosen.map(({ group }) => ({ id: group.id })),
    });
  }
  return policies;
}

/** What flaregun learned about a pasted or captured token. */
export interface TokenInfo {
  id: string;
  /** True when the token can create other tokens (a "Create Additional Tokens" token). */
  canCreateTokens: boolean;
  /** The Cloudflare user the token belongs to, when the token reveals it. */
  userId: string | null;
}

/**
 * Checks that a token works and whether it can create other tokens.
 * Throws when Cloudflare rejects the token.
 */
export async function inspectToken(client: CloudflareClient): Promise<TokenInfo> {
  const verified = (await client.user.tokens.verify()) as { id: string; status?: string };
  if (verified.status && verified.status !== "active") {
    throw new Error(`The token is ${verified.status}.`);
  }

  let details: { policies?: Array<{ resources?: Record<string, unknown> }> };
  try {
    details = (await client.user.tokens.get(verified.id)) as typeof details;
  } catch {
    // Only tokens that manage tokens may read token details.
    return { id: verified.id, canCreateTokens: false, userId: null };
  }

  let userId: string | null = null;
  for (const policy of details.policies ?? []) {
    for (const key of Object.keys(policy.resources ?? {})) {
      const match = key.match(/^com\.cloudflare\.api\.user\.([^.]+)$/);
      if (match) userId = match[1];
    }
  }
  return { id: verified.id, canCreateTokens: true, userId };
}

export interface CreatedToken {
  token: string;
  missing: WantedPermission[];
}

/**
 * Creates flaregun's token using a token that can create tokens.
 */
export async function createFlaregunToken(
  client: CloudflareClient,
  userId: string | null,
): Promise<CreatedToken> {
  const groups: PermissionGroup[] = [];
  for await (const group of client.user.tokens.permissionGroups.list()) {
    groups.push(group as PermissionGroup);
  }

  const selected = selectPermissionGroups(groups);
  const policies = buildPolicies(selected, userId);
  if (policies.length === 0) {
    throw new Error("Cloudflare didn't offer any of the permissions flaregun needs.");
  }

  const created = (await client.user.tokens.create({
    name: `flaregun (${hostname()})`,
    policies,
  } as unknown as Parameters<typeof client.user.tokens.create>[0])) as { value?: string };

  if (!created.value) {
    throw new Error("Cloudflare created the token but didn't return its value.");
  }
  // User permissions need the user's ID, so they're skipped when it's unknown.
  const skipped = userId ? [] : (selected.byScope.get(USER_SCOPE) ?? []).map(({ want }) => want);
  return { token: created.value, missing: [...selected.missing, ...skipped] };
}

/** Deletes the short-lived token used to create flaregun's token. */
export async function deleteToken(client: CloudflareClient, tokenId: string): Promise<void> {
  await client.user.tokens.delete(tokenId);
}
