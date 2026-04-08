import Cloudflare from "cloudflare";
import type { CloudflareCredentials } from "../env/index.js";

// --- Types ---

/** Re-export the Cloudflare client type for use by consumers */
export type CloudflareClient = Cloudflare;

// --- Factory ---

/**
 * Creates a Cloudflare SDK client from validated credentials.
 *
 * This factory provides the dependency injection seam for the entire project.
 * The sync engine, resource provisioner, and other components accept the client
 * as a parameter rather than creating it internally, making it trivial to
 * substitute a mock client in tests.
 *
 * @param credentials - Validated credentials (at minimum apiToken is required)
 * @returns An initialized Cloudflare SDK client
 */
export function createClient(credentials: CloudflareCredentials): Cloudflare {
  return new Cloudflare({ apiToken: credentials.apiToken });
}

/**
 * Creates a Cloudflare SDK client from a raw API token string.
 * Convenience overload for cases where only the token is available.
 *
 * @param apiToken - The Cloudflare API token
 * @returns An initialized Cloudflare SDK client
 */
export function createClientFromToken(apiToken: string): Cloudflare {
  return new Cloudflare({ apiToken });
}
