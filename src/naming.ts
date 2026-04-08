/**
 * Resource naming convention utility.
 *
 * Derives deterministic, human-readable resource names from domain and service name.
 * Used by DNS sync (Pages project pages.dev addresses), resource provisioner
 * (D1/R2/KV naming), and wrangler config generator (Pages project names).
 *
 * Generated names satisfy all Cloudflare resource naming constraints:
 * - R2 buckets: lowercase, hyphens, 3–63 characters
 * - Pages projects: lowercase, hyphens, max 58 characters
 * - D1 databases: lowercase, hyphens
 * - KV namespaces: largely unrestricted but kept consistent
 */

/**
 * Generates a deterministic resource base name from a domain and service name.
 *
 * The format is `{domain-with-dots-replaced}-{serviceName}`, all lowercase.
 * Callers can append a suffix for resource type disambiguation (e.g., `-db`, `-bucket`).
 *
 * @param domain - The domain string (e.g., "example.com")
 * @param serviceName - The service name (e.g., "blog")
 * @returns A valid, deterministic base name (e.g., "example-com-blog")
 *
 * @example
 * ```ts
 * resourceName("example.com", "blog") // "example-com-blog"
 * resourceName("my.cool.site", "api") // "my-cool-site-api"
 * ```
 */
export function resourceName(domain: string, serviceName: string): string {
  // Replace dots with hyphens, lowercase everything
  const domainPart = domain.toLowerCase().replace(/\./g, "-");
  const servicePart = serviceName.toLowerCase();
  const name = `${domainPart}-${servicePart}`;

  // Enforce R2 bucket naming constraints (most restrictive):
  // - Must be 3–63 characters
  // - Only lowercase letters, numbers, and hyphens
  // - Cannot start or end with a hyphen
  // Strip any non-compliant characters
  const sanitized = name
    .replace(/[^a-z0-9-]/g, "-") // Replace invalid chars with hyphens
    .replace(/-+/g, "-") // Collapse consecutive hyphens
    .replace(/^-/, "") // Strip leading hyphen
    .replace(/-$/, ""); // Strip trailing hyphen

  // Truncate to 63 characters (R2 max length) while avoiding trailing hyphen
  if (sanitized.length > 63) {
    let truncated = sanitized.slice(0, 63);
    // Remove trailing hyphen after truncation
    truncated = truncated.replace(/-$/, "");
    return truncated;
  }

  return sanitized;
}
