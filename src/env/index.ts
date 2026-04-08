import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// --- Types ---

/** The command context determines which environment variables are required. */
export type EnvContext = "deploy" | "up" | "sync" | "destroy" | "setup";

/** Validated Cloudflare credentials — all required values guaranteed present. */
export interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
  zoneId: string;
  tunnelToken?: string;
}

// --- Validation Error ---

export class EnvValidationError extends Error {
  constructor(
    public readonly missing: string[],
    message: string,
  ) {
    super(message);
    this.name = "EnvValidationError";
  }
}

// --- .env File Parsing ---

/**
 * Parses a .env file into key-value pairs.
 * Handles:
 * - Lines with KEY=VALUE format
 * - Optional quoting (single or double quotes around values)
 * - Comments (lines starting with #)
 * - Empty lines
 */
function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      vars[key] = value;
    }
  }

  return vars;
}

// --- Core Functions ---

/**
 * Loads environment variables from a .env file co-located with the config file.
 * Variables from the .env file are merged into process.env (without overwriting
 * existing values — existing process.env values take precedence).
 *
 * @param configPath - Path to the flaregun.yml config file. The .env file is
 *   expected in the same directory.
 * @returns true if a .env file was found and loaded, false otherwise.
 */
export function loadEnvFile(configPath: string): boolean {
  const dir = dirname(resolve(configPath));
  const envPath = resolve(dir, ".env");

  if (!existsSync(envPath)) {
    return false;
  }

  const content = readFileSync(envPath, "utf-8");
  const vars = parseEnvFile(content);

  // Merge into process.env — existing values take precedence
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

/**
 * Variables required for all Cloudflare-interacting commands.
 */
const BASE_REQUIRED_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
] as const;

/**
 * Validates that all required environment variables are set for the given context.
 *
 * Follows the eager collection pattern: all missing variables are collected
 * and reported together in a single error message.
 *
 * @param context - The command context (determines which variables are required)
 * @param envFileLoaded - Whether a .env file was found (affects error message)
 * @returns Validated credentials object with all required values
 */
export function validateEnv(
  context: EnvContext,
  envFileLoaded: boolean = false,
): CloudflareCredentials {
  const missing: string[] = [];

  // Check base required variables
  for (const name of BASE_REQUIRED_VARS) {
    if (!process.env[name]) {
      missing.push(name);
    }
  }

  // Tunnel token is only required for the `up` command
  const needsTunnelToken = context === "up";
  if (needsTunnelToken && !process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    missing.push("CLOUDFLARE_TUNNEL_TOKEN");
  }

  if (missing.length > 0) {
    let hint: string;
    if (!envFileLoaded && missing.length === (needsTunnelToken ? 4 : 3)) {
      // No .env file and all variables are missing — suggest setup
      hint = "Run `flaregun setup` to configure your Cloudflare credentials.";
    } else if (!envFileLoaded) {
      hint =
        "No .env file found. Create a .env file next to flaregun.yml or set these variables in your environment.";
    } else {
      hint = "Check your .env file for the missing values.";
    }

    throw new EnvValidationError(
      missing,
      `Missing required environment variable(s): ${missing.join(", ")}.\n${hint}`,
    );
  }

  const credentials: CloudflareCredentials = {
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    zoneId: process.env.CLOUDFLARE_ZONE_ID!,
  };

  // Include tunnel token if present (even for non-up contexts)
  if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    credentials.tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN;
  }

  return credentials;
}

/**
 * Convenience function that loads the .env file and validates environment
 * variables in one step.
 *
 * @param configPath - Path to the flaregun.yml config file
 * @param context - The command context
 * @returns Validated credentials object
 */
export function loadAndValidateEnv(
  configPath: string,
  context: EnvContext,
): CloudflareCredentials {
  const envFileLoaded = loadEnvFile(configPath);
  return validateEnv(context, envFileLoaded);
}
