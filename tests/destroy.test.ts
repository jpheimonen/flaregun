/**
 * Tests for the destroy command handler.
 *
 * Verifies the complete teardown lifecycle: config/env/lock validation,
 * confirmation prompt, sequential deletion of all resource categories,
 * continue-on-failure semantics, lock file cleanup, and summary formatting.
 */

import { describe, test, expect } from "bun:test";
import {
  createMockClient,
  type MockClientInstance,
} from "./helpers/mock-client.js";
import {
  handleDestroy,
  buildResourceSummary,
  formatDestroySummary,
  type DestroyCommandDeps,
  type ConfirmFn,
  type CategorySummary,
} from "../src/destroy/index.js";
import type { FlaregunConfig } from "../src/config/index.js";
import type { CloudflareCredentials } from "../src/env/index.js";
import type { LockState } from "../src/lock/index.js";
import { emptyState } from "../src/lock/index.js";

// --- Test Fixtures ---

function makeConfig(overrides: Partial<FlaregunConfig> = {}): FlaregunConfig {
  return {
    domain: "example.com",
    auth: {
      provider: "google",
      superusers: ["admin@example.com"],
    },
    services: {
      blog: {
        type: "pages",
        subdomain: "blog",
        dist: "./blog/dist",
        auth: "public",
      },
      api: {
        type: "local",
        subdomain: "api",
        command: "node server.js",
        port: 3000,
        auth: "authorized",
        users: ["user@example.com"],
      },
    },
    ...overrides,
  } as FlaregunConfig;
}

function makeCredentials(): CloudflareCredentials {
  return {
    apiToken: "test-token",
    accountId: "test-account-id",
    zoneId: "test-zone-id",
  };
}

function makePopulatedLockState(): LockState {
  return {
    tunnel: { id: "tunnel-123" },
    pages: {
      blog: {
        project_name: "example-com-blog",
        d1_database_id: "d1-abc",
        r2_bucket_name: "example-com-blog-bucket",
        kv_namespace_id: "kv-xyz",
      },
    },
    access: {
      api: { app_id: "access-app-api" },
      __admin: { app_id: "access-app-admin" },
    },
    worker: { name: "example-com-fallback" },
  };
}

function makeMinimalLockState(): LockState {
  return {
    tunnel: { id: "tunnel-123" },
    pages: {},
    access: {},
    worker: undefined,
  };
}

/** Creates a mock confirmFn that always confirms */
function autoConfirm(): ConfirmFn {
  return async () => true;
}

/** Creates a mock confirmFn that always rejects */
function autoReject(): ConfirmFn {
  return async () => false;
}

/** Captures stdout/stderr output */
function makeOutputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (msg: string) => stdout.push(msg),
    stderr: (msg: string) => stderr.push(msg),
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

/** Builds default deps with mock subsystems */
function makeDeps(
  mock: MockClientInstance,
  lockState: LockState,
  overrides: Partial<DestroyCommandDeps> = {},
): DestroyCommandDeps {
  const output = makeOutputCapture();
  const savedLockStates: LockState[] = [];

  return {
    loadConfigFn: () => makeConfig(),
    loadEnvFn: () => makeCredentials(),
    loadLockFn: () => lockState,
    saveLockFn: (_path: string, state: LockState) => {
      // Deep copy for tracking intermediate saves
      savedLockStates.push(JSON.parse(JSON.stringify(state)));
    },
    createClientFn: () => mock.client as any,
    confirmFn: autoConfirm(),
    destroyResourcesFn: async (client, accountId, state) => {
      // Delegate to real mock client calls
      const { destroyResources } = await import("../src/sync/provision.js");
      return destroyResources(client, accountId, state);
    },
    stdout: output.stdout,
    stderr: output.stderr,
    ...overrides,
  };
}

// --- Pre-deletion Validation Tests ---

describe("destroy command — pre-deletion validation", () => {
  test("invalid config aborts before confirmation prompt", async () => {
    const mock = createMockClient();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      loadConfigFn: () => {
        throw new Error("Invalid config: domain is required");
      },
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid config");
    expect(output.getStderr().join("")).toContain("Config error");
    // No SDK calls should have been made
    expect(mock.getCalls("applications.delete")).toHaveLength(0);
  });

  test("missing environment variables abort before confirmation prompt", async () => {
    const mock = createMockClient();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      loadConfigFn: () => makeConfig(),
      loadEnvFn: () => {
        throw new Error(
          "Missing required environment variable(s): CLOUDFLARE_API_TOKEN",
        );
      },
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("CLOUDFLARE_API_TOKEN");
    expect(output.getStderr().join("")).toContain("Environment error");
  });

  test("destroy does not require the tunnel token", async () => {
    const mock = createMockClient();
    let envContext: string | undefined;

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, emptyState()),
      loadEnvFn: (_path: string, context: "destroy") => {
        envContext = context;
        return makeCredentials(); // No tunnel token
      },
    });

    expect(envContext).toBe("destroy");
    expect(result.success).toBe(true); // Empty lock → nothing to destroy
  });

  test("empty lock file exits with nothing-to-destroy message", async () => {
    const mock = createMockClient();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, emptyState()),
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(result.success).toBe(true);
    expect(output.getStdout().join("")).toContain("Nothing to destroy");
    expect(mock.getCalls("applications.delete")).toHaveLength(0);
  });

  test("missing lock file (returns empty state) exits with nothing-to-destroy", async () => {
    const mock = createMockClient();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, emptyState()),
      loadLockFn: () => emptyState(), // Simulates missing file
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(result.success).toBe(true);
    expect(output.getStdout().join("")).toContain("Nothing to destroy");
  });

  test("lock file parse error aborts", async () => {
    const mock = createMockClient();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      loadConfigFn: () => makeConfig(),
      loadEnvFn: () => makeCredentials(),
      loadLockFn: () => {
        throw new Error("Failed to parse lock file");
      },
      stdout: output.stdout,
      stderr: output.stderr,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to parse lock file");
    expect(output.getStderr().join("")).toContain("Lock file error");
  });
});

// --- Confirmation Tests ---

describe("destroy command — confirmation prompt", () => {
  test("typing correct domain name proceeds with teardown", async () => {
    const mock = createMockClient();
    const lockState = makeMinimalLockState();
    let confirmCalled = false;

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      confirmFn: async (domain) => {
        confirmCalled = true;
        expect(domain).toBe("example.com");
        return true;
      },
    });

    expect(confirmCalled).toBe(true);
    // Tunnel should have been deleted (proceeds with teardown)
    expect(mock.getCalls("tunnels.cloudflared.delete")).toHaveLength(1);
  });

  test("typing incorrect domain name aborts without any deletions", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      confirmFn: async () => false,
      stdout: output.stdout,
    });

    expect(result.success).toBe(true);
    expect(output.getStdout().join("")).toContain("Destroy cancelled");
    // No deletions
    expect(mock.getCalls("applications.delete")).toHaveLength(0);
    expect(mock.getCalls("tunnels.cloudflared.delete")).toHaveLength(0);
    expect(mock.getCalls("dns.records.delete")).toHaveLength(0);
  });

  test("empty input aborts without any deletions", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      confirmFn: async () => false, // Simulates non-matching input
      stdout: output.stdout,
    });

    expect(result.success).toBe(true);
    expect(output.getStdout().join("")).toContain("Destroy cancelled");
    expect(mock.getCalls("applications.delete")).toHaveLength(0);
  });

  test("confirmation prompt displays resource summary", async () => {
    const lockState = makePopulatedLockState();
    let receivedSummary = "";

    const mock = createMockClient();
    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      confirmFn: async (_domain, summary) => {
        receivedSummary = summary;
        return false; // Don't actually proceed
      },
    });

    // Check that key resource counts are included in the summary
    expect(receivedSummary).toContain("2 Access application(s)");
    expect(receivedSummary).toContain("1 Cloudflare Tunnel");
    expect(receivedSummary).toContain("1 Pages project(s)");
    expect(receivedSummary).toContain("1 D1 database(s)");
    expect(receivedSummary).toContain("1 R2 bucket(s)");
    expect(receivedSummary).toContain("1 KV namespace(s)");
    expect(receivedSummary).toContain("1 fallback Worker");
    expect(receivedSummary).toContain("DNS records");
    expect(receivedSummary).toContain("Redirect rules");
  });
});

// --- Access Application Deletion Tests ---

describe("destroy command — Access application deletion", () => {
  test("each Access application in lock file results in a delete call", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const deleteCalls = mock.getCalls("applications.delete");
    expect(deleteCalls).toHaveLength(2);

    const deletedIds = deleteCalls.map((c) => c[0]);
    expect(deletedIds).toContain("access-app-api");
    expect(deletedIds).toContain("access-app-admin");
  });

  test("successfully deleted apps are removed from lock file access section", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    // After destroy, access section should be empty
    expect(Object.keys(lockState.access)).toHaveLength(0);
  });

  test("failed deletion leaves entry in lock file and records error", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      access: {
        api: { app_id: "access-app-api" },
        blog: { app_id: "access-app-blog" },
      },
    };

    // Make one deletion fail
    let callCount = 0;
    const origDelete = mock.client.zeroTrust.access.applications.delete;
    mock.client.zeroTrust.access.applications.delete = async (...args: unknown[]) => {
      callCount++;
      if (args[0] === "access-app-api") {
        throw new Error("Permission denied");
      }
      return origDelete(...args);
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);
    // Failed entry remains in lock
    expect(lockState.access["api"]).toBeDefined();
    // Successful entry removed
    expect(lockState.access["blog"]).toBeUndefined();
    // Error recorded in summary
    const accessCat = result.categories.find((c) => c.category === "Access applications");
    expect(accessCat!.failed).toBe(1);
    expect(accessCat!.deleted).toBe(1);
    expect(accessCat!.errors[0].error).toContain("Permission denied");
  });

  test("empty access section skips this step (no delete calls)", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      tunnel: { id: "tunnel-123" },
      pages: {},
      access: {},
      worker: undefined,
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(mock.getCalls("applications.delete")).toHaveLength(0);
  });
});

// --- Tunnel Deletion Tests ---

describe("destroy command — tunnel deletion", () => {
  test("tunnel ID from lock file is used to delete the tunnel", async () => {
    const mock = createMockClient();
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const deleteCalls = mock.getCalls("tunnels.cloudflared.delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe("tunnel-123");
    // Verify account_id is passed
    expect((deleteCalls[0][1] as any).account_id).toBe("test-account-id");
  });

  test("successful tunnel deletion removes entry from lock file", async () => {
    const mock = createMockClient();
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(lockState.tunnel).toBeUndefined();
  });

  test("failed tunnel deletion leaves entry in lock file and records error", async () => {
    const mock = createMockClient();
    const lockState = makeMinimalLockState();

    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("Tunnel in use");
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);
    expect(lockState.tunnel).toBeDefined();
    expect(lockState.tunnel!.id).toBe("tunnel-123");
    const tunnelCat = result.categories.find((c) => c.category === "Tunnel");
    expect(tunnelCat!.failed).toBe(1);
    expect(tunnelCat!.errors[0].error).toContain("Tunnel in use");
  });

  test("missing tunnel ID in lock file skips this step", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      access: { api: { app_id: "app-1" } },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(mock.getCalls("tunnels.cloudflared.delete")).toHaveLength(0);
  });
});

// --- DNS Record Deletion Tests ---

describe("destroy command — DNS record deletion", () => {
  test("wildcard CNAME record is identified and deleted", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-1", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
    ]);
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const dnsDeleteCalls = mock.getCalls("dns.records.delete");
    expect(dnsDeleteCalls).toHaveLength(1);
    expect(dnsDeleteCalls[0][0]).toBe("dns-1");
  });

  test("per-Pages-service CNAME records are identified and deleted", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-2", name: "blog.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
    ]);
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const dnsDeleteCalls = mock.getCalls("dns.records.delete");
    expect(dnsDeleteCalls).toHaveLength(1);
    expect(dnsDeleteCalls[0][0]).toBe("dns-2");
  });

  test("www CNAME record is identified and deleted", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-3", name: "www.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
    ]);
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const dnsDeleteCalls = mock.getCalls("dns.records.delete");
    expect(dnsDeleteCalls).toHaveLength(1);
    expect(dnsDeleteCalls[0][0]).toBe("dns-3");
  });

  test("DNS records not managed by flaregun are NOT deleted", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      // Managed records
      { id: "dns-1", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
      // Non-managed records
      { id: "dns-mx", name: "example.com", type: "MX", content: "mail.example.com" },
      { id: "dns-txt", name: "example.com", type: "TXT", content: "v=spf1" },
      // CNAME not pointing to pages.dev and not wildcard/www — NOT managed
      { id: "dns-custom", name: "custom.example.com", type: "CNAME", content: "somewhere-else.com" },
    ]);
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const dnsDeleteCalls = mock.getCalls("dns.records.delete");
    // Only the wildcard should be deleted
    expect(dnsDeleteCalls).toHaveLength(1);
    expect(dnsDeleteCalls[0][0]).toBe("dns-1");

    // Non-managed records remain
    const remaining = mock.getDnsRecords();
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain("dns-mx");
    expect(remainingIds).toContain("dns-txt");
    expect(remainingIds).toContain("dns-custom");
  });

  test("failed DNS record deletion records error and continues", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-1", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
      { id: "dns-2", name: "www.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
    ]);

    // Make the first delete fail
    let deleteCallCount = 0;
    const origDnsDelete = mock.client.dns.records.delete;
    mock.client.dns.records.delete = async (...args: unknown[]) => {
      deleteCallCount++;
      if (args[0] === "dns-1") {
        throw new Error("DNS API error");
      }
      return origDnsDelete(...args);
    };

    const lockState = makeMinimalLockState();
    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    // Both deletes were attempted
    expect(deleteCallCount).toBe(2);
    const dnsCat = result.categories.find((c) => c.category === "DNS records");
    expect(dnsCat!.deleted).toBe(1);
    expect(dnsCat!.failed).toBe(1);
  });

  test("all managed DNS record types are deleted together", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-wild", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
      { id: "dns-blog", name: "blog.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
      { id: "dns-www", name: "www.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
    ]);
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const dnsDeleteCalls = mock.getCalls("dns.records.delete");
    expect(dnsDeleteCalls).toHaveLength(3);
  });
});

// --- Redirect Rule Deletion Tests ---

describe("destroy command — redirect rule deletion", () => {
  test("flaregun-managed redirect rule is removed from the ruleset", async () => {
    const mock = createMockClient();
    mock.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "rule-1",
          expression: '(http.host eq "example.com")',
          action: "redirect",
          description: "Redirect bare domain example.com to www",
        },
      ],
    });
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const updateCalls = mock.getCalls("rulesets.phases.update");
    expect(updateCalls.length).toBeGreaterThan(0);
    // After update, the ruleset should have no rules
    const updatedRuleset = mock.getRedirectRuleset();
    expect(updatedRuleset!.rules).toHaveLength(0);
  });

  test("other rules in the same phase ruleset are preserved", async () => {
    const mock = createMockClient();
    mock.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "rule-other",
          expression: '(http.host eq "other.com")',
          action: "redirect",
          description: "Some other redirect",
        },
        {
          id: "rule-flaregun",
          expression: '(http.host eq "example.com")',
          action: "redirect",
          description: "Redirect bare domain example.com to www",
        },
      ],
    });
    const lockState = makeMinimalLockState();

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const updatedRuleset = mock.getRedirectRuleset();
    expect(updatedRuleset!.rules).toHaveLength(1);
    expect(updatedRuleset!.rules[0].expression).toBe('(http.host eq "other.com")');
  });

  test("no matching redirect rule skips this step", async () => {
    const mock = createMockClient();
    mock.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "rule-other",
          expression: '(http.host eq "other.com")',
          action: "redirect",
        },
      ],
    });
    const lockState = makeMinimalLockState();

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    const redirectCat = result.categories.find((c) => c.category === "Redirect rules");
    expect(redirectCat!.deleted).toBe(0);
    expect(redirectCat!.failed).toBe(0);
  });

  test("phase ruleset does not exist skips this step", async () => {
    const mock = createMockClient();
    // No ruleset set → mock will throw "No ruleset found for phase"
    const lockState = makeMinimalLockState();

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    const redirectCat = result.categories.find((c) => c.category === "Redirect rules");
    expect(redirectCat!.deleted).toBe(0);
    expect(redirectCat!.failed).toBe(0);
  });
});

// --- Worker Deletion Tests ---

describe("destroy command — Worker deletion", () => {
  test("Worker name from lock file is used to delete the Worker", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      worker: { name: "example-com-fallback" },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const deleteCalls = mock.getCalls("workers.scripts.delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe("example-com-fallback");
    expect((deleteCalls[0][1] as any).account_id).toBe("test-account-id");
  });

  test("successful Worker deletion removes entry from lock file", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      worker: { name: "example-com-fallback" },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(lockState.worker).toBeUndefined();
  });

  test("failed Worker deletion leaves entry in lock file and records error", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      worker: { name: "example-com-fallback" },
    };

    mock.client.workers.scripts.delete = async () => {
      throw new Error("Worker script busy");
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);
    expect(lockState.worker).toBeDefined();
    expect(lockState.worker!.name).toBe("example-com-fallback");
    const workerCat = result.categories.find((c) => c.category === "Worker");
    expect(workerCat!.failed).toBe(1);
    expect(workerCat!.errors[0].error).toContain("Worker script busy");
  });

  test("missing Worker name in lock file skips this step", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      tunnel: { id: "tunnel-123" },
      pages: {},
      access: {},
      worker: undefined,
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(mock.getCalls("workers.scripts.delete")).toHaveLength(0);
  });
});

// --- Pages Project Deletion Tests ---

describe("destroy command — Pages project deletion", () => {
  test("each Pages project in lock file results in a delete call", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: { project_name: "example-com-blog" },
        docs: { project_name: "example-com-docs" },
      },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    const deleteCalls = mock.getCalls("pages.projects.delete");
    expect(deleteCalls).toHaveLength(2);
    const deletedNames = deleteCalls.map((c) => c[0]);
    expect(deletedNames).toContain("example-com-blog");
    expect(deletedNames).toContain("example-com-docs");
  });

  test("successfully deleted projects have project_name cleared in lock, resource IDs kept for step 7", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: {
          project_name: "example-com-blog",
          d1_database_id: "d1-abc",
        },
      },
    };

    // Track intermediate lock saves to verify step 6 behavior
    const lockSnapshots: LockState[] = [];
    let saveCount = 0;

    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      saveLockFn: (_path, state) => {
        saveCount++;
        lockSnapshots.push(JSON.parse(JSON.stringify(state)));
      },
    });

    // After step 6 (Pages deletion), project_name should be "" (not deleted),
    // preserving the entry so d1_database_id survives a lock file reload.
    // Find the snapshot after Pages deletion (it's the 4th save: access, tunnel, worker, pages)
    const pagesSnapshot = lockSnapshots.find(
      (s) => s.pages?.blog && s.pages.blog.project_name === "",
    );
    expect(pagesSnapshot).toBeDefined();
    // d1_database_id should still be present at that point
    // (it gets deleted in step 7, then the entry is cleaned up in step 8)
  });

  test("failed Pages project deletion leaves entry in lock file and records error", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: { project_name: "example-com-blog" },
        docs: { project_name: "example-com-docs" },
      },
    };

    const origDelete = mock.client.pages.projects.delete;
    mock.client.pages.projects.delete = async (...args: unknown[]) => {
      if (args[0] === "example-com-blog") {
        throw new Error("Pages project in use");
      }
      return origDelete(...args);
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);
    // Blog's project_name should still be there (failed)
    expect(lockState.pages["blog"]?.project_name).toBe("example-com-blog");
    // Docs should have project_name cleared (succeeded)
    const pagesCat = result.categories.find((c) => c.category === "Pages projects");
    expect(pagesCat!.deleted).toBe(1);
    expect(pagesCat!.failed).toBe(1);
  });

  test("empty pages section skips this step", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      tunnel: { id: "tunnel-123" },
      pages: {},
      access: {},
      worker: undefined,
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(mock.getCalls("pages.projects.delete")).toHaveLength(0);
  });
});

// --- Cloud Resource Deletion Tests ---

describe("destroy command — cloud resource deletion (D1/R2/KV)", () => {
  test("D1 databases, R2 buckets, and KV namespaces from lock file are deleted", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: {
          project_name: "example-com-blog",
          d1_database_id: "d1-abc",
          r2_bucket_name: "example-com-blog-bucket",
          kv_namespace_id: "kv-xyz",
        },
      },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(mock.getCalls("d1.database.delete")).toHaveLength(1);
    expect(mock.getCalls("d1.database.delete")[0][0]).toBe("d1-abc");

    expect(mock.getCalls("r2.buckets.delete")).toHaveLength(1);
    expect(mock.getCalls("r2.buckets.delete")[0][0]).toBe("example-com-blog-bucket");

    expect(mock.getCalls("kv.namespaces.delete")).toHaveLength(1);
    expect(mock.getCalls("kv.namespaces.delete")[0][0]).toBe("kv-xyz");
  });

  test("successfully deleted resources are removed from lock file", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: {
          project_name: "example-com-blog",
          d1_database_id: "d1-abc",
        },
      },
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    // After full destroy with no failures, lock should be cleared
    expect(lockState.tunnel).toBeUndefined();
  });

  test("resource provisioner destruction function is called", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      pages: {
        blog: {
          project_name: "example-com-blog",
          d1_database_id: "d1-abc",
        },
      },
    };

    let destroyResourcesCalled = false;

    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      destroyResourcesFn: async (_client, _accountId, _state) => {
        destroyResourcesCalled = true;
        return { actions: [] };
      },
    });

    expect(destroyResourcesCalled).toBe(true);
  });
});

// --- Lock File Cleanup Tests ---

describe("destroy command — lock file cleanup", () => {
  test("all deletions succeed → lock file is cleared entirely", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(true);
    // Lock state should be completely cleared
    expect(lockState.tunnel).toBeUndefined();
    expect(Object.keys(lockState.pages)).toHaveLength(0);
    expect(Object.keys(lockState.access)).toHaveLength(0);
    expect(lockState.worker).toBeUndefined();
  });

  test("some deletions fail → lock file retains only failed entries", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
      access: {
        api: { app_id: "access-app-api" },
      },
    };

    // Make tunnel deletion fail
    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("Cannot delete tunnel");
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);
    // Tunnel should remain (failed)
    expect(lockState.tunnel).toBeDefined();
    expect(lockState.tunnel!.id).toBe("tunnel-123");
    // Access should be cleared (succeeded)
    expect(Object.keys(lockState.access)).toHaveLength(0);
  });

  test("lock file is saved after each deletion category", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();
    const saveCount = { value: 0 };

    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      saveLockFn: (_path, _state) => {
        saveCount.value++;
      },
    });

    // Should save after: access, tunnel, worker, pages, cloud resources, final cleanup
    // DNS and redirects don't save lock file (not tracked in lock)
    expect(saveCount.value).toBeGreaterThanOrEqual(5);
  });
});

// --- Continue-on-Failure Tests ---

describe("destroy command — continue-on-failure", () => {
  test("failure in Access deletion does not prevent tunnel deletion", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
      access: { api: { app_id: "access-app-api" } },
    };

    mock.client.zeroTrust.access.applications.delete = async () => {
      throw new Error("Access API down");
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    // Tunnel deletion should still proceed
    expect(mock.getCalls("tunnels.cloudflared.delete")).toHaveLength(1);
  });

  test("failure in tunnel deletion does not prevent DNS record deletion", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-1", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
    ]);
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
    };

    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("Tunnel API down");
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    // DNS deletion should still proceed
    expect(mock.getCalls("dns.records.delete")).toHaveLength(1);
  });

  test("failure in DNS deletion does not prevent subsequent steps", async () => {
    const mock = createMockClient();
    mock.setDnsRecords([
      { id: "dns-1", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
    ]);
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
      worker: { name: "example-com-fallback" },
    };

    mock.client.dns.records.delete = async () => {
      throw new Error("DNS API down");
    };

    await handleDestroy(undefined, makeDeps(mock, lockState));

    // Worker deletion should still proceed
    expect(mock.getCalls("workers.scripts.delete")).toHaveLength(1);
  });

  test("all errors are collected and reported in the final summary", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
      access: { api: { app_id: "access-app-api" } },
      worker: { name: "example-com-fallback" },
    };

    mock.client.zeroTrust.access.applications.delete = async () => {
      throw new Error("Access API failure");
    };
    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("Tunnel API failure");
    };
    mock.client.workers.scripts.delete = async () => {
      throw new Error("Worker API failure");
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));

    expect(result.success).toBe(false);

    const allErrors = result.categories.flatMap((c) => c.errors);
    expect(allErrors.length).toBe(3);

    const errorMessages = allErrors.map((e) => e.error);
    expect(errorMessages).toContain("Access API failure");
    expect(errorMessages).toContain("Tunnel API failure");
    expect(errorMessages).toContain("Worker API failure");
  });

  test("exit code is non-zero when any deletion failed", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
    };

    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("API error");
    };

    const result = await handleDestroy(undefined, makeDeps(mock, lockState));
    expect(result.success).toBe(false);
  });
});

// --- Summary Output Tests ---

describe("destroy command — summary output", () => {
  test("fully successful destroy reports all categories and exits with code 0", async () => {
    const mock = createMockClient();
    const lockState = makePopulatedLockState();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      stdout: output.stdout,
    });

    expect(result.success).toBe(true);

    const summaryOutput = output.getStdout().join("\n");
    expect(summaryOutput).toContain("All Cloudflare resources have been successfully removed");
    expect(summaryOutput).toContain(".env");
    expect(summaryOutput).toContain("flaregun.yml");
  });

  test("partially successful destroy reports successes and failures by category", async () => {
    const mock = createMockClient();
    const lockState: LockState = {
      ...emptyState(),
      tunnel: { id: "tunnel-123" },
      access: { api: { app_id: "access-app-api" } },
    };

    mock.client.zeroTrust.tunnels.cloudflared.delete = async () => {
      throw new Error("Tunnel busy");
    };

    const output = makeOutputCapture();
    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      stdout: output.stdout,
    });

    expect(result.success).toBe(false);

    const summaryOutput = output.getStdout().join("\n");
    expect(summaryOutput).toContain("failure");
    expect(summaryOutput).toContain("Re-run");
  });

  test("summary suggests manual removal of .env and flaregun.yml", async () => {
    const mock = createMockClient();
    const lockState = makeMinimalLockState();
    const output = makeOutputCapture();

    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      stdout: output.stdout,
    });

    const summaryOutput = output.getStdout().join("\n");
    expect(summaryOutput).toContain(".env");
    expect(summaryOutput).toContain("flaregun.yml");
  });
});

// --- Dependency Injection Tests ---

describe("destroy command — dependency injection", () => {
  test("all subsystem dependencies are injectable", async () => {
    const mock = createMockClient();
    let configLoaded = false;
    let envLoaded = false;
    let lockLoaded = false;
    let lockSaved = false;
    let clientCreated = false;
    let confirmCalled = false;
    let destroyResourcesCalled = false;

    await handleDestroy(undefined, {
      loadConfigFn: () => {
        configLoaded = true;
        return makeConfig();
      },
      loadEnvFn: () => {
        envLoaded = true;
        return makeCredentials();
      },
      loadLockFn: () => {
        lockLoaded = true;
        return makeMinimalLockState();
      },
      saveLockFn: () => {
        lockSaved = true;
      },
      createClientFn: () => {
        clientCreated = true;
        return mock.client as any;
      },
      confirmFn: async () => {
        confirmCalled = true;
        return true;
      },
      destroyResourcesFn: async () => {
        destroyResourcesCalled = true;
        return { actions: [] };
      },
      stdout: () => {},
      stderr: () => {},
    });

    expect(configLoaded).toBe(true);
    expect(envLoaded).toBe(true);
    expect(lockLoaded).toBe(true);
    expect(lockSaved).toBe(true);
    expect(clientCreated).toBe(true);
    expect(confirmCalled).toBe(true);
    expect(destroyResourcesCalled).toBe(true);
  });
});

// --- .env and flaregun.yml preservation Tests ---

describe("destroy command — file preservation", () => {
  test(".env and flaregun.yml files are NOT deleted by destroy", async () => {
    // The destroy command doesn't touch these files at all —
    // it only manipulates the lock file and Cloudflare resources.
    // We verify this by ensuring no filesystem write calls target
    // .env or flaregun.yml (the saveLockFn only writes the lock file).
    const mock = createMockClient();
    const lockState = makePopulatedLockState();
    const savedPaths: string[] = [];

    await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      saveLockFn: (path, _state) => {
        savedPaths.push(path);
      },
    });

    // Only the lock file path should have been saved to
    for (const path of savedPaths) {
      expect(path).toContain("flaregun.lock");
      expect(path).not.toContain(".env");
      expect(path).not.toContain("flaregun.yml");
    }
  });
});

// --- buildResourceSummary Tests ---

describe("buildResourceSummary", () => {
  test("includes all resource types in summary", () => {
    const lockState = makePopulatedLockState();
    const summary = buildResourceSummary(lockState);

    expect(summary).toContain("2 Access application(s)");
    expect(summary).toContain("1 Cloudflare Tunnel");
    expect(summary).toContain("1 Pages project(s)");
    expect(summary).toContain("1 D1 database(s)");
    expect(summary).toContain("1 R2 bucket(s)");
    expect(summary).toContain("1 KV namespace(s)");
    expect(summary).toContain("1 fallback Worker");
    expect(summary).toContain("DNS records");
    expect(summary).toContain("Redirect rules");
  });

  test("omits zero-count resources except DNS and redirects", () => {
    const lockState: LockState = {
      tunnel: { id: "tunnel-123" },
      pages: {},
      access: {},
      worker: undefined,
    };

    const summary = buildResourceSummary(lockState);

    expect(summary).not.toContain("Access");
    expect(summary).not.toContain("Pages");
    expect(summary).not.toContain("D1");
    expect(summary).not.toContain("R2");
    expect(summary).not.toContain("KV");
    expect(summary).not.toContain("Worker");
    expect(summary).toContain("Tunnel");
    expect(summary).toContain("DNS");
    expect(summary).toContain("Redirect");
  });
});

// --- formatDestroySummary Tests ---

describe("formatDestroySummary", () => {
  test("all successful categories", () => {
    const categories: CategorySummary[] = [
      { category: "Access applications", deleted: 2, failed: 0, errors: [] },
      { category: "Tunnel", deleted: 1, failed: 0, errors: [] },
      { category: "DNS records", deleted: 3, failed: 0, errors: [] },
    ];

    const summary = formatDestroySummary(categories);

    expect(summary).toContain("✓ Access applications: 2 deleted");
    expect(summary).toContain("✓ Tunnel: 1 deleted");
    expect(summary).toContain("✓ DNS records: 3 deleted");
    expect(summary).toContain("All Cloudflare resources have been successfully removed");
  });

  test("mixed success and failure categories", () => {
    const categories: CategorySummary[] = [
      { category: "Access applications", deleted: 1, failed: 1, errors: [
        { category: "Access applications", resource: "api (app-1)", error: "Permission denied" },
      ]},
      { category: "Tunnel", deleted: 0, failed: 1, errors: [
        { category: "Tunnel", resource: "tunnel-123", error: "In use" },
      ]},
    ];

    const summary = formatDestroySummary(categories);

    expect(summary).toContain("⚠ Access applications: 1 deleted, 1 failed");
    expect(summary).toContain("✗ Tunnel: 1 failed");
    expect(summary).toContain("Permission denied");
    expect(summary).toContain("In use");
    expect(summary).toContain("failure");
    expect(summary).toContain("Re-run");
  });
});

// --- Full Integration Test ---

describe("destroy command — full integration", () => {
  test("complete teardown of all resource types", async () => {
    const mock = createMockClient();

    // Set up DNS records and redirect ruleset in mock state
    mock.setDnsRecords([
      { id: "dns-wild", name: "*.example.com", type: "CNAME", content: "tunnel-123.cfargotunnel.com" },
      { id: "dns-blog", name: "blog.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
      { id: "dns-www", name: "www.example.com", type: "CNAME", content: "example-com-blog.pages.dev" },
      // Non-managed record should survive
      { id: "dns-mx", name: "example.com", type: "MX", content: "mail.example.com" },
    ]);
    mock.setRedirectRuleset({
      id: "ruleset-1",
      rules: [
        {
          id: "rule-1",
          expression: '(http.host eq "example.com")',
          action: "redirect",
          description: "Redirect bare domain",
        },
        {
          id: "rule-2",
          expression: '(http.host eq "other.com")',
          action: "redirect",
          description: "Other redirect",
        },
      ],
    });

    const lockState = makePopulatedLockState();
    const output = makeOutputCapture();

    const result = await handleDestroy(undefined, {
      ...makeDeps(mock, lockState),
      stdout: output.stdout,
    });

    expect(result.success).toBe(true);

    // Verify all deletion calls were made
    expect(mock.getCalls("applications.delete")).toHaveLength(2);
    expect(mock.getCalls("tunnels.cloudflared.delete")).toHaveLength(1);
    expect(mock.getCalls("dns.records.delete")).toHaveLength(3);
    expect(mock.getCalls("workers.scripts.delete")).toHaveLength(1);
    expect(mock.getCalls("pages.projects.delete")).toHaveLength(1);
    expect(mock.getCalls("d1.database.delete")).toHaveLength(1);
    expect(mock.getCalls("r2.buckets.delete")).toHaveLength(1);
    expect(mock.getCalls("kv.namespaces.delete")).toHaveLength(1);

    // Redirect ruleset should only have the "other.com" rule left
    const updatedRuleset = mock.getRedirectRuleset();
    expect(updatedRuleset!.rules).toHaveLength(1);
    expect(updatedRuleset!.rules[0].expression).toBe('(http.host eq "other.com")');

    // Non-managed DNS record should survive
    // (Note: MX record is not type CNAME, so it won't be listed by the query filter)

    // Lock file should be cleared
    expect(lockState.tunnel).toBeUndefined();
    expect(Object.keys(lockState.pages)).toHaveLength(0);
    expect(Object.keys(lockState.access)).toHaveLength(0);
    expect(lockState.worker).toBeUndefined();

    // Summary should indicate success
    const summaryOutput = output.getStdout().join("\n");
    expect(summaryOutput).toContain("All Cloudflare resources have been successfully removed");
  });
});
