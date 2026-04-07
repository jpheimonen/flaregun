import { describe, test, expect } from "bun:test";
import { handleDeploy, type DeployCommandDeps } from "../../src/deploy/command.js";
import {
  makeConfig,
  pagesService,
  TEST_ACCOUNT_ID,
  TEST_ZONE_ID,
} from "../helpers/fixtures.js";
import { emptyState } from "../../src/lock/index.js";
import { ConfigValidationError } from "../../src/config/index.js";
import { EnvValidationError } from "../../src/env/index.js";
import type { CloudflareCredentials } from "../../src/env/index.js";
import type { CloudflareClient } from "../../src/cloudflare/index.js";
import type { CommandRunner } from "../../src/process/index.js";
import type { SyncCredentials } from "../../src/sync/index.js";

// --- Test helpers ---

const TEST_CREDENTIALS: CloudflareCredentials = {
  apiToken: "test-token",
  accountId: TEST_ACCOUNT_ID,
  zoneId: TEST_ZONE_ID,
};

/** Creates a set of deps that succeed for all operations */
function successDeps(overrides?: Partial<DeployCommandDeps>): DeployCommandDeps {
  const output: string[] = [];
  const errors: string[] = [];

  return {
    loadConfigFn: () =>
      makeConfig({
        services: {
          blog: pagesService("blog", "admin_only"),
        },
      }),
    loadEnvFn: () => TEST_CREDENTIALS,
    loadLockFn: () => emptyState(),
    saveLockFn: () => {},
    createClientFn: () => ({}) as unknown as CloudflareClient,
    binaryExistsFn: async () => true,
    syncFn: async () => ({ steps: [{ step: "access-applications", success: true }] }),
    deployFn: async () => ({
      success: true,
      summary: [
        { name: "blog", type: "pages" as const, success: true },
        { name: "fallback-worker", type: "worker" as const, success: true },
      ],
    }),
    runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    stdout: (msg) => output.push(msg),
    stderr: (msg) => errors.push(msg),
    ...overrides,
  };
}

// --- Config loading tests ---

describe("handleDeploy: config loading", () => {
  test("loads config, environment, and lock file before deploying", async () => {
    const loadOrder: string[] = [];

    const result = await handleDeploy([], undefined, successDeps({
      loadConfigFn: () => {
        loadOrder.push("config");
        return makeConfig();
      },
      loadEnvFn: () => {
        loadOrder.push("env");
        return TEST_CREDENTIALS;
      },
      loadLockFn: () => {
        loadOrder.push("lock");
        return emptyState();
      },
    }));

    expect(result.success).toBe(true);
    expect(loadOrder).toEqual(["config", "env", "lock"]);
  });

  test("an invalid config aborts before any deploy operations", async () => {
    let syncCalled = false;
    let deployCalled = false;

    const result = await handleDeploy([], undefined, successDeps({
      loadConfigFn: () => {
        throw new ConfigValidationError(["domain is missing"]);
      },
      syncFn: async () => {
        syncCalled = true;
        return { steps: [] };
      },
      deployFn: async () => {
        deployCalled = true;
        return { success: true, summary: [] };
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("domain is missing");
    expect(syncCalled).toBe(false);
    expect(deployCalled).toBe(false);
  });
});

// --- Environment validation tests ---

describe("handleDeploy: environment validation", () => {
  test("missing environment variables abort with a descriptive error", async () => {
    const result = await handleDeploy([], undefined, successDeps({
      loadEnvFn: () => {
        throw new EnvValidationError(
          ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
          "Missing required environment variable(s): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.",
        );
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("CLOUDFLARE_API_TOKEN");
    expect(result.error).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  test("validates API token, account ID, and zone ID but does not require tunnel token", async () => {
    // The deploy context should not require CLOUDFLARE_TUNNEL_TOKEN
    let envContext: string = "";

    const result = await handleDeploy([], undefined, successDeps({
      loadEnvFn: (configPath, context) => {
        envContext = context;
        return TEST_CREDENTIALS; // No tunnel token
      },
    }));

    expect(result.success).toBe(true);
    expect(envContext).toBe("deploy");
  });
});

// --- Wrangler prerequisite tests ---

describe("handleDeploy: prerequisites", () => {
  test("a missing wrangler binary aborts with an error", async () => {
    const result = await handleDeploy([], undefined, successDeps({
      binaryExistsFn: async () => false,
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("wrangler");
  });
});

// --- Sync tests ---

describe("handleDeploy: sync", () => {
  test("runs the full sync engine before the deploy pipeline", async () => {
    const order: string[] = [];

    const result = await handleDeploy([], undefined, successDeps({
      syncFn: async () => {
        order.push("sync");
        return { steps: [{ step: "test", success: true }] };
      },
      deployFn: async () => {
        order.push("deploy");
        return {
          success: true,
          summary: [{ name: "blog", type: "pages" as const, success: true }],
        };
      },
    }));

    expect(result.success).toBe(true);
    expect(order).toEqual(["sync", "deploy"]);
  });

  test("when no tunnel ID exists in the lock file, sync still runs", async () => {
    let syncCredentials: SyncCredentials | null = null;

    const result = await handleDeploy([], undefined, successDeps({
      loadLockFn: () => {
        // No tunnel in lock state
        return emptyState();
      },
      syncFn: async (client, config, creds) => {
        syncCredentials = creds;
        return { steps: [{ step: "test", success: true }] };
      },
    }));

    expect(result.success).toBe(true);
    // tunnelId should be empty string (not undefined)
    expect(syncCredentials!.tunnelId).toBe("");
  });

  test("when no tunnel ID exists, tunnel-ingress and dns-records sync failures are tolerated", async () => {
    let deployCalled = false;

    const result = await handleDeploy([], undefined, successDeps({
      loadLockFn: () => emptyState(), // No tunnel
      syncFn: async () => ({
        steps: [
          { step: "access-applications", success: true },
          { step: "access-policies", success: true },
          { step: "tunnel-ingress", success: false, error: "empty tunnel ID" },
          { step: "dns-records", success: false, error: "empty tunnel ID" },
        ],
      }),
      deployFn: async () => {
        deployCalled = true;
        return {
          success: true,
          summary: [{ name: "blog", type: "pages" as const, success: true }],
        };
      },
    }));

    expect(result.success).toBe(true);
    expect(deployCalled).toBe(true);
  });

  test("a critical sync failure aborts before the deploy pipeline", async () => {
    let deployCalled = false;

    const result = await handleDeploy([], undefined, successDeps({
      syncFn: async () => ({
        steps: [
          {
            step: "access-applications",
            success: false,
            error: "API error",
          },
        ],
      }),
      deployFn: async () => {
        deployCalled = true;
        return { success: true, summary: [] };
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Sync failed");
    expect(deployCalled).toBe(false);
  });
});

// --- Service name filtering tests ---

describe("handleDeploy: service filtering", () => {
  test("service name arguments are passed through as a filter to the pipeline", async () => {
    let receivedFilter: string[] | undefined;

    const result = await handleDeploy(
      ["blog", "docs"],
      undefined,
      successDeps({
        deployFn: async (config, lockState, client, accountId, projectRoot, runner, filter) => {
          receivedFilter = filter;
          return {
            success: true,
            summary: [
              { name: "blog", type: "pages" as const, success: true },
              { name: "docs", type: "pages" as const, success: true },
            ],
          };
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(receivedFilter).toEqual(["blog", "docs"]);
  });

  test("no filter arguments results in no filter passed to the pipeline", async () => {
    let receivedFilter: string[] | undefined;

    const result = await handleDeploy(
      [],
      undefined,
      successDeps({
        deployFn: async (config, lockState, client, accountId, projectRoot, runner, filter) => {
          receivedFilter = filter;
          return {
            success: true,
            summary: [
              { name: "blog", type: "pages" as const, success: true },
            ],
          };
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(receivedFilter).toBeUndefined();
  });
});

// --- Exit code tests ---

describe("handleDeploy: exit status", () => {
  test("returns success when all deploys succeed", async () => {
    const result = await handleDeploy([], undefined, successDeps());
    expect(result.success).toBe(true);
  });

  test("returns failure when any deploy fails", async () => {
    const result = await handleDeploy([], undefined, successDeps({
      deployFn: async () => ({
        success: false,
        summary: [
          {
            name: "blog",
            type: "pages" as const,
            success: false,
            error: "deploy failed",
          },
        ],
      }),
    }));

    expect(result.success).toBe(false);
    expect(result.pipelineResult).toBeDefined();
    expect(result.pipelineResult!.success).toBe(false);
  });
});

// --- All commands via CommandRunner ---

describe("handleDeploy: CommandRunner injection", () => {
  test("all wrangler and build commands are invoked via the injectable CommandRunner", async () => {
    let runnerUsed = false;
    const customRunner: CommandRunner = async () => {
      runnerUsed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // We verify that the runner is passed through to the deploy function
    let receivedRunner: CommandRunner | undefined;

    const result = await handleDeploy([], undefined, successDeps({
      runner: customRunner,
      deployFn: async (config, lockState, client, accountId, projectRoot, runner) => {
        receivedRunner = runner;
        return {
          success: true,
          summary: [
            { name: "blog", type: "pages" as const, success: true },
          ],
        };
      },
    }));

    expect(result.success).toBe(true);
    expect(receivedRunner).toBe(customRunner);
  });
});
