/**
 * Setup wizard command handler.
 *
 * Guides the user through interactive first-time Cloudflare configuration:
 * 1. API token input and validation
 * 2. Identity provider setup instructions
 * 3. Programmatic tunnel creation
 * 4. .env file generation
 * 5. Starter flaregun.yml generation
 * 6. Lock file initialization
 *
 * This is the only command that operates without existing config/env files — it creates them.
 */

import { existsSync, writeFileSync } from "fs";
import { resolve } from "path";
import type { CloudflareClient } from "../cloudflare/index.js";
import { createClientFromToken } from "../cloudflare/index.js";
import { parseConfig } from "../config/index.js";
import { loadLockFile, saveLockFile, type LockState } from "../lock/index.js";

// --- Types ---

/** IO abstraction for testing — all user interaction goes through this interface */
export interface SetupIO {
  print(msg: string): void;
  prompt(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

/** Collected state from setup steps */
export interface SetupState {
  apiToken: string;
  accountId: string;
  zoneId: string;
  domain: string;
  provider: string;
  superusers: string[];
  tunnelId: string;
  tunnelToken: string;
  tunnelName: string;
  envWritten: boolean;
  configWritten: boolean;
  lockWritten: boolean;
}

/** Dependencies injected for testability */
export interface SetupDeps {
  io: SetupIO;
  createClient: (token: string) => CloudflareClient;
  cwd: string;
}

// --- Token Permissions Display ---

const TOKEN_PERMISSIONS = [
  "Account: Cloudflare Tunnel: Edit",
  "Account: Access: Organizations, Identity Providers, and Groups: Edit",
  "Account: Access: Apps and Policies: Edit",
  "Account: D1: Edit",
  "Account: Workers R2 Storage: Edit",
  "Account: Workers KV Storage: Edit",
  "Zone: DNS: Edit",
  "Zone: Zone Rulesets: Edit",
  "Zone: Cloudflare Pages: Edit",
  "Zone: Workers Routes: Edit",
];

const TOKEN_CREATE_URL = "https://dash.cloudflare.com/profile/api-tokens";

// --- Step 1: API Token ---

/**
 * Validates an API token by calling the Cloudflare token verify endpoint.
 * Returns { valid: true } on success, or { valid: false, error } on failure.
 */
export async function verifyToken(
  client: CloudflareClient,
): Promise<{ valid: boolean; error?: string }> {
  try {
    await (client as any).user.tokens.verify();
    return { valid: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

/**
 * Looks up accounts accessible with the given token.
 * Returns a list of { id, name } pairs.
 */
export async function listAccounts(
  client: CloudflareClient,
): Promise<Array<{ id: string; name: string }>> {
  const accounts: Array<{ id: string; name: string }> = [];
  const result = (client as any).accounts.list();
  for await (const account of result) {
    accounts.push({
      id: (account as any).id,
      name: (account as any).name,
    });
  }
  return accounts;
}

/**
 * Looks up the zone ID for a domain name.
 */
export async function lookupZoneId(
  client: CloudflareClient,
  domain: string,
): Promise<{ zoneId?: string; error?: string }> {
  try {
    const result = (client as any).zones.list({ name: domain });
    const zones: any[] = [];
    for await (const zone of result) {
      zones.push(zone);
    }
    if (zones.length === 0) {
      return { error: `No zone found for domain "${domain}"` };
    }
    return { zoneId: zones[0].id };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

/**
 * Step 1: Collect and validate API token, account ID, and zone ID.
 */
export async function stepApiToken(
  deps: SetupDeps,
): Promise<{
  apiToken: string;
  accountId: string;
  zoneId: string;
  domain: string;
  client: CloudflareClient;
}> {
  const { io } = deps;

  io.print("\n━━━ Step 1: API Token ━━━\n");
  io.print("Flaregun needs a Cloudflare API token with the following permissions:\n");
  for (const perm of TOKEN_PERMISSIONS) {
    io.print(`  • ${perm}`);
  }
  io.print(`\nCreate a token at: ${TOKEN_CREATE_URL}\n`);

  // Collect and validate token with retry loop
  let apiToken = "";
  let client!: CloudflareClient;

  while (true) {
    apiToken = await io.prompt("Paste your API token:");
    if (!apiToken.trim()) {
      io.print("Token cannot be empty. Please try again.");
      continue;
    }
    apiToken = apiToken.trim();

    client = deps.createClient(apiToken);
    const verification = await verifyToken(client);

    if (verification.valid) {
      io.print("✓ API token verified successfully.\n");
      break;
    } else {
      io.print(`✗ Token validation failed: ${verification.error}`);
      io.print("Please try again with a valid token.\n");
    }
  }

  // Collect account ID
  let accountId = "";
  try {
    const accounts = await listAccounts(client);
    if (accounts.length === 1) {
      accountId = accounts[0].id;
      io.print(`✓ Found account: ${accounts[0].name} (${accountId})`);
    } else if (accounts.length > 1) {
      io.print("Multiple accounts found:");
      for (let i = 0; i < accounts.length; i++) {
        io.print(`  ${i + 1}. ${accounts[i].name} (${accounts[i].id})`);
      }
      const selection = await io.prompt("Enter the account number to use:");
      const idx = parseInt(selection, 10) - 1;
      if (idx >= 0 && idx < accounts.length) {
        accountId = accounts[idx].id;
      } else {
        accountId = await io.prompt("Enter your Cloudflare Account ID:");
      }
    }
  } catch {
    // Fallback to manual entry
  }

  if (!accountId) {
    io.print(
      "\nYour Account ID is in the Cloudflare dashboard URL: https://dash.cloudflare.com/<account-id>",
    );
    accountId = (await io.prompt("Enter your Cloudflare Account ID:")).trim();
  }

  // Collect domain and look up zone ID
  let domain = "";
  let zoneId = "";

  while (true) {
    domain = (await io.prompt("Enter your domain name (e.g., example.com):")).trim();
    if (!domain) {
      io.print("Domain cannot be empty. Please try again.");
      continue;
    }

    const zoneLookup = await lookupZoneId(client, domain);
    if (zoneLookup.zoneId) {
      zoneId = zoneLookup.zoneId;
      io.print(`✓ Found zone ID for ${domain}: ${zoneId}\n`);
      break;
    } else {
      io.print(`✗ ${zoneLookup.error}`);
      io.print("Please check the domain and try again.\n");
    }
  }

  return { apiToken, accountId, zoneId, domain, client };
}

// --- Step 2: Identity Provider ---

const ACCESS_IDP_URL = "https://one.dash.cloudflare.com";

/**
 * Step 2: Guide user through identity provider setup and collect provider name + superuser emails.
 */
export async function stepIdentityProvider(
  deps: SetupDeps,
): Promise<{ provider: string; superusers: string[] }> {
  const { io } = deps;

  io.print("\n━━━ Step 2: Identity Provider ━━━\n");
  io.print(
    "Cloudflare Access needs an identity provider (IdP) for authentication.",
  );
  io.print("This is how users log in to access protected services.\n");
  io.print("Common providers:");
  io.print("  • Google OAuth — Use your Google account");
  io.print("  • GitHub — Use your GitHub account");
  io.print("  • One-time PIN — Email-based login (no external provider needed)");
  io.print(
    `\nConfigure your identity provider at: ${ACCESS_IDP_URL}`,
  );
  io.print(
    "Navigate to: Settings → Authentication → Login methods → Add new\n",
  );

  const provider = (
    await io.prompt(
      'Enter the identity provider name you configured (e.g., "google", "github", "onetimepin"):',
    )
  ).trim();

  io.print(
    "\nSuperusers are admin emails that get access to all protected services.",
  );
  const emailsRaw = (
    await io.prompt(
      "Enter superuser email(s), comma-separated:",
    )
  ).trim();
  const superusers = emailsRaw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  io.print(`✓ Provider: ${provider}`);
  io.print(`✓ Superusers: ${superusers.join(", ")}\n`);

  return { provider, superusers };
}

// --- Step 3: Tunnel Creation ---

/**
 * Derives a tunnel name from a domain. E.g., "example.com" → "example-com-tunnel"
 */
export function deriveTunnelName(domain: string): string {
  return domain.replace(/\./g, "-") + "-tunnel";
}

/**
 * Creates a Cloudflare Tunnel via the SDK.
 */
export async function createTunnel(
  client: CloudflareClient,
  accountId: string,
  tunnelName: string,
): Promise<{ id: string; token: string }> {
  const result = await (client as any).zeroTrust.tunnels.create({
    account_id: accountId,
    name: tunnelName,
    tunnel_secret: generateTunnelSecret(),
    config_src: "cloudflare",
  });

  return {
    id: (result as any).id,
    token: (result as any).token,
  };
}

/** Generate a base64-encoded random secret for tunnel creation */
function generateTunnelSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Step 3: Create a tunnel programmatically.
 */
export async function stepCreateTunnel(
  deps: SetupDeps,
  client: CloudflareClient,
  accountId: string,
  domain: string,
): Promise<{ tunnelId: string; tunnelToken: string; tunnelName: string }> {
  const { io } = deps;

  io.print("\n━━━ Step 3: Tunnel Creation ━━━\n");

  const tunnelName = deriveTunnelName(domain);
  io.print(`Creating tunnel "${tunnelName}"...`);

  try {
    const tunnel = await createTunnel(client, accountId, tunnelName);
    io.print(`✓ Tunnel created: ${tunnelName} (ID: ${tunnel.id})\n`);
    return {
      tunnelId: tunnel.id,
      tunnelToken: tunnel.token,
      tunnelName,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    // Check for name conflict
    if (
      message.includes("already exists") ||
      message.includes("duplicate") ||
      message.includes("conflict")
    ) {
      io.print(`✗ A tunnel named "${tunnelName}" already exists.`);
      const useExisting = await io.confirm(
        "Would you like to enter an existing tunnel's ID and token instead?",
      );

      if (useExisting) {
        const tunnelId = (await io.prompt("Enter the existing tunnel ID:")).trim();
        const tunnelToken = (
          await io.prompt("Enter the existing tunnel token:")
        ).trim();
        io.print(`✓ Using existing tunnel (ID: ${tunnelId})\n`);
        return { tunnelId, tunnelToken, tunnelName };
      } else {
        const altName = (
          await io.prompt("Enter an alternative tunnel name:")
        ).trim();
        const tunnel = await createTunnel(client, accountId, altName);
        io.print(`✓ Tunnel created: ${altName} (ID: ${tunnel.id})\n`);
        return {
          tunnelId: tunnel.id,
          tunnelToken: tunnel.token,
          tunnelName: altName,
        };
      }
    }

    throw err;
  }
}

// --- Step 4: Generate .env file ---

/**
 * Generates the content of a .env file from the collected credentials.
 */
export function generateEnvContent(state: {
  apiToken: string;
  accountId: string;
  zoneId: string;
  tunnelToken: string;
}): string {
  return `# Generated by flaregun setup
# This file contains secrets — do NOT commit to version control.
# Add .env to your .gitignore file.

# Cloudflare API token with permissions for Access, Tunnels, DNS, Pages, and Workers
CLOUDFLARE_API_TOKEN=${state.apiToken}

# Cloudflare account identifier (found in the dashboard URL or account overview)
CLOUDFLARE_ACCOUNT_ID=${state.accountId}

# Cloudflare Zone ID for the domain (found in the dashboard overview for your domain)
CLOUDFLARE_ZONE_ID=${state.zoneId}

# Cloudflare Tunnel token (generated during tunnel creation)
CLOUDFLARE_TUNNEL_TOKEN=${state.tunnelToken}
`;
}

/**
 * Step 4: Write the .env file with overwrite protection.
 */
export async function stepGenerateEnv(
  deps: SetupDeps,
  state: {
    apiToken: string;
    accountId: string;
    zoneId: string;
    tunnelToken: string;
  },
): Promise<boolean> {
  const { io, cwd } = deps;

  io.print("\n━━━ Step 4: Generate .env ━━━\n");

  const envPath = resolve(cwd, ".env");

  if (existsSync(envPath)) {
    const overwrite = await io.confirm(
      "A .env file already exists. Overwrite it?",
    );
    if (!overwrite) {
      io.print("Skipped — existing .env file left unchanged.\n");
      return false;
    }
  }

  const content = generateEnvContent(state);
  writeFileSync(envPath, content, "utf-8");
  io.print(`✓ .env file written to ${envPath}`);
  io.print("  Remember: add .env to your .gitignore!\n");
  return true;
}

// --- Step 5: Generate starter flaregun.yml ---

/**
 * Generates a minimal, valid starter flaregun.yml.
 */
export function generateConfigContent(state: {
  domain: string;
  provider: string;
  superusers: string[];
}): string {
  const superusersList = state.superusers
    .map((email) => `    - ${email}`)
    .join("\n");

  return `# Flaregun configuration
# Generated by flaregun setup — edit to match your project.

# Your domain managed by Cloudflare
domain: ${state.domain}

# Authentication configuration
auth:
  # Identity provider configured in Cloudflare Access
  provider: ${state.provider}
  # Admin emails with access to all protected services
  superusers:
${superusersList}

# Services to deploy and manage
# Add more services here. Each service needs a unique subdomain.
# Service types:
#   Pages (static site):  requires "dist" field
#   Local (dev server):   requires "command" and "port" fields
# Auth modes:
#   admin_only (default): Only superusers can access
#   authorized:           Superusers + listed users can access
#   public:               No access restriction
services:
  homepage:
    subdomain: www
    dist: projects/homepage/dist
    auth: public
`;
}

/**
 * Step 5: Write the starter flaregun.yml with overwrite protection.
 */
export async function stepGenerateConfig(
  deps: SetupDeps,
  state: {
    domain: string;
    provider: string;
    superusers: string[];
  },
): Promise<boolean> {
  const { io, cwd } = deps;

  io.print("\n━━━ Step 5: Generate flaregun.yml ━━━\n");

  const configPath = resolve(cwd, "flaregun.yml");

  if (existsSync(configPath)) {
    const overwrite = await io.confirm(
      "A flaregun.yml file already exists. Overwrite it?",
    );
    if (!overwrite) {
      io.print("Skipped — existing flaregun.yml left unchanged.\n");
      return false;
    }
  }

  const content = generateConfigContent(state);

  // Validate the generated config as a sanity check
  try {
    parseConfig(content);
  } catch (err) {
    io.print(
      `Warning: generated config did not pass validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  writeFileSync(configPath, content, "utf-8");
  io.print(`✓ flaregun.yml written to ${configPath}\n`);
  return true;
}

// --- Step 6: Initialize lock file ---

/**
 * Step 6: Write the tunnel ID to the lock file.
 */
export async function stepInitLockFile(
  deps: SetupDeps,
  tunnelId: string,
): Promise<boolean> {
  const { io, cwd } = deps;

  io.print("\n━━━ Step 6: Initialize Lock File ━━━\n");

  const lockPath = resolve(cwd, "flaregun.lock");

  // Load existing lock file (or create empty state)
  const state: LockState = loadLockFile(lockPath);

  // Merge tunnel ID
  state.tunnel = { id: tunnelId };

  saveLockFile(lockPath, state);
  io.print(`✓ Lock file written to ${lockPath} (tunnel ID: ${tunnelId})\n`);
  return true;
}

// --- Completion Summary ---

/**
 * Print a summary of what was accomplished.
 */
export function printSummary(
  io: SetupIO,
  state: SetupState,
): void {
  io.print("\n━━━ Setup Complete ━━━\n");
  io.print("Summary:");
  io.print("  ✓ API token validated");
  io.print("  ✓ Identity provider configured (manual step)");
  io.print(
    `  ✓ Tunnel created: ${state.tunnelName} (ID: ${state.tunnelId})`,
  );
  io.print(
    `  ${state.envWritten ? "✓" : "⊘"} .env file ${state.envWritten ? "generated" : "skipped"}`,
  );
  io.print(
    `  ${state.configWritten ? "✓" : "⊘"} flaregun.yml ${state.configWritten ? "generated" : "skipped"}`,
  );
  io.print(
    `  ${state.lockWritten ? "✓" : "⊘"} Lock file ${state.lockWritten ? "initialized" : "skipped"}`,
  );
  io.print("\nNext steps:");
  io.print("  1. Edit flaregun.yml to add your services");
  io.print("  2. Run `flaregun up` to start the system");
  io.print("  3. Run `flaregun deploy` to deploy Pages services");
  io.print("");
}

// --- Main Setup Handler ---

/**
 * Runs the full setup wizard. Entry point for the `flaregun setup` command.
 */
export async function handleSetup(
  deps?: Partial<SetupDeps>,
): Promise<{ success: boolean }> {
  const io: SetupIO = deps?.io ?? createConsoleIO();
  const clientFactory = deps?.createClient ?? createClientFromToken;
  const cwd = deps?.cwd ?? process.cwd();
  const fullDeps: SetupDeps = { io, createClient: clientFactory, cwd };

  io.print("\n🔧 Flaregun Setup Wizard\n");
  io.print("This wizard will guide you through configuring Cloudflare for your project.\n");

  try {
    // Step 1: API Token
    const { apiToken, accountId, zoneId, domain, client } =
      await stepApiToken(fullDeps);

    // Step 2: Identity Provider
    const { provider, superusers } = await stepIdentityProvider(fullDeps);

    // Step 3: Tunnel Creation
    const { tunnelId, tunnelToken, tunnelName } = await stepCreateTunnel(
      fullDeps,
      client,
      accountId,
      domain,
    );

    // Step 4: Generate .env
    const envWritten = await stepGenerateEnv(fullDeps, {
      apiToken,
      accountId,
      zoneId,
      tunnelToken,
    });

    // Step 5: Generate flaregun.yml
    const configWritten = await stepGenerateConfig(fullDeps, {
      domain,
      provider,
      superusers,
    });

    // Step 6: Initialize lock file
    const lockWritten = await stepInitLockFile(fullDeps, tunnelId);

    // Summary
    const state: SetupState = {
      apiToken,
      accountId,
      zoneId,
      domain,
      provider,
      superusers,
      tunnelId,
      tunnelToken,
      tunnelName,
      envWritten,
      configWritten,
      lockWritten,
    };

    printSummary(io, state);

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    io.print(`\n✗ Setup failed: ${message}`);
    return { success: false };
  }
}

// --- Console IO (real stdin/stdout) ---

/**
 * Creates a SetupIO implementation for real console interaction.
 * Uses Bun's built-in prompt for synchronous stdin reading.
 */
function createConsoleIO(): SetupIO {
  return {
    print(msg: string): void {
      console.log(msg);
    },
    async prompt(question: string): Promise<string> {
      // Use Bun's built-in prompt() for interactive input
      const answer = prompt(question) ?? "";
      return answer;
    },
    async confirm(question: string): Promise<boolean> {
      const answer = prompt(`${question} (y/N)`) ?? "n";
      return answer.toLowerCase().startsWith("y");
    },
  };
}
