import { describe, test, expect } from "bun:test";
import { createMockClient } from "../helpers/mock-client.js";
import { makeConfig, TEST_ZONE_ID } from "../helpers/fixtures.js";
import { syncRedirectRule } from "../../src/sync/redirects.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Test helpers ---

/** Runs redirect rule sync against a mock client. */
async function runRedirectSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
) {
  return syncRedirectRule(
    mockClient.client as unknown as Parameters<typeof syncRedirectRule>[0],
    config,
    TEST_ZONE_ID,
  );
}

// --- Tests ---

describe("syncRedirectRule", () => {
  test("creates a bare domain redirect rule if it does not exist", async () => {
    const mockClient = createMockClient();
    const config = makeConfig();

    await runRedirectSync(mockClient, config);

    const updates = mockClient.getCalls("rulesets.phases.update");
    expect(updates.length).toBe(1);

    const params = updates[0][1] as { rules: Array<{ expression: string; action: string; action_parameters?: unknown }> };
    expect(params.rules.length).toBe(1);
    expect(params.rules[0].expression).toBe(`(http.host eq "example.com")`);
    expect(params.rules[0].action).toBe("redirect");
    expect(params.rules[0].action_parameters).toEqual({
      from_value: {
        status_code: 301,
        target_url: { value: "https://www.example.com" },
        preserve_query_string: true,
      },
    });
  });

  test("skips creating a redirect rule if an identical expression already exists", async () => {
    const mockClient = createMockClient();
    mockClient.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "rule-1",
          expression: `(http.host eq "example.com")`,
          action: "redirect",
          description: "Redirect bare domain",
        },
      ],
    });

    const config = makeConfig();
    await runRedirectSync(mockClient, config);

    // Should not call update (rule already exists)
    const updates = mockClient.getCalls("rulesets.phases.update");
    expect(updates.length).toBe(0);
  });

  test("running redirect sync twice does not create duplicate rules", async () => {
    const mockClient = createMockClient();
    const config = makeConfig();

    // First sync
    await runRedirectSync(mockClient, config);
    const updatesAfterFirst = mockClient.getCalls("rulesets.phases.update").length;
    expect(updatesAfterFirst).toBe(1);

    // Second sync — now the ruleset has the rule from the first sync
    await runRedirectSync(mockClient, config);
    const updatesAfterSecond = mockClient.getCalls("rulesets.phases.update").length;
    // No additional update on the second run
    expect(updatesAfterSecond).toBe(1);
  });

  test("uses the correct domain from config (not hardcoded)", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({ domain: "mycoolsite.io" });

    await runRedirectSync(mockClient, config);

    const updates = mockClient.getCalls("rulesets.phases.update");
    const params = updates[0][1] as { rules: Array<{ expression: string; action_parameters?: { from_value?: { target_url?: { value: string } } } }> };
    expect(params.rules[0].expression).toBe(`(http.host eq "mycoolsite.io")`);
    expect(params.rules[0].action_parameters!.from_value!.target_url!.value).toBe(
      "https://www.mycoolsite.io",
    );
  });

  test("existing rules in the phase ruleset are preserved when appending", async () => {
    const mockClient = createMockClient();
    mockClient.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "existing-rule-1",
          expression: `(http.host eq "other.com")`,
          action: "redirect",
          description: "Some other redirect",
        },
      ],
    });

    const config = makeConfig();
    await runRedirectSync(mockClient, config);

    const updates = mockClient.getCalls("rulesets.phases.update");
    const params = updates[0][1] as { rules: Array<{ expression: string; id?: string }> };

    // Should have 2 rules: existing + new
    expect(params.rules.length).toBe(2);

    // Existing rule is preserved with its ID
    expect(params.rules[0].id).toBe("existing-rule-1");
    expect(params.rules[0].expression).toBe(`(http.host eq "other.com")`);

    // New rule is appended
    expect(params.rules[1].expression).toBe(`(http.host eq "example.com")`);
  });

  test("handles empty phase ruleset (first-time creation)", async () => {
    const mockClient = createMockClient();
    // No ruleset set — phases.get will throw
    const config = makeConfig();

    await runRedirectSync(mockClient, config);

    // Should have attempted to get and then created via update
    const gets = mockClient.getCalls("rulesets.phases.get");
    expect(gets.length).toBe(1);

    const updates = mockClient.getCalls("rulesets.phases.update");
    expect(updates.length).toBe(1);
    const params = updates[0][1] as { rules: Array<{ expression: string }> };
    expect(params.rules.length).toBe(1);
  });
});
