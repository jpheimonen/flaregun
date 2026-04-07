import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scaffoldFunctions } from "../../src/deploy/scaffold.js";
import { pagesService } from "../helpers/fixtures.js";

// --- Test helpers ---

let testRoot: string;

/** Creates a unique temp directory for each test */
function createTestRoot(): string {
  const dir = join(tmpdir(), `flaregun-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// --- Scaffolding with database binding ---

describe("scaffold: database binding", () => {
  test("when the functions directory does not exist and the service declares database: true, a functions directory is created with an example handler referencing the DB binding", () => {
    const service = pagesService("blog", "admin_only", { database: true });
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");
    expect(existsSync(result.path)).toBe(true);

    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");
    expect(handler).toContain("DB");
    expect(handler).toContain("D1Database");
    expect(handler).toContain("env.DB");
  });
});

// --- Scaffolding with bucket binding ---

describe("scaffold: bucket binding", () => {
  test("when the functions directory does not exist and the service declares bucket: true, the example handler references the BUCKET binding", () => {
    const service = pagesService("blog", "admin_only", { bucket: true });
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");

    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");
    expect(handler).toContain("BUCKET");
    expect(handler).toContain("R2Bucket");
    expect(handler).toContain("env.BUCKET");
  });
});

// --- Scaffolding with KV binding ---

describe("scaffold: KV binding", () => {
  test("when the functions directory does not exist and the service declares kv: true, the example handler references the KV binding", () => {
    const service = pagesService("blog", "admin_only", { kv: true });
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");

    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");
    expect(handler).toContain("KV");
    expect(handler).toContain("KVNamespace");
    expect(handler).toContain("env.KV");
  });
});

// --- Scaffolding with multiple bindings ---

describe("scaffold: multiple bindings", () => {
  test("when the service declares multiple cloud resources, the scaffolded example references all declared bindings", () => {
    const service = pagesService("blog", "admin_only", {
      database: true,
      bucket: true,
      kv: true,
    });
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");

    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");

    // All three bindings should be present
    expect(handler).toContain("DB: D1Database");
    expect(handler).toContain("BUCKET: R2Bucket");
    expect(handler).toContain("KV: KVNamespace");

    // All three example usages
    expect(handler).toContain("env.DB");
    expect(handler).toContain("env.BUCKET");
    expect(handler).toContain("env.KV");
  });
});

// --- tsconfig.json ---

describe("scaffold: tsconfig.json", () => {
  test("a tsconfig.json referencing @cloudflare/workers-types is created in the scaffolded directory", () => {
    const service = pagesService("blog", "admin_only", { database: true });
    const result = scaffoldFunctions(service, testRoot);

    const tsconfigPath = join(result.path, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);

    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"));
    expect(tsconfig.compilerOptions).toBeDefined();
    expect(tsconfig.compilerOptions.types).toContain("@cloudflare/workers-types");
  });
});

// --- Never overwrite guard ---

describe("scaffold: never overwrite", () => {
  test("when the functions directory already exists, no scaffolding occurs and no files are written", () => {
    const service = pagesService("blog", "admin_only", { database: true });
    const functionsDir = join(testRoot, "functions");

    // Pre-create the directory with a custom file
    mkdirSync(functionsDir, { recursive: true });
    writeFileSync(join(functionsDir, "custom.ts"), "// custom handler\n", "utf-8");

    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("skipped");
    expect(result.path).toBe(functionsDir);

    // The custom file should still be there, unchanged
    expect(readFileSync(join(functionsDir, "custom.ts"), "utf-8")).toBe("// custom handler\n");

    // The scaffolded files should NOT have been written
    expect(existsSync(join(functionsDir, "api.ts"))).toBe(false);
    expect(existsSync(join(functionsDir, "tsconfig.json"))).toBe(false);
  });
});

// --- Custom functions path ---

describe("scaffold: custom functions path", () => {
  test("scaffolding creates the directory at the path specified by the service's functions config field", () => {
    const service = pagesService("blog", "admin_only", {
      database: true,
      functions: "src/api",
    });
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");
    expect(result.path).toBe(join(testRoot, "src/api"));
    expect(existsSync(join(testRoot, "src/api/api.ts"))).toBe(true);
    expect(existsSync(join(testRoot, "src/api/tsconfig.json"))).toBe(true);
  });
});

// --- Default functions path ---

describe("scaffold: default functions path", () => {
  test("scaffolding creates the directory at the default functions/ path relative to the service when no functions field is specified", () => {
    const service = pagesService("blog", "admin_only", { database: true });
    // The pagesService helper sets functions to "functions/" by default
    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");
    expect(result.path).toBe(join(testRoot, "functions"));
    expect(existsSync(join(testRoot, "functions/api.ts"))).toBe(true);
  });

  test("when service has no functions field at all, defaults to functions/ relative to project root", () => {
    const service = pagesService("blog", "admin_only", { database: true });
    // Explicitly remove functions field to test the fallback
    delete (service as Record<string, unknown>).functions;

    const result = scaffoldFunctions(service, testRoot);

    expect(result.action).toBe("scaffolded");
    expect(result.path).toBe(join(testRoot, "functions"));
    expect(existsSync(join(testRoot, "functions/api.ts"))).toBe(true);
  });
});

// --- Structural validity ---

describe("scaffold: handler structural validity", () => {
  test("the scaffolded handler file is a valid TypeScript structure with PagesFunction export", () => {
    const service = pagesService("blog", "admin_only", {
      database: true,
      bucket: true,
      kv: true,
    });
    const result = scaffoldFunctions(service, testRoot);
    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");

    // Should export an onRequest handler
    expect(handler).toContain("export const onRequest");
    expect(handler).toContain("PagesFunction");

    // Should have an Env interface with all bindings
    expect(handler).toContain("interface Env");

    // Should return a Response
    expect(handler).toContain("new Response");
  });

  test("a service with no cloud resources produces a minimal handler with no binding usage", () => {
    const service = pagesService("blog", "admin_only");
    const result = scaffoldFunctions(service, testRoot);
    const handler = readFileSync(join(result.path, "api.ts"), "utf-8");

    // Should still export a valid handler
    expect(handler).toContain("export const onRequest");
    expect(handler).toContain("PagesFunction");
    expect(handler).toContain("new Response");

    // Should not have an Env interface or binding references
    expect(handler).not.toContain("interface Env");
    expect(handler).not.toContain("D1Database");
    expect(handler).not.toContain("R2Bucket");
    expect(handler).not.toContain("KVNamespace");
  });
});
