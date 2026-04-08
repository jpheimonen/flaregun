import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildScaffoldCopy } from "../../src/deploy/build.js";
import { pagesService } from "../helpers/fixtures.js";
import { emptyState } from "../../src/lock/index.js";
import type { CommandRunner, CommandResult } from "../../src/process/index.js";

// --- Test helpers ---

let testRoot: string;

function createTestRoot(): string {
  const dir = join(
    tmpdir(),
    `flaregun-build-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Creates a mock command runner that returns the specified result */
function mockRunner(result: CommandResult): CommandRunner {
  return async () => result;
}

/** Creates a mock runner that succeeds (exit code 0) */
function successRunner(): CommandRunner {
  return mockRunner({ exitCode: 0, stdout: "ok", stderr: "" });
}

/** Creates a mock runner that fails (exit code 1) */
function failRunner(stderr = "build error"): CommandRunner {
  return mockRunner({ exitCode: 1, stdout: "", stderr });
}

/** Creates a mock runner that records calls */
function trackingRunner(result: CommandResult = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: CommandRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return result;
  };
  return { runner, calls };
}

beforeEach(() => {
  testRoot = createTestRoot();
});

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// --- Build step tests ---

describe("buildScaffoldCopy: build command", () => {
  test("a service with a build command has that command executed", async () => {
    const service = pagesService("blog", "admin_only", {
      build: "bun run build",
    });
    const { runner, calls } = trackingRunner();
    const lockState = emptyState();

    // Create the dist dir so the function can work
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      lockState,
      runner,
    );

    expect(result.success).toBe(true);
    expect(result.built).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].args).toEqual(["bun", "run", "build"]);
    expect(calls[0].cwd).toBe(testRoot);
  });

  test("a build command failure prevents the deploy and reports the error", async () => {
    const service = pagesService("blog", "admin_only", {
      build: "bun run build",
    });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      failRunner("compilation error"),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Build command failed");
    expect(result.error).toContain("blog");
    expect(result.error).toContain("compilation error");
    expect(result.built).toBe(false);
    expect(result.scaffolded).toBe(false);
    expect(result.functionsCopied).toBe(false);
  });

  test("a service without a build command skips the build step", async () => {
    const service = pagesService("blog", "admin_only"); // no build field
    const { runner, calls } = trackingRunner();

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      runner,
    );

    expect(result.success).toBe(true);
    expect(result.built).toBe(false);
    // No commands should have been called for build
    expect(calls.length).toBe(0);
  });
});

// --- Scaffolding and functions copy tests ---

describe("buildScaffoldCopy: scaffolding and functions copy", () => {
  test("a service with cloud resources and no functions directory triggers the scaffolder", async () => {
    const service = pagesService("blog", "admin_only", { database: true });

    // Create dist directory
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      successRunner(),
    );

    expect(result.success).toBe(true);
    expect(result.scaffolded).toBe(true);
    // Scaffolder should have created functions/
    expect(existsSync(join(testRoot, "functions"))).toBe(true);
    // Functions should be copied to dist/functions/
    expect(result.functionsCopied).toBe(true);
    expect(existsSync(join(testRoot, "dist", "functions"))).toBe(true);
  });

  test("a service with cloud resources and an existing functions directory skips scaffolding", async () => {
    const service = pagesService("blog", "admin_only", { database: true });

    // Create existing functions directory with custom content
    mkdirSync(join(testRoot, "functions"));
    writeFileSync(
      join(testRoot, "functions", "custom.ts"),
      "custom handler",
      "utf-8",
    );

    // Create dist directory
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      successRunner(),
    );

    expect(result.success).toBe(true);
    expect(result.scaffolded).toBe(false); // Skipped scaffolding
    expect(result.functionsCopied).toBe(true);
    // Custom file should be in dist/functions/
    expect(
      readFileSync(join(testRoot, "dist", "functions", "custom.ts"), "utf-8"),
    ).toBe("custom handler");
  });

  test("a service with no cloud resources and no functions directory skips both scaffolding and copying", async () => {
    const service = pagesService("blog", "admin_only"); // no cloud resources

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      successRunner(),
    );

    expect(result.success).toBe(true);
    expect(result.scaffolded).toBe(false);
    expect(result.functionsCopied).toBe(false);
    expect(existsSync(join(testRoot, "functions"))).toBe(false);
  });

  test("functions are copied from the source directory into dist/functions/", async () => {
    const service = pagesService("blog", "admin_only");

    // Create functions directory with files
    mkdirSync(join(testRoot, "functions", "api"), { recursive: true });
    writeFileSync(
      join(testRoot, "functions", "api", "index.ts"),
      "api code",
      "utf-8",
    );

    // Create dist directory
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      successRunner(),
    );

    expect(result.success).toBe(true);
    expect(result.functionsCopied).toBe(true);
    expect(
      readFileSync(
        join(testRoot, "dist", "functions", "api", "index.ts"),
        "utf-8",
      ),
    ).toBe("api code");
  });
});

// --- Shared function reusability ---

describe("buildScaffoldCopy: reusability", () => {
  test("the shared function is callable independently from the deploy pipeline", async () => {
    // This test verifies that buildScaffoldCopy can be imported and called
    // directly without the full deploy pipeline context
    const service = pagesService("blog", "admin_only", {
      build: "echo hello",
    });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      successRunner(),
    );

    expect(result.success).toBe(true);
    expect(result.built).toBe(true);
  });

  test("the build -> scaffold -> copy sequence runs in the correct order", async () => {
    const service = pagesService("blog", "admin_only", {
      build: "bun run build",
      database: true,
    });

    // Create dist directory (normally the build command would create this)
    mkdirSync(join(testRoot, "dist"), { recursive: true });

    const steps: string[] = [];

    // Track the build command
    const runner: CommandRunner = async (args) => {
      steps.push("build");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      runner,
    );

    expect(result.success).toBe(true);
    expect(result.built).toBe(true);
    expect(result.scaffolded).toBe(true);
    expect(result.functionsCopied).toBe(true);
    // Build was the first step
    expect(steps[0]).toBe("build");
  });

  test("a build failure prevents scaffolding and copying", async () => {
    const service = pagesService("blog", "admin_only", {
      build: "bun run build",
      database: true,
    });

    const result = await buildScaffoldCopy(
      "blog",
      service,
      testRoot,
      emptyState(),
      failRunner(),
    );

    expect(result.success).toBe(false);
    expect(result.built).toBe(false);
    expect(result.scaffolded).toBe(false);
    expect(result.functionsCopied).toBe(false);
    // Scaffolder should NOT have been called
    expect(existsSync(join(testRoot, "functions"))).toBe(false);
  });
});
