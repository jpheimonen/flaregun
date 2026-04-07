import { describe, test, expect } from "bun:test";
import { createMockClient } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ACCOUNT_ID,
  TEST_TUNNEL_ID,
  TEST_ZONE_ID,
} from "../helpers/fixtures.js";
import { syncFull, type SyncCredentials } from "../../src/sync/index.js";
import { emptyState, type LockState } from "../../src/lock/index.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Constants ---

const ADMIN_PORT = 9000;

const CREDENTIALS: SyncCredentials = {
  accountId: TEST_ACCOUNT_ID,
  zoneId: TEST_ZONE_ID,
  tunnelId: TEST_TUNNEL_ID,
};

// --- Test helpers ---

/** Runs a full sync against a mock client, tracking lock saves. */
async function runFullSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
  lockState?: LockState,
) {
  const state = lockState ?? emptyState();
  const lockSaves: LockState[] = [];
  const saveLock = (s: LockState) => {
    // Deep clone to capture the state at save time
    lockSaves.push(JSON.parse(JSON.stringify(s)));
  };

  const result = await syncFull(
    mockClient.client as unknown as Parameters<typeof syncFull>[0],
    config,
    CREDENTIALS,
    state,
    saveLock,
    ADMIN_PORT,
  );

  return { result, lockState: state, lockSaves };
}

// --- Tests ---

describe("syncFull", () => {
  test("creates all expected resources for a multi-service config", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized", { users: ["dev@test.com"] }),
      },
    });

    const { result } = await runFullSync(mockClient, config);

    // All 5 steps should be listed
    expect(result.steps.length).toBe(5);
    expect(result.steps.every((s) => s.success)).toBe(true);

    // Access apps: blog + api + admin = 3
    const appCreates = mockClient.getCalls("applications.create");
    expect(appCreates.length).toBe(3);

    // Policies: one per app = 3
    const policyCreates = mockClient.getCalls("policies.create");
    expect(policyCreates.length).toBe(3);

    // Tunnel ingress: pushed
    const ingressUpdates = mockClient.getCalls("tunnelConfig.update");
    expect(ingressUpdates.length).toBe(1);

    // DNS records: wildcard + blog CNAME + www CNAME = 3
    const dnsCreates = mockClient.getCalls("dns.records.create");
    expect(dnsCreates.length).toBe(3);

    // Redirect rule: created
    const rulesetUpdates = mockClient.getCalls("rulesets.phases.update");
    expect(rulesetUpdates.length).toBe(1);
  });

  test("a second sync with identical config makes zero additional create calls (except tunnel ingress)", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000),
      },
    });

    // First sync
    const lockState = emptyState();
    const saveLock = () => {};
    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    const firstAppCreates = mockClient.getCalls("applications.create").length;
    const firstPolicyCreates = mockClient.getCalls("policies.create").length;
    const firstDnsCreates = mockClient.getCalls("dns.records.create").length;
    const firstRulesetUpdates = mockClient.getCalls("rulesets.phases.update").length;
    const firstIngressUpdates = mockClient.getCalls("tunnelConfig.update").length;

    expect(firstAppCreates).toBeGreaterThan(0);
    expect(firstPolicyCreates).toBeGreaterThan(0);
    expect(firstDnsCreates).toBeGreaterThan(0);
    expect(firstRulesetUpdates).toBe(1);
    expect(firstIngressUpdates).toBe(1);

    // Second sync — same config, same lock state
    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    // Zero additional creates
    expect(mockClient.getCalls("applications.create").length).toBe(firstAppCreates);
    expect(mockClient.getCalls("policies.create").length).toBe(firstPolicyCreates);
    expect(mockClient.getCalls("dns.records.create").length).toBe(firstDnsCreates);

    // Redirect should be skipped (already exists)
    expect(mockClient.getCalls("rulesets.phases.update").length).toBe(firstRulesetUpdates);

    // Tunnel ingress is always pushed (full replacement)
    expect(mockClient.getCalls("tunnelConfig.update").length).toBe(firstIngressUpdates + 1);
  });

  test("full sync after removing a service cleans up Access resources and updates ingress/DNS", async () => {
    const mockClient = createMockClient();

    // First sync with two services
    const config1 = makeConfig({
      services: {
        blog: pagesService("blog"),
        api: localService("api", 3000),
      },
    });

    const lockState = emptyState();
    const saveLock = () => {};
    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config1,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    // Verify api exists in lock state
    expect(lockState.access["api"]).toBeDefined();

    // Second sync without 'api' service
    const config2 = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config2,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    // api access app should have been deleted
    const appDeletes = mockClient.getCalls("applications.delete");
    expect(appDeletes.length).toBeGreaterThan(0);

    // api should be removed from lock state
    expect(lockState.access["api"]).toBeUndefined();

    // Tunnel ingress should not include api.example.com
    const ingressCalls = mockClient.getCalls("tunnelConfig.update");
    const lastIngress = ingressCalls[ingressCalls.length - 1];
    const params = lastIngress[1] as { config: { ingress: Array<{ hostname: string }> } };
    const apiRule = params.config.ingress.find(
      (r) => r.hostname === "api.example.com",
    );
    expect(apiRule).toBeUndefined();
  });

  test("the lock file is saved after each sync step that mutates state", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog"),
        api: localService("api", 3000),
      },
    });

    const { lockSaves, result } = await runFullSync(mockClient, config);

    // 5 successful steps = 5 lock saves
    expect(result.steps.length).toBe(5);
    expect(result.steps.filter((s) => s.success).length).toBe(5);
    expect(lockSaves.length).toBe(5);
  });

  test("the redirect step failing does not cause the full sync to fail", async () => {
    const mockClient = createMockClient();

    // Override rulesets.phases.get to always throw
    (mockClient.client.rulesets.phases as { get: (...args: unknown[]) => Promise<unknown> }).get =
      async () => { throw new Error("No ruleset"); };
    // Override rulesets.phases.update to always throw
    (mockClient.client.rulesets.phases as { update: (...args: unknown[]) => Promise<unknown> }).update =
      async () => { throw new Error("Permission denied: zone rulesets"); };

    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    const { result, lockSaves } = await runFullSync(mockClient, config);

    // First 4 steps succeeded
    const successSteps = result.steps.filter((s) => s.success);
    expect(successSteps.length).toBe(4);

    // Redirect step failed but didn't crash the sync
    const redirectStep = result.steps.find((s) => s.step === "redirect-rules");
    expect(redirectStep).toBeDefined();
    expect(redirectStep!.success).toBe(false);
    expect(redirectStep!.error).toContain("Permission denied");

    // Lock was saved for the 4 successful steps, not for the failed redirect
    expect(lockSaves.length).toBe(4);
  });

  test("sync steps execute in the correct dependency order", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    const { result } = await runFullSync(mockClient, config);

    const stepOrder = result.steps.map((s) => s.step);
    expect(stepOrder).toEqual([
      "access-applications",
      "access-policies",
      "tunnel-ingress",
      "dns-records",
      "redirect-rules",
    ]);
  });

  test("full sync after adding a new service creates only the new service's resources", async () => {
    const mockClient = createMockClient();

    // First sync with blog only
    const config1 = makeConfig({
      services: { blog: pagesService("blog") },
    });

    const lockState = emptyState();
    const saveLock = () => {};
    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config1,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    const firstAppCreates = mockClient.getCalls("applications.create").length;
    const firstDnsCreates = mockClient.getCalls("dns.records.create").length;

    // Second sync with blog + api
    const config2 = makeConfig({
      services: {
        blog: pagesService("blog"),
        api: localService("api", 3000),
      },
    });

    await syncFull(
      mockClient.client as unknown as Parameters<typeof syncFull>[0],
      config2,
      CREDENTIALS,
      lockState,
      saveLock,
      ADMIN_PORT,
    );

    // Only api's Access app should be newly created
    const totalAppCreates = mockClient.getCalls("applications.create").length;
    expect(totalAppCreates).toBe(firstAppCreates + 1); // one new app for api

    // DNS: no new per-service CNAME for api (it's local, not Pages)
    // but the existing blog/wildcard/www records should not be duplicated
    const totalDnsCreates = mockClient.getCalls("dns.records.create").length;
    expect(totalDnsCreates).toBe(firstDnsCreates); // no new DNS for local service
  });

  test("sync result includes all step names", async () => {
    const mockClient = createMockClient();
    const config = makeConfig();

    const { result } = await runFullSync(mockClient, config);

    expect(result.steps.map((s) => s.step)).toContain("access-applications");
    expect(result.steps.map((s) => s.step)).toContain("access-policies");
    expect(result.steps.map((s) => s.step)).toContain("tunnel-ingress");
    expect(result.steps.map((s) => s.step)).toContain("dns-records");
    expect(result.steps.map((s) => s.step)).toContain("redirect-rules");
  });
});
