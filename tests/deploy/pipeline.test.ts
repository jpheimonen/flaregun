import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  deployService,
  deployFallbackWorker,
  deployPipeline,
  formatDeploySummary,
} from "../../src/deploy/pipeline.js";
import { createMockClient } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ACCOUNT_ID,
} from "../helpers/fixtures.js";
import { emptyState } from "../../src/lock/index.js";
import type { CommandRunner, CommandResult } from "../../src/process/index.js";
import type { CloudflareClient } from "../../src/cloudflare/index.js";

// --- Test helpers ---

let testRoot: string;

function createTestRoot(): string {
  const dir = join(
    tmpdir(),
    `flaregun-pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  testRoot = createTestRoot();
});

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

/**
 * Creates a command runner that returns different results based on the command.
 * Used to simulate wrangler behavior in tests.
 */
function createMockRunner(overrides?: {
  buildResult?: CommandResult;
  deployResult?: CommandResult;
  createProjectResult?: CommandResult;
  workerDeployResult?: CommandResult;
}): { runner: CommandRunner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const successResult: CommandResult = { exitCode: 0, stdout: "ok", stderr: "" };

  const runner: CommandRunner = async (args, cwd) => {
    calls.push({ args, cwd });

    // Match command patterns
    const cmd = args.join(" ");
    if (cmd.includes("pages deploy")) {
      return overrides?.deployResult ?? successResult;
    }
    if (cmd.includes("pages project create")) {
      return overrides?.createProjectResult ?? successResult;
    }
    if (cmd === "wrangler deploy") {
      return overrides?.workerDeployResult ?? successResult;
    }
    // Default: build commands
    return overrides?.buildResult ?? successResult;
  };

  return { runner, calls };
}

// --- Per-service deploy tests ---

describe("deployService", () => {
  test("runs the build command before any other deploy step", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { build: "bun run build" }),
      },
    });
    const lockState = emptyState();
    const steps: string[] = [];

    const runner: CommandRunner = async (args) => {
      if (args.join(" ").includes("build")) {
        steps.push("build");
      } else if (args.join(" ").includes("pages deploy")) {
        steps.push("wrangler-deploy");
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    // Create dist dir
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      lockState,
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);
    expect(steps[0]).toBe("build");
    expect(steps).toContain("wrangler-deploy");
  });

  test("a build failure prevents the deploy and reports the error", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { build: "bun run build" }),
      },
    });

    const { runner } = createMockRunner({
      buildResult: { exitCode: 1, stdout: "", stderr: "build failed" },
    });

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Build command failed");
  });

  test("resource provisioning runs before wrangler config generation", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
      },
    });
    const lockState = emptyState();

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      lockState,
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);
    // Provisioner should have created the D1 database
    expect(mockClient.getCalls("d1.database.create").length).toBe(1);
  });

  test("a service with no cloud resources does not invoke the provisioner", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"), // no database/bucket/kv
      },
    });
    const lockState = emptyState();

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      lockState,
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);
    // No D1/R2/KV create calls should have been made
    expect(mockClient.getCalls("d1.database.create").length).toBe(0);
    expect(mockClient.getCalls("r2.buckets.create").length).toBe(0);
    expect(mockClient.getCalls("kv.namespaces.create").length).toBe(0);
  });

  test("runs wrangler pages deploy with the generated config", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner, calls } = createMockRunner();

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);

    // Verify wrangler pages deploy was called
    const deployCalls = calls.filter((c) =>
      c.args.join(" ").includes("pages deploy"),
    );
    expect(deployCalls.length).toBeGreaterThanOrEqual(1);
    // Should include --config flag pointing to a temp wrangler.toml
    expect(deployCalls[0].args).toContain("--config");
  });

  test("creates Pages project and retries when project not found", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    let deployAttempts = 0;
    const runner: CommandRunner = async (args) => {
      const cmd = args.join(" ");
      if (cmd.includes("pages deploy")) {
        deployAttempts++;
        if (deployAttempts === 1) {
          // First attempt fails with project not found
          return { exitCode: 1, stdout: "", stderr: "could not find project" };
        }
        // Retry succeeds
        return { exitCode: 0, stdout: "deployed", stderr: "" };
      }
      if (cmd.includes("pages project create")) {
        return { exitCode: 0, stdout: "project created", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);
    expect(deployAttempts).toBe(2); // First attempt + retry
  });

  test("a failed wrangler deploy (not project-not-found) reports failure without retrying", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    let deployAttempts = 0;
    const runner: CommandRunner = async (args) => {
      const cmd = args.join(" ");
      if (cmd.includes("pages deploy")) {
        deployAttempts++;
        return { exitCode: 1, stdout: "", stderr: "auth error" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("auth error");
    expect(deployAttempts).toBe(1); // No retry
  });

  test("after successful deploy, attaches custom subdomain to Pages project", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);

    // Check that domain attachment was called
    const createCalls = mockClient.getCalls("pages.projects.domains.create");
    expect(createCalls.length).toBe(1);
    const createParams = createCalls[0][0] as {
      project_name: string;
      account_id: string;
      body: { name: string };
    };
    expect(createParams.body.name).toBe("blog.example.com");
  });

  test("custom domain attachment is skipped if already attached (idempotency)", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    // Pre-attach the domain
    mockClient.setPagesDomains([
      {
        id: "domain-1",
        domain: "blog.example.com",
        project_name: "example-com-blog",
      },
    ]);

    const { runner } = createMockRunner();

    const result = await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    expect(result.success).toBe(true);

    // Domain create should NOT have been called (already attached)
    const createCalls = mockClient.getCalls("pages.projects.domains.create");
    expect(createCalls.length).toBe(0);
  });

  test("temporary wrangler.toml is cleaned up after deploy", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    let configPath = "";
    const runner: CommandRunner = async (args) => {
      const configIdx = args.indexOf("--config");
      if (configIdx >= 0) {
        configPath = args[configIdx + 1];
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    await deployService(
      "blog",
      config.services.blog,
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
    );

    // The temp directory should have been cleaned up
    expect(configPath).not.toBe("");
    // The temp dir parent should not exist anymore
    const tmpDirPath = join(configPath, "..");
    expect(existsSync(tmpDirPath)).toBe(false);
  });
});

// --- Fallback Worker deploy tests ---

describe("deployFallbackWorker", () => {
  test("generates Worker source and wrangler.toml in a temp directory", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    let deployDir = "";
    const runner: CommandRunner = async (args, cwd) => {
      if (args.join(" ") === "wrangler deploy") {
        deployDir = cwd;
        // Verify both files exist in the deploy directory
        expect(existsSync(join(cwd, "index.ts"))).toBe(true);
        expect(existsSync(join(cwd, "wrangler.toml"))).toBe(true);
      }
      return { exitCode: 0, stdout: "deployed", stderr: "" };
    };

    const result = await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(result.success).toBe(true);
    expect(deployDir).not.toBe("");
  });

  test("wrangler deploy is run from the temp directory", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    let deployCwd = "";
    const runner: CommandRunner = async (args, cwd) => {
      if (args.join(" ") === "wrangler deploy") {
        deployCwd = cwd;
      }
      return { exitCode: 0, stdout: "deployed", stderr: "" };
    };

    const result = await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(result.success).toBe(true);
    // Should have been called from a temp directory (not the project root)
    expect(deployCwd).not.toBe(testRoot);
    expect(deployCwd).toContain("flaregun-");
  });

  test("stores the fallback Worker name in the lock file after successful deploy", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    const { runner } = createMockRunner();

    const result = await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(result.success).toBe(true);
    expect(lockState.worker).toBeDefined();
    expect(lockState.worker!.name).toBe("example-com-fallback");
  });

  test("temp directory is cleaned up after successful deploy", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    let deployDir = "";
    const runner: CommandRunner = async (args, cwd) => {
      if (args.join(" ") === "wrangler deploy") {
        deployDir = cwd;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(deployDir).not.toBe("");
    expect(existsSync(deployDir)).toBe(false); // Cleaned up
  });

  test("temp directory is cleaned up after failed deploy", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    let deployDir = "";
    const runner: CommandRunner = async (args, cwd) => {
      if (args.join(" ") === "wrangler deploy") {
        deployDir = cwd;
      }
      return { exitCode: 1, stdout: "", stderr: "deploy error" };
    };

    const result = await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(result.success).toBe(false);
    expect(deployDir).not.toBe("");
    expect(existsSync(deployDir)).toBe(false); // Still cleaned up
  });

  test("a failed wrangler deploy reports the error", async () => {
    const config = makeConfig();
    const lockState = emptyState();

    const { runner } = createMockRunner({
      workerDeployResult: {
        exitCode: 1,
        stdout: "",
        stderr: "Worker deploy error",
      },
    });

    const result = await deployFallbackWorker(config, lockState, testRoot, runner);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Worker deploy error");
  });
});

// --- Pipeline orchestrator tests ---

/** Always-true binary check so tests don't require wrangler on PATH */
const mockBinaryExists = async () => true;

describe("deployPipeline", () => {
  test("deploying with no filter deploys all Pages services", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        docs: pagesService("docs", "public"),
        api: localService("api", 3000),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner, calls } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    // Should have deployed blog and docs (Pages) but not api (local)
    const pagesEntries = result.summary.filter((e) => e.type === "pages");
    const pagesNames = pagesEntries.map((e) => e.name).sort();
    expect(pagesNames).toEqual(["blog", "docs"]);
    // Fallback Worker should also be present
    const workerEntries = result.summary.filter((e) => e.type === "worker");
    expect(workerEntries.length).toBe(1);
    expect(workerEntries[0].name).toBe("fallback-worker");
  });

  test("deploying with a service name filter only deploys the named services", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        docs: pagesService("docs", "public"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      ["blog"], // Only deploy blog
      mockBinaryExists,
    );

    const pagesEntries = result.summary.filter((e) => e.type === "pages");
    expect(pagesEntries.length).toBe(1);
    expect(pagesEntries[0].name).toBe("blog");
  });

  test("the fallback Worker is deployed regardless of service name filtering", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        docs: pagesService("docs", "public"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      ["blog"], // Only deploy blog — Worker should still deploy
      mockBinaryExists,
    );

    const workerEntries = result.summary.filter(
      (e) => e.name === "fallback-worker",
    );
    expect(workerEntries.length).toBe(1);
    expect(workerEntries[0].success).toBe(true);
  });

  test("multiple service deploys run concurrently", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        docs: pagesService("docs", "public"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    // Track when deploys start and end to verify concurrency
    const events: { service: string; event: string; time: number }[] = [];

    const runner: CommandRunner = async (args, cwd) => {
      const cmd = args.join(" ");
      if (cmd.includes("pages deploy")) {
        events.push({ service: "pages", event: "start", time: Date.now() });
        // Small delay to make timing observable
        await new Promise((r) => setTimeout(r, 10));
        events.push({ service: "pages", event: "end", time: Date.now() });
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    expect(result.success).toBe(true);

    // Both blog and docs should have been deployed
    const successfulPages = result.summary.filter(
      (e) => e.type === "pages" && e.success,
    );
    expect(successfulPages.length).toBe(2);
  });

  test("a failure in one service does not prevent others from deploying", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { build: "bun run build" }),
        docs: pagesService("docs", "public"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    // Blog build fails, docs succeeds
    const runner: CommandRunner = async (args) => {
      const cmd = args.join(" ");
      if (cmd.includes("build")) {
        return { exitCode: 1, stdout: "", stderr: "blog build error" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    // Overall should be failure
    expect(result.success).toBe(false);

    // Blog should fail
    const blogEntry = result.summary.find((e) => e.name === "blog");
    expect(blogEntry?.success).toBe(false);

    // Docs should still succeed
    const docsEntry = result.summary.find((e) => e.name === "docs");
    expect(docsEntry?.success).toBe(true);
  });

  test("produces a per-service summary report with deploy status", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    expect(result.summary.length).toBeGreaterThanOrEqual(2); // At least blog + worker
    for (const entry of result.summary) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("type");
      expect(entry).toHaveProperty("success");
    }

    // Format the summary for readability
    const formatted = formatDeploySummary(result);
    expect(formatted).toContain("Deploy Summary");
    expect(formatted).toContain("blog");
    expect(formatted).toContain("fallback-worker");
  });

  test("reports overall failure if any service or Worker failed", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner({
      workerDeployResult: { exitCode: 1, stdout: "", stderr: "worker error" },
    });

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    expect(result.success).toBe(false);
  });

  test("checks for wrangler availability before starting deploys", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    // When wrangler is missing, pipeline should fail immediately
    const noWrangler = async () => false;
    const failResult = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      noWrangler,
    );

    expect(failResult.success).toBe(false);
    expect(failResult.summary[0].error).toContain("wrangler");

    // When wrangler is available, pipeline should proceed
    const successResult = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      undefined,
      mockBinaryExists,
    );

    expect(successResult.summary.length).toBeGreaterThan(0);
    expect(successResult.summary.some((e) => e.type === "pages")).toBe(true);
  });

  test("reports error when a filtered service name does not exist in config", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      ["nonexistent"],
      mockBinaryExists,
    );

    expect(result.success).toBe(false);
    const errorEntry = result.summary.find((e) => e.name === "nonexistent");
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.success).toBe(false);
    expect(errorEntry?.error).toContain("not found");
  });

  test("reports error when a filtered service is not a Pages service", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
        api: localService("api", 3000),
      },
    });

    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const { runner } = createMockRunner();

    const result = await deployPipeline(
      config,
      emptyState(),
      mockClient.client as unknown as CloudflareClient,
      TEST_ACCOUNT_ID,
      testRoot,
      runner,
      ["api"],
      mockBinaryExists,
    );

    expect(result.success).toBe(false);
    const errorEntry = result.summary.find((e) => e.name === "api");
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.success).toBe(false);
    expect(errorEntry?.error).toContain("not a Pages service");
  });
});

// --- Summary formatting ---

describe("formatDeploySummary", () => {
  test("formats a successful deploy", () => {
    const result = {
      success: true,
      summary: [
        { name: "blog", type: "pages" as const, success: true },
        { name: "fallback-worker", type: "worker" as const, success: true },
      ],
    };

    const formatted = formatDeploySummary(result);
    expect(formatted).toContain("Deploy Summary");
    expect(formatted).toContain("Pages (blog)");
    expect(formatted).toContain("\u2713 deployed");
    expect(formatted).toContain("Worker (fallback-worker)");
  });

  test("formats a failed deploy with error messages", () => {
    const result = {
      success: false,
      summary: [
        {
          name: "blog",
          type: "pages" as const,
          success: false,
          error: "build failed",
        },
        { name: "fallback-worker", type: "worker" as const, success: true },
      ],
    };

    const formatted = formatDeploySummary(result);
    expect(formatted).toContain("\u2717 failed");
    expect(formatted).toContain("build failed");
  });
});
