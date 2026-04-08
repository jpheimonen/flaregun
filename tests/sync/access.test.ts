import { describe, test, expect } from "bun:test";
import { createMockClient } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ACCOUNT_ID,
} from "../helpers/fixtures.js";
import {
  syncAccessApplications,
  syncAccessPolicies,
  ADMIN_LOCK_KEY,
  type ManagedApp,
} from "../../src/sync/access.js";
import { emptyState, type LockState } from "../../src/lock/index.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Test helpers ---

/** Runs the Access Applications sync step against a mock client. */
async function runAppSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
  lockState: LockState,
): Promise<ManagedApp[]> {
  return syncAccessApplications(
    mockClient.client as unknown as Parameters<typeof syncAccessApplications>[0],
    config,
    TEST_ACCOUNT_ID,
    lockState,
  );
}

/** Runs the Access Policies sync step against a mock client. */
async function runPolicySync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
  managedApps: ManagedApp[],
): Promise<void> {
  return syncAccessPolicies(
    mockClient.client as unknown as Parameters<typeof syncAccessPolicies>[0],
    config,
    TEST_ACCOUNT_ID,
    managedApps,
  );
}

/** Runs full access sync (applications + policies). */
async function runFullAccessSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
  lockState: LockState,
): Promise<ManagedApp[]> {
  const managedApps = await runAppSync(mockClient, config, lockState);
  await runPolicySync(mockClient, config, managedApps);
  return managedApps;
}

// --- Access Application Tests ---

describe("sync: Access Applications", () => {
  test("a service with admin_only auth results in an Access application being created for its subdomain", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);

    // Should have blog + implicit admin
    const blogApp = managedApps.find((a) => a.name === "blog");
    expect(blogApp).toBeDefined();
    expect(blogApp!.hostname).toBe("blog.example.com");

    // Verify create was called for blog
    const createCalls = mockClient.getCalls("applications.create");
    const blogCreate = createCalls.find(
      (args) => (args[0] as { domain: string }).domain === "blog.example.com",
    );
    expect(blogCreate).toBeDefined();
  });

  test("a service with authorized auth results in an Access application being created for its subdomain", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["user@example.com"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);

    const apiApp = managedApps.find((a) => a.name === "api");
    expect(apiApp).toBeDefined();
    expect(apiApp!.hostname).toBe("api.example.com");

    const createCalls = mockClient.getCalls("applications.create");
    const apiCreate = createCalls.find(
      (args) => (args[0] as { domain: string }).domain === "api.example.com",
    );
    expect(apiCreate).toBeDefined();
  });

  test("a service with public auth does not result in an Access application being created", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        homepage: pagesService("www", "public"),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);

    // Only admin app should exist
    expect(managedApps).toHaveLength(1);
    expect(managedApps[0].name).toBe(ADMIN_LOCK_KEY);

    // Only 1 create call (for admin)
    expect(mockClient.getCalls("applications.create")).toHaveLength(1);
  });

  test("if an Access application already exists for the subdomain, no new application is created (idempotency)", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig();

    // First sync creates apps
    await runAppSync(mockClient, config, lockState);
    const firstRunCreates = mockClient.getCalls("applications.create").length;
    expect(firstRunCreates).toBe(2); // blog + admin

    // Second sync finds existing apps — no new creates
    await runAppSync(mockClient, config, lockState);
    expect(mockClient.getCalls("applications.create")).toHaveLength(
      firstRunCreates,
    ); // still 2
  });

  test("running the access sync twice with identical config makes zero create calls on the second run", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig();

    // First sync
    await runAppSync(mockClient, config, lockState);
    const afterFirstSync = mockClient.getCalls("applications.create").length;

    // Second sync
    await runAppSync(mockClient, config, lockState);
    const afterSecondSync = mockClient.getCalls("applications.create").length;

    // No new creates on the second run
    expect(afterSecondSync - afterFirstSync).toBe(0);
  });

  test("the admin subdomain always gets an Access application (implicit service)", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // Config with no user services
    const config = makeConfig({ services: {} });

    const managedApps = await runAppSync(mockClient, config, lockState);

    // Should have exactly the implicit admin app
    expect(managedApps).toHaveLength(1);
    expect(managedApps[0].name).toBe(ADMIN_LOCK_KEY);
    expect(managedApps[0].hostname).toBe("admin.example.com");

    // Exactly 1 create call
    expect(mockClient.getCalls("applications.create")).toHaveLength(1);
    const createParams = mockClient.getCalls("applications.create")[0][0] as {
      domain: string;
    };
    expect(createParams.domain).toBe("admin.example.com");
  });

  test("the admin subdomain is always created even when config has multiple services", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized"),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);

    const adminApp = managedApps.find((a) => a.name === ADMIN_LOCK_KEY);
    expect(adminApp).toBeDefined();
    expect(adminApp!.hostname).toBe("admin.example.com");
  });

  test("adding a new service creates only that service's application", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // First sync: just blog
    const config1 = makeConfig({
      services: { blog: pagesService("blog", "admin_only") },
    });
    await runAppSync(mockClient, config1, lockState);
    expect(mockClient.getCalls("applications.create")).toHaveLength(2); // blog + admin

    // Second sync: blog + api
    const config2 = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized"),
      },
    });
    await runAppSync(mockClient, config2, lockState);

    // Only 1 additional create call (for api) — total 3
    expect(mockClient.getCalls("applications.create")).toHaveLength(3);
  });

  test("a service removed from config results in its Access application being deleted via the SDK", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // First sync: blog + api
    const config1 = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized"),
      },
    });
    const apps1 = await runAppSync(mockClient, config1, lockState);
    expect(mockClient.getApps()).toHaveLength(3); // blog, api, admin
    const apiApp = apps1.find((a) => a.name === "api");
    expect(apiApp).toBeDefined();

    // Verify lock state has api entry
    expect(lockState.access["api"]).toBeDefined();
    const apiAppId = lockState.access["api"].app_id;

    // Second sync: only blog (api removed from config)
    const config2 = makeConfig({
      services: { blog: pagesService("blog", "admin_only") },
    });
    await runAppSync(mockClient, config2, lockState);

    // Delete was called for api's app
    const deleteCalls = mockClient.getCalls("applications.delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe(apiAppId);

    // Lock state no longer has api entry
    expect(lockState.access["api"]).toBeUndefined();

    // Remote state no longer has api app
    expect(mockClient.getApps()).toHaveLength(2); // blog, admin
  });

  test("a service that changes from authorized to public results in its Access application being deleted", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // First sync: blog with authorized auth
    const config1 = makeConfig({
      services: { blog: pagesService("blog", "authorized") },
    });
    await runAppSync(mockClient, config1, lockState);
    expect(lockState.access["blog"]).toBeDefined();
    const blogAppId = lockState.access["blog"].app_id;

    // Second sync: blog changes to public
    const config2 = makeConfig({
      services: { blog: pagesService("blog", "public") },
    });
    await runAppSync(mockClient, config2, lockState);

    // Delete was called for blog's app
    const deleteCalls = mockClient.getCalls("applications.delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe(blogAppId);

    // Lock state no longer has blog entry
    expect(lockState.access["blog"]).toBeUndefined();
  });

  test("a service that changes from public to authorized results in a new Access application being created", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // First sync: blog with public auth
    const config1 = makeConfig({
      services: { blog: pagesService("blog", "public") },
    });
    await runAppSync(mockClient, config1, lockState);
    // Only admin app created
    expect(mockClient.getCalls("applications.create")).toHaveLength(1);
    expect(lockState.access["blog"]).toBeUndefined();

    // Second sync: blog changes to authorized
    const config2 = makeConfig({
      services: { blog: pagesService("blog", "authorized") },
    });
    const apps2 = await runAppSync(mockClient, config2, lockState);

    // Blog app created on second sync
    expect(mockClient.getCalls("applications.create")).toHaveLength(2); // admin (1st run) + blog (2nd run)
    const blogApp = apps2.find((a) => a.name === "blog");
    expect(blogApp).toBeDefined();
    expect(blogApp!.hostname).toBe("blog.example.com");
  });

  test("application IDs are stored in the lock file state after creation", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized"),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);

    // Lock state should have entries for all managed apps
    for (const app of managedApps) {
      expect(lockState.access[app.name]).toBeDefined();
      expect(lockState.access[app.name].app_id).toBe(app.id);
    }

    // Specifically check each expected key
    expect(lockState.access["blog"]).toBeDefined();
    expect(lockState.access["api"]).toBeDefined();
    expect(lockState.access[ADMIN_LOCK_KEY]).toBeDefined();
  });
});

// --- Access Policy Tests ---

describe("sync: Access Policies", () => {
  test("an admin_only service gets a policy with only the superuser emails as allowed selectors", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: { blog: pagesService("blog", "admin_only") },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const blogPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "blog",
    );
    expect(blogPolicyCall).toBeDefined();

    const policyParams = blogPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
    ]);
  });

  test("an authorized service gets a policy combining superuser emails with per-service user emails", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const apiPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "api",
    );
    expect(apiPolicyCall).toBeDefined();

    const policyParams = apiPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "friend@example.com" } },
    ]);
  });

  test("wildcard domain users are converted to email_domain selectors in the policy", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["*@company.com"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const apiPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "api",
    );
    expect(apiPolicyCall).toBeDefined();

    const policyParams = apiPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email_domain: { domain: "company.com" } },
    ]);
  });

  test("exact email users are converted to email selectors in the policy", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["user1@example.com", "user2@other.com"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const apiPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "api",
    );
    expect(apiPolicyCall).toBeDefined();

    const policyParams = apiPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "user1@example.com" } },
      { email: { email: "user2@other.com" } },
    ]);
  });

  test("if a policy already exists and matches, no create or update calls are made (idempotency)", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: { blog: pagesService("blog", "admin_only") },
    });

    // First sync: creates app and policy
    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);
    expect(mockClient.getCalls("policies.create")).toHaveLength(2); // blog + admin

    // Second sync: policies already exist and match
    await runPolicySync(mockClient, config, managedApps);
    expect(mockClient.getCalls("policies.create")).toHaveLength(2); // still 2
    expect(mockClient.getCalls("policies.update")).toHaveLength(0); // no updates
  });

  test("when the user list changes for a service, the existing policy is updated with the new selectors", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    const config1 = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com"],
        }),
      },
    });

    // First sync: creates app and policy
    const managedApps = await runAppSync(mockClient, config1, lockState);
    await runPolicySync(mockClient, config1, managedApps);
    expect(mockClient.getCalls("policies.create")).toHaveLength(2); // api + admin

    // Second sync: user list changed
    const config2 = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com", "newuser@example.com"],
        }),
      },
    });

    await runPolicySync(mockClient, config2, managedApps);

    // Policy was updated, not recreated
    expect(mockClient.getCalls("policies.create")).toHaveLength(2); // still 2
    expect(mockClient.getCalls("policies.update").length).toBeGreaterThanOrEqual(1);

    // Find the update call for the api policy
    const updateCalls = mockClient.getCalls("policies.update");
    const apiUpdateCall = updateCalls.find(
      (args) => (args[2] as { name: string }).name === "api",
    );
    expect(apiUpdateCall).toBeDefined();

    const updatedParams = apiUpdateCall![2] as { include: unknown[] };
    expect(updatedParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "friend@example.com" } },
      { email: { email: "newuser@example.com" } },
    ]);
  });

  test("when superusers change, the existing policy is updated with the new selectors", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    const config1 = makeConfig({
      superusers: ["admin@example.com"],
      services: { blog: pagesService("blog", "admin_only") },
    });

    const managedApps = await runAppSync(mockClient, config1, lockState);
    await runPolicySync(mockClient, config1, managedApps);
    expect(mockClient.getCalls("policies.create")).toHaveLength(2);

    // Change superusers
    const config2 = makeConfig({
      superusers: ["admin@example.com", "newadmin@example.com"],
      services: { blog: pagesService("blog", "admin_only") },
    });

    await runPolicySync(mockClient, config2, managedApps);

    // Policy was updated
    expect(mockClient.getCalls("policies.update").length).toBeGreaterThanOrEqual(1);
  });

  test("superusers are always included in every non-public policy", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com", "boss@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const apiPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "api",
    );
    expect(apiPolicyCall).toBeDefined();

    const policyParams = apiPolicyCall![1] as { include: unknown[] };
    // Superusers should come first, then service users
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "boss@example.com" } },
      { email: { email: "friend@example.com" } },
    ]);
  });

  test("the implicit admin service gets a policy with only superuser selectors", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {},
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    expect(createCalls).toHaveLength(1); // only admin

    const adminPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === ADMIN_LOCK_KEY,
    );
    expect(adminPolicyCall).toBeDefined();

    const policyParams = adminPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
    ]);
  });

  test("mixed wildcard and exact email users produce correct selectors", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com", "*@company.com", "boss@other.org"],
        }),
      },
    });

    const managedApps = await runAppSync(mockClient, config, lockState);
    await runPolicySync(mockClient, config, managedApps);

    const createCalls = mockClient.getCalls("policies.create");
    const apiPolicyCall = createCalls.find(
      (args) => (args[1] as { name: string }).name === "api",
    );
    expect(apiPolicyCall).toBeDefined();

    const policyParams = apiPolicyCall![1] as { include: unknown[] };
    expect(policyParams.include).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "friend@example.com" } },
      { email_domain: { domain: "company.com" } },
      { email: { email: "boss@other.org" } },
    ]);
  });
});

// --- Combined Access Sync Tests ---

describe("sync: Combined Access Sync", () => {
  test("a full access sync for a multi-service config creates the expected applications and policies", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com"],
        }),
        homepage: pagesService("www", "public"),
      },
    });

    const managedApps = await runFullAccessSync(mockClient, config, lockState);

    // 3 managed apps: blog, api, admin (homepage is public → skipped)
    expect(managedApps).toHaveLength(3);
    const appNames = managedApps.map((a) => a.name).sort();
    expect(appNames).toEqual([ADMIN_LOCK_KEY, "api", "blog"]);

    // 3 create calls for apps
    expect(mockClient.getCalls("applications.create")).toHaveLength(3);

    // 3 create calls for policies
    expect(mockClient.getCalls("policies.create")).toHaveLength(3);

    // Verify hostnames
    expect(managedApps.find((a) => a.name === "blog")!.hostname).toBe(
      "blog.example.com",
    );
    expect(managedApps.find((a) => a.name === "api")!.hostname).toBe(
      "api.example.com",
    );
    expect(
      managedApps.find((a) => a.name === ADMIN_LOCK_KEY)!.hostname,
    ).toBe("admin.example.com");

    // Lock state has entries for all non-public services + admin
    expect(Object.keys(lockState.access).sort()).toEqual([
      ADMIN_LOCK_KEY,
      "api",
      "blog",
    ]);

    // No homepage entry
    expect(lockState.access["homepage"]).toBeUndefined();
  });

  test("running the full access sync twice with identical config produces zero create/delete calls on the second run", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized", {
          users: ["friend@example.com"],
        }),
      },
    });

    // First full sync
    await runFullAccessSync(mockClient, config, lockState);
    const afterFirst = {
      creates: mockClient.getCalls("applications.create").length,
      deletes: mockClient.getCalls("applications.delete").length,
      policyCreates: mockClient.getCalls("policies.create").length,
      policyUpdates: mockClient.getCalls("policies.update").length,
    };

    // Second full sync with identical config
    await runFullAccessSync(mockClient, config, lockState);
    const afterSecond = {
      creates: mockClient.getCalls("applications.create").length,
      deletes: mockClient.getCalls("applications.delete").length,
      policyCreates: mockClient.getCalls("policies.create").length,
      policyUpdates: mockClient.getCalls("policies.update").length,
    };

    // No new creates, deletes, or updates
    expect(afterSecond.creates - afterFirst.creates).toBe(0);
    expect(afterSecond.deletes - afterFirst.deletes).toBe(0);
    expect(afterSecond.policyCreates - afterFirst.policyCreates).toBe(0);
    expect(afterSecond.policyUpdates - afterFirst.policyUpdates).toBe(0);
  });

  test("full access sync with removal creates apps first run and deletes removed services on second", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    // First sync: blog + api
    const config1 = makeConfig({
      superusers: ["admin@example.com"],
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000, "authorized"),
      },
    });
    await runFullAccessSync(mockClient, config1, lockState);
    expect(mockClient.getCalls("applications.create")).toHaveLength(3); // blog, api, admin
    expect(mockClient.getCalls("policies.create")).toHaveLength(3);

    // Second sync: only blog (api removed)
    const config2 = makeConfig({
      superusers: ["admin@example.com"],
      services: { blog: pagesService("blog", "admin_only") },
    });
    await runFullAccessSync(mockClient, config2, lockState);

    // One delete call for api
    expect(mockClient.getCalls("applications.delete")).toHaveLength(1);

    // No new app creates on second run (blog and admin already exist)
    expect(mockClient.getCalls("applications.create")).toHaveLength(3); // still 3

    // Lock state updated: api removed, blog + admin remain
    expect(lockState.access["api"]).toBeUndefined();
    expect(lockState.access["blog"]).toBeDefined();
    expect(lockState.access[ADMIN_LOCK_KEY]).toBeDefined();
  });
});

// --- Mock Client Tests ---

describe("mock Cloudflare SDK client", () => {
  test("tracks all API calls and supports delete operations", async () => {
    const mockClient = createMockClient();

    // List (returns empty)
    const listResult = mockClient.client.zeroTrust.access.applications.list({
      account_id: TEST_ACCOUNT_ID,
    });
    const items: unknown[] = [];
    for await (const item of listResult) {
      items.push(item);
    }
    expect(items).toHaveLength(0);
    expect(mockClient.getCalls("applications.list")).toHaveLength(1);

    // Create
    const created = await mockClient.client.zeroTrust.access.applications.create(
      {
        account_id: TEST_ACCOUNT_ID,
        name: "test",
        domain: "test.example.com",
        type: "self_hosted",
      },
    );
    expect(created).toHaveProperty("id");
    expect(created).toHaveProperty("name", "test");
    expect(mockClient.getCalls("applications.create")).toHaveLength(1);
    expect(mockClient.getApps()).toHaveLength(1);

    // Delete
    await mockClient.client.zeroTrust.access.applications.delete(
      (created as { id: string }).id,
      { account_id: TEST_ACCOUNT_ID },
    );
    expect(mockClient.getCalls("applications.delete")).toHaveLength(1);
    expect(mockClient.getApps()).toHaveLength(0);
  });

  test("policy delete removes from in-memory store", async () => {
    const mockClient = createMockClient();

    // Create app
    const app = (await mockClient.client.zeroTrust.access.applications.create({
      account_id: TEST_ACCOUNT_ID,
      name: "test",
      domain: "test.example.com",
      type: "self_hosted",
    })) as { id: string };

    // Create policy
    const policy =
      (await mockClient.client.zeroTrust.access.applications.policies.create(
        app.id,
        {
          account_id: TEST_ACCOUNT_ID,
          name: "test",
          decision: "allow",
          include: [],
        },
      )) as { id: string };

    expect(mockClient.getPolicies()[app.id]).toHaveLength(1);

    // Delete policy
    await mockClient.client.zeroTrust.access.applications.policies.delete(
      app.id,
      policy.id,
      { account_id: TEST_ACCOUNT_ID },
    );

    expect(mockClient.getPolicies()[app.id]).toHaveLength(0);
    expect(mockClient.getCalls("policies.delete")).toHaveLength(1);
  });

  test("state manipulation methods work correctly", () => {
    const mockClient = createMockClient();

    // Set and get apps
    mockClient.setApps([
      { id: "app-1", name: "test", domain: "test.example.com", type: "self_hosted" },
    ]);
    expect(mockClient.getApps()).toHaveLength(1);

    // Set and get policies
    mockClient.setPolicies({
      "app-1": [
        {
          id: "policy-1",
          name: "test",
          decision: "allow",
          include: [{ email: { email: "admin@example.com" } }],
        },
      ],
    });
    expect(mockClient.getPolicies()["app-1"]).toHaveLength(1);
  });

  test("application delete cascades to associated policies", async () => {
    const mockClient = createMockClient();

    // Create app
    const app = (await mockClient.client.zeroTrust.access.applications.create({
      account_id: TEST_ACCOUNT_ID,
      name: "test",
      domain: "test.example.com",
      type: "self_hosted",
    })) as { id: string };

    // Create policy
    await mockClient.client.zeroTrust.access.applications.policies.create(
      app.id,
      {
        account_id: TEST_ACCOUNT_ID,
        name: "test",
        decision: "allow",
        include: [],
      },
    );

    expect(mockClient.getPolicies()[app.id]).toHaveLength(1);

    // Delete app — policies should cascade
    await mockClient.client.zeroTrust.access.applications.delete(app.id, {
      account_id: TEST_ACCOUNT_ID,
    });

    expect(mockClient.getApps()).toHaveLength(0);
    expect(mockClient.getPolicies()[app.id]).toBeUndefined();
  });
});
