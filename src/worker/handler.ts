/**
 * Fallback Worker routing logic.
 *
 * Implements the request routing for the domain-wide fallback Worker:
 *
 * 1. **Bare domain** → pass through to origin (redirect rule handles it)
 * 2. **Non-matching domain** → pass through (safety fallback)
 * 3. **www subdomain** → pass through to origin (Pages handles it)
 * 4. **down subdomain** → serve embedded down page HTML directly
 * 5. **All other subdomains** → proxy to origin; redirect to down page on 5xx/network error
 *
 * This module is a standard importable TypeScript file — not generated code.
 * The domain name and down page HTML are passed as parameters, making the
 * module directly testable without code generation or dynamic imports.
 */

/** Dependency-injectable fetch type for testability. */
export type FetchFn = (request: Request) => Promise<Response>;

/**
 * Core request handler for the fallback Worker.
 *
 * Routes requests based on hostname:
 * - Bare domain and www: pass through to origin unconditionally
 * - down subdomain: serve the down page HTML
 * - All other subdomains: proxy with fallback to down page on failure
 *
 * @param request - The incoming request
 * @param domain - The base domain (e.g., "example.com")
 * @param downPageHtml - The HTML content for the down page
 * @param originFetch - Injectable fetch function (defaults to globalThis.fetch)
 * @returns The response to send to the client
 */
export async function handleRequest(
  request: Request,
  domain: string,
  downPageHtml: string,
  originFetch: FetchFn = globalThis.fetch,
): Promise<Response> {
  const { hostname } = new URL(request.url);
  const downUrl = `https://down.${domain}`;

  // Pass through bare domain — the redirect rule handles it, not us
  if (hostname === domain) {
    return originFetch(request);
  }

  // Extract subdomain (everything before .domain)
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) {
    // Not our domain at all — pass through (shouldn't happen with routes)
    return originFetch(request);
  }
  const subdomain = hostname.slice(0, -suffix.length);

  // Pass through www — Cloudflare Pages handles it
  if (subdomain === "www") {
    return originFetch(request);
  }

  // Serve the inline "down" page directly
  if (subdomain === "down") {
    return new Response(downPageHtml, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // All other subdomains: try the origin (tunnel), redirect on failure
  try {
    const response = await originFetch(request);

    // 2xx, 3xx, and 4xx pass through unmodified
    if (response.status < 500) {
      return response;
    }

    // 5xx — tunnel or origin error, redirect to down page
    return Response.redirect(downUrl, 302);
  } catch {
    // Network error — tunnel is unreachable
    return Response.redirect(downUrl, 302);
  }
}
