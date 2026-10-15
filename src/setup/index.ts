/**
 * `flaregun setup`: gets everything ready for tunnels with as few questions as possible.
 *
 * 1. API token: reuses a working token from .env, or gets one from the
 *    dashboard (driving the person's browser when allowed) and uses it to create
 *    flaregun's own token through the API.
 * 2. Account and domain: picked automatically when there's only one.
 * 3. Zero Trust: creates the organization and a One-time PIN login method
 *    through the API; falls back to the dashboard only if Cloudflare insists.
 * 4. Admin emails: defaults to the Cloudflare account's email.
 * 5. Tunnel: reuses the domain's tunnel or creates one, and fetches its token.
 * 6. Writes .env, flaregun.yml (only if missing) and flaregun.lock.
 *
 * Running it again is safe: every step reuses what already exists.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { load } from "js-yaml";
import type { CloudflareClient } from "../cloudflare/index.js";
import { createClientFromToken } from "../cloudflare/index.js";
import { parseConfig } from "../config/index.js";
import { loadLockFile, saveLockFile } from "../lock/index.js";
import { createDashboard, type Dashboard } from "./dashboard.js";
import { createConsoleIO, type SetupIO } from "./io.js";
import { createFlaregunToken, deleteToken, inspectToken, type TokenInfo } from "./token.js";
import {
  createOrganization,
  ensureLoginMethod,
  getOrganization,
  type Organization,
} from "./zero-trust.js";

export type { SetupIO } from "./io.js";

/** Dependencies injected for testability */
export interface SetupDeps {
  io: SetupIO;
  createClient: (token: string) => CloudflareClient;
  dashboard: Dashboard;
  cwd: string;
  /** How long to wait for the person to finish Zero Trust onboarding in the dashboard. */
  onboardingWaitMs: number;
}

/** What setup produced, used for the summary and by `flaregun expose`. */
export interface SetupResult {
  success: boolean;
  domain?: string;
  configPath?: string;
}

type EnvKey =
  | "CLOUDFLARE_API_TOKEN"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_ZONE_ID"
  | "CLOUDFLARE_TUNNEL_TOKEN";

// --- Step 1: API token ---

/**
 * Returns a client for a working flaregun token: the one in .env if it still
 * works, otherwise a new one created from a dashboard token.
 */
export async function stepToken(
  deps: SetupDeps,
  existingToken: string | undefined,
): Promise<{ apiToken: string; client: CloudflareClient }> {
  const { io } = deps;
  io.print("\n━━━ 1. Cloudflare API token ━━━");

  if (existingToken) {
    const client = deps.createClient(existingToken);
    const info = await tryInspect(client);
    if (info && !info.canCreateTokens) {
      io.print("✓ Using the API token from .env");
      return { apiToken: existingToken, client };
    }
    if (!info) io.print("The API token in .env no longer works; let's make a new one.");
  }

  let bootstrap: { token: string; info: TokenInfo } | null = null;
  await deps.dashboard.bootstrapToken(io, async (token) => {
    const info = await tryInspect(deps.createClient(token));
    if (info) bootstrap = { token, info };
    return info !== null;
  });
  const { token, info } = bootstrap!;
  const bootstrapClient = deps.createClient(token);

  if (!info.canCreateTokens) {
    // The person pasted a ready-made token rather than a "Create Additional Tokens" one.
    io.print("✓ Using the token you pasted");
    return { apiToken: token, client: bootstrapClient };
  }

  const created = await createFlaregunToken(bootstrapClient, info.userId);
  io.print("✓ Created flaregun's own API token");
  for (const want of created.missing) {
    io.print(`  ! Cloudflare didn't offer a permission to ${want.why}; that part may not work.`);
  }
  try {
    await deleteToken(bootstrapClient, info.id);
    io.print("✓ Deleted the temporary dashboard token");
  } catch {
    io.print("  ! Couldn't delete the temporary dashboard token. Delete it at https://dash.cloudflare.com/profile/api-tokens");
  }

  return { apiToken: created.token, client: deps.createClient(created.token) };
}

async function tryInspect(client: CloudflareClient): Promise<TokenInfo | null> {
  try {
    return await inspectToken(client);
  } catch {
    return null;
  }
}

// --- Step 2: Account and domain ---

/** Lists the accounts the token can see. */
export async function listAccounts(
  client: CloudflareClient,
): Promise<Array<{ id: string; name: string }>> {
  const accounts: Array<{ id: string; name: string }> = [];
  for await (const account of client.accounts.list()) {
    accounts.push({ id: account.id, name: account.name });
  }
  return accounts;
}

/** Lists the account's active domains. */
export async function listZones(
  client: CloudflareClient,
  accountId: string,
): Promise<Array<{ id: string; name: string }>> {
  const zones: Array<{ id: string; name: string }> = [];
  for await (const zone of client.zones.list({ account: { id: accountId } })) {
    zones.push({ id: zone.id, name: zone.name });
  }
  return zones;
}

/**
 * Picks the account and domain. Picks automatically when there's only one
 * choice, or when `preferredDomain` (from an existing flaregun.yml) matches.
 */
export async function stepAccountAndDomain(
  deps: SetupDeps,
  client: CloudflareClient,
  preferredDomain: string | undefined,
): Promise<{ accountId: string; zoneId: string; domain: string }> {
  const { io } = deps;
  io.print("\n━━━ 2. Account and domain ━━━");

  const accounts = await listAccounts(client);
  if (accounts.length === 0) {
    throw new Error("The API token can't see any Cloudflare accounts.");
  }

  // With several accounts, look for the preferred domain before asking.
  if (preferredDomain && accounts.length > 1) {
    for (const account of accounts) {
      const zone = (await listZones(client, account.id)).find((z) => z.name === preferredDomain);
      if (zone) {
        io.print(`✓ Account: ${account.name}`);
        io.print(`✓ Domain: ${zone.name}`);
        return { accountId: account.id, zoneId: zone.id, domain: zone.name };
      }
    }
  }

  const account =
    accounts.length === 1
      ? accounts[0]
      : accounts[await io.choose("Which Cloudflare account?", accounts.map((a) => a.name))];
  io.print(`✓ Account: ${account.name}`);

  const zones = await listZones(client, account.id);
  if (zones.length === 0) {
    throw new Error(
      `The account "${account.name}" has no domains. Add one at https://dash.cloudflare.com/?to=/:account/add-site and run setup again.`,
    );
  }
  const zone =
    zones.find((z) => z.name === preferredDomain) ??
    (zones.length === 1
      ? zones[0]
      : zones[await io.choose("Which domain should the tunnels use?", zones.map((z) => z.name))]);
  io.print(`✓ Domain: ${zone.name}`);

  return { accountId: account.id, zoneId: zone.id, domain: zone.name };
}

// --- Step 3: Zero Trust ---

/**
 * Makes sure Zero Trust is on and has a login method. Returns the login method
 * type, which goes into flaregun.yml as `auth.provider`.
 */
export async function stepZeroTrust(
  deps: SetupDeps,
  client: CloudflareClient,
  accountId: string,
  domain: string,
): Promise<{ provider: string; organization: Organization }> {
  const { io } = deps;
  io.print("\n━━━ 3. Zero Trust ━━━");

  let organization = await getOrganization(client, accountId);
  if (organization) {
    io.print(`✓ Zero Trust team: ${organization.authDomain}`);
  } else {
    try {
      organization = await createOrganization(client, accountId, domain);
      io.print(`✓ Switched on Zero Trust with team ${organization.authDomain}`);
    } catch {
      await deps.dashboard.showZeroTrustOnboarding(io);
      organization = await io.waitUntil(
        "  Waiting for Zero Trust… (press Enter to stop waiting)",
        () => getOrganization(client, accountId),
        deps.onboardingWaitMs,
      );
      if (!organization) {
        throw new Error(
          "Zero Trust isn't switched on yet. Finish onboarding at https://one.dash.cloudflare.com/ and run `flaregun setup` again.",
        );
      }
      io.print(`✓ Zero Trust team: ${organization.authDomain}`);
    }
  }

  const login = await ensureLoginMethod(client, accountId);
  io.print(
    login.created
      ? "✓ Added One-time PIN login: people get a code by email"
      : `✓ Login method: ${login.type}`,
  );

  return { provider: login.type, organization };
}

// --- Step 4: Admin emails ---

/** Asks who may log in to protected services, defaulting to the account's email. */
export async function stepAdmins(deps: SetupDeps, client: CloudflareClient): Promise<string[]> {
  const { io } = deps;
  io.print("\n━━━ 4. Who can log in ━━━");

  let defaultEmail: string | undefined;
  try {
    defaultEmail = ((await client.user.get()) as { email?: string }).email;
  } catch {
    // The token may lack User Details; the person types the email instead.
  }

  while (true) {
    const answer = await io.prompt(
      "Admin emails (comma-separated) — they can open every protected service:",
      defaultEmail,
    );
    const emails = answer
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length > 0 && emails.every((e) => e.includes("@"))) {
      io.print(`✓ Admins: ${emails.join(", ")}`);
      return emails;
    }
    io.print("Enter at least one email address.");
  }
}

// --- Step 5: Tunnel ---

/** Derives a tunnel name from a domain. E.g., "example.com" → "example-com-tunnel" */
export function deriveTunnelName(domain: string): string {
  return domain.replace(/\./g, "-") + "-tunnel";
}

/** Generates a base64-encoded random secret for tunnel creation */
function generateTunnelSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Finds the tunnel to use: the one in flaregun.lock if it still exists, then a
 * tunnel with the domain's tunnel name, and otherwise a new one. Returns its ID
 * and the token cloudflared runs with.
 */
export async function stepTunnel(
  deps: SetupDeps,
  client: CloudflareClient,
  accountId: string,
  domain: string,
  lockedTunnelId: string | undefined,
): Promise<{ tunnelId: string; tunnelToken: string; tunnelName: string }> {
  const { io } = deps;
  io.print("\n━━━ 5. Tunnel ━━━");
  const tunnels = client.zeroTrust.tunnels.cloudflared;

  let tunnel: { id: string; name: string } | null = null;

  if (lockedTunnelId) {
    try {
      const found = (await tunnels.get(lockedTunnelId, { account_id: accountId })) as {
        id?: string;
        name?: string;
        deleted_at?: string | null;
      };
      if (found.id && !found.deleted_at) tunnel = { id: found.id, name: found.name ?? "" };
    } catch {
      // Deleted or from another account; look further.
    }
  }

  const tunnelName = tunnel?.name || deriveTunnelName(domain);

  if (!tunnel) {
    for await (const found of tunnels.list({
      account_id: accountId,
      name: tunnelName,
      is_deleted: false,
    })) {
      const t = found as { id?: string; name?: string };
      if (t.id && t.name === tunnelName) {
        tunnel = { id: t.id, name: tunnelName };
        break;
      }
    }
  }

  if (tunnel) {
    io.print(`✓ Using tunnel ${tunnel.name}`);
  } else {
    const created = (await tunnels.create({
      account_id: accountId,
      name: tunnelName,
      config_src: "cloudflare",
      tunnel_secret: generateTunnelSecret(),
    })) as { id?: string };
    tunnel = { id: created.id!, name: tunnelName };
    io.print(`✓ Created tunnel ${tunnelName}`);
  }

  const tunnelToken = (await tunnels.token.get(tunnel.id, { account_id: accountId })) as string;
  return { tunnelId: tunnel.id, tunnelToken, tunnelName: tunnel.name };
}

// --- Step 6: Files ---

/**
 * Sets the flaregun keys in .env content, keeping every other line as it was.
 */
export function updateEnvContent(
  existing: string | null,
  values: Partial<Record<EnvKey, string>>,
): string {
  const remaining = new Map(Object.entries(values));
  const lines = (existing ?? "# Written by flaregun setup. Contains secrets: keep it out of git.\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const key = line.split("=")[0].trim();
      if (remaining.has(key)) {
        const value = remaining.get(key)!;
        remaining.delete(key);
        return `${key}=${value}`;
      }
      return line;
    });
  for (const [key, value] of remaining) lines.push(`${key}=${value}`);
  return lines.join("\n") + "\n";
}

/** Generates a starter flaregun.yml with no services; `flaregun expose` adds them. */
export function generateConfigContent(state: {
  domain: string;
  provider: string;
  superusers: string[];
}): string {
  const superusers = state.superusers.map((email) => `    - ${email}`).join("\n");
  return `# flaregun configuration — https://github.com/jpheimonen/flaregun
domain: ${state.domain}

auth:
  # Login method for Cloudflare Access (set up by flaregun setup)
  provider: ${state.provider}
  # These people can open every protected service
  superusers:
${superusers}

# Each service gets https://<subdomain>.${state.domain}
# Add one quickly with: flaregun expose <port> [subdomain]
#
#   api:
#     subdomain: api
#     port: 3000                    # a port that's already running on this machine
#     command: bun run server.ts    # optional: flaregun starts and restarts it for you
#     auth: admin_only              # admin_only (default), authorized or public
#     users: ["*@example.com"]      # extra people, only with auth: authorized
services: {}
`;
}

/** Reads the domain from an existing flaregun.yml without validating the rest. */
function readConfigDomain(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = load(readFileSync(configPath, "utf-8")) as { domain?: unknown } | null;
    return typeof raw?.domain === "string" ? raw.domain : undefined;
  } catch {
    return undefined;
  }
}

/** Reads one value from a .env file. */
function readEnvValue(envPath: string, key: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k.trim() === key) {
      const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
      return value || undefined;
    }
  }
  return undefined;
}

// --- Main ---

/**
 * Runs setup. Entry point for `flaregun setup`.
 */
export async function runSetup(deps: SetupDeps): Promise<SetupResult> {
  const { io, cwd } = deps;
  const envPath = resolve(cwd, ".env");
  const configPath = resolve(cwd, "flaregun.yml");
  const lockPath = resolve(cwd, "flaregun.lock");

  io.print("\nflaregun setup — gets Cloudflare ready for tunnels. Safe to run again.");

  try {
    const existingToken = process.env.CLOUDFLARE_API_TOKEN || readEnvValue(envPath, "CLOUDFLARE_API_TOKEN");
    const { apiToken, client } = await stepToken(deps, existingToken);
    // Save the token straight away so a failure later doesn't lose it.
    writeFileSync(
      envPath,
      updateEnvContent(existsSync(envPath) ? readFileSync(envPath, "utf-8") : null, {
        CLOUDFLARE_API_TOKEN: apiToken,
      }),
      { encoding: "utf-8", mode: 0o600 },
    );

    const configDomain = readConfigDomain(configPath);
    const { accountId, zoneId, domain } = await stepAccountAndDomain(deps, client, configDomain);
    const { provider } = await stepZeroTrust(deps, client, accountId, domain);

    const configExists = existsSync(configPath);
    let superusers: string[] = [];
    if (!configExists) {
      superusers = await stepAdmins(deps, client);
    }

    const lock = loadLockFile(lockPath);
    const { tunnelId, tunnelToken, tunnelName } = await stepTunnel(
      deps,
      client,
      accountId,
      domain,
      lock.tunnel?.id,
    );

    io.print("\n━━━ 6. Files ━━━");
    writeFileSync(
      envPath,
      updateEnvContent(readFileSync(envPath, "utf-8"), {
        CLOUDFLARE_API_TOKEN: apiToken,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_ZONE_ID: zoneId,
        CLOUDFLARE_TUNNEL_TOKEN: tunnelToken,
      }),
      { encoding: "utf-8", mode: 0o600 },
    );
    io.print("✓ .env (secrets — keep it out of git)");

    if (configExists) {
      io.print("✓ flaregun.yml already exists; left it as it is");
      if (configDomain && configDomain !== domain) {
        io.print(`  ! It uses ${configDomain}, but setup picked ${domain}. Change "domain:" if that's wrong.`);
      }
    } else {
      const content = generateConfigContent({ domain, provider, superusers });
      parseConfig(content); // the template must always be valid
      writeFileSync(configPath, content, "utf-8");
      io.print("✓ flaregun.yml");
    }

    lock.tunnel = { id: tunnelId };
    saveLockFile(lockPath, lock);
    io.print(`✓ flaregun.lock (tunnel ${tunnelName})`);

    // Commands that run next in the same process read credentials from the environment.
    process.env.CLOUDFLARE_API_TOKEN = apiToken;
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    process.env.CLOUDFLARE_ZONE_ID = zoneId;
    process.env.CLOUDFLARE_TUNNEL_TOKEN = tunnelToken;

    io.print("\n━━━ Ready ━━━");
    io.print(`Expose a local port:   flaregun expose 3000      → https://3000.${domain}`);
    io.print("Run everything:        flaregun up");
    return { success: true, domain, configPath };
  } catch (err) {
    io.print(`\n✗ Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false };
  } finally {
    deps.dashboard.close();
  }
}

export interface SetupOptions {
  cwd?: string;
  /** Let flaregun drive the default browser for dashboard steps (default true). */
  useBrowser?: boolean;
  io?: SetupIO;
}

/** `flaregun setup` with real terminal, browser and Cloudflare client. */
export async function handleSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const io = options.io ?? createConsoleIO();
  try {
    return await runSetup({
      io,
      createClient: createClientFromToken,
      dashboard: createDashboard({ useBrowser: options.useBrowser ?? true }),
      cwd: options.cwd ?? process.cwd(),
      onboardingWaitMs: 10 * 60_000,
    });
  } finally {
    if (!options.io) io.close();
  }
}
