/**
 * Sync engine: Bare domain redirect rule.
 *
 * Ensures a bare-domain-to-www 301 redirect rule exists in the
 * http_request_dynamic_redirect phase ruleset. This redirects
 * example.com → https://www.example.com with query string preservation.
 *
 * Idempotent: checks for an existing matching expression before appending.
 * Preserves all existing rules in the phase ruleset.
 */

import type { CloudflareClient } from "../cloudflare/index.js";
import type { FlaregunConfig } from "../config/index.js";

/** Shape of a rule in the redirect phase ruleset. */
interface RedirectRule {
  id?: string;
  expression?: string;
  action?: string;
  description?: string;
}

/** Shape of the redirect phase ruleset from the API. */
interface RedirectRuleset {
  id?: string;
  rules?: RedirectRule[];
}

/**
 * Syncs the bare-domain-to-www redirect rule.
 *
 * - Reads the existing http_request_dynamic_redirect phase ruleset
 * - If no matching redirect expression exists, appends a 301 redirect rule
 * - Preserves all existing rules in the ruleset
 * - If the phase ruleset doesn't exist, treats it as empty and creates via update
 *
 * @param client - Cloudflare SDK client
 * @param config - Parsed flaregun config
 * @param zoneId - Cloudflare zone ID
 */
export async function syncRedirectRule(
  client: CloudflareClient,
  config: FlaregunConfig,
  zoneId: string,
): Promise<void> {
  const redirectExpression = `(http.host eq "${config.domain}")`;
  const redirectTargetUrl = `https://www.${config.domain}`;

  // Try to get existing redirect rules in the http_request_dynamic_redirect phase
  let existingRuleset: RedirectRuleset | null = null;

  try {
    const result = await client.rulesets.phases.get(
      "http_request_dynamic_redirect",
      { zone_id: zoneId },
    );
    existingRuleset = result as unknown as RedirectRuleset;
  } catch {
    // Phase ruleset doesn't exist yet — will create via update
  }

  const existingRules = existingRuleset?.rules ?? [];

  // Check if a matching redirect rule already exists
  const hasRedirectRule = existingRules.some(
    (rule) =>
      rule.action === "redirect" && rule.expression === redirectExpression,
  );

  if (hasRedirectRule) {
    // Already exists — skip (idempotent)
    return;
  }

  // Build the combined rules array: preserve existing + append new redirect
  const updatedRules = [
    ...existingRules.map((rule) => ({
      id: rule.id,
      expression: rule.expression!,
      action: rule.action! as "redirect",
      description: rule.description,
    })),
    {
      expression: redirectExpression,
      action: "redirect" as const,
      description: `Redirect bare domain ${config.domain} to www`,
      action_parameters: {
        from_value: {
          status_code: 301 as const,
          target_url: { value: redirectTargetUrl },
          preserve_query_string: true,
        },
      },
    },
  ];

  // Push the updated rules — the SDK's union type constraints require a type assertion
  await client.rulesets.phases.update("http_request_dynamic_redirect", {
    zone_id: zoneId,
    rules: updatedRules,
  } as Parameters<typeof client.rulesets.phases.update>[1]);
}
