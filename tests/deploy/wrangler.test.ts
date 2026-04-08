import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import {
  generatePagesConfig,
  generateFallbackWorkerConfig,
  MissingResourceError,
} from "../../src/deploy/wrangler.js";
import { cleanupTmpDir } from "../../src/deploy/tmp.js";
import { pagesService } from "../helpers/fixtures.js";
import { emptyState, type LockState } from "../../src/lock/index.js";
import { resourceName } from "../../src/naming.js";

// --- Cleanup tracking ---

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    cleanupTmpDir(dir);
  }
  tmpDirs.length = 0;
});

/** Helper to track temp dirs for cleanup */
function trackTmpDir(dir: string): void {
  tmpDirs.push(dir);
}

// --- Pages wrangler config: pages_build_output_dir ---

describe("pages config: pages_build_output_dir", () => {
  test("generated Pages wrangler.toml contains pages_build_output_dir pointing to the service's dist directory", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only", { dist: "build/output" });

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('pages_build_output_dir = "build/output"');
  });

  test("uses the default dist/ when service has no explicit dist", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only");
    // Remove dist to test default
    delete (service as unknown as Record<string, unknown>).dist;

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('pages_build_output_dir = "dist/"');
  });
});

// --- Pages wrangler config: project name ---

describe("pages config: project name", () => {
  test("the project name follows the naming convention derived from domain and service name", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only");
    const expectedName = resourceName("example.com", "blog");

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain(`name = "${expectedName}"`);
    expect(content).toContain('name = "example-com-blog"');
  });

  test("project name uses the same naming convention for multi-segment domains", () => {
    const lockState = emptyState();
    const service = pagesService("api", "admin_only");
    const expectedName = resourceName("my.cool.site", "api");

    const result = generatePagesConfig("api", service, "my.cool.site", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain(`name = "${expectedName}"`);
  });
});

// --- Pages wrangler config: D1 binding ---

describe("pages config: D1 binding", () => {
  test("a service with database: true produces a wrangler.toml with a d1_databases section containing binding name DB and the database ID from the lock file", () => {
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "d1-abc-123",
    };
    const service = pagesService("blog", "admin_only", { database: true });

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain("[[d1_databases]]");
    expect(content).toContain('binding = "DB"');
    expect(content).toContain('database_id = "d1-abc-123"');
    expect(content).toContain("database_name");
  });
});

// --- Pages wrangler config: R2 binding ---

describe("pages config: R2 binding", () => {
  test("a service with bucket: true produces a wrangler.toml with an r2_buckets section containing binding name BUCKET and the bucket name from the lock file", () => {
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      r2_bucket_name: "example-com-blog-bucket",
    };
    const service = pagesService("blog", "admin_only", { bucket: true });

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain("[[r2_buckets]]");
    expect(content).toContain('binding = "BUCKET"');
    expect(content).toContain('bucket_name = "example-com-blog-bucket"');
  });
});

// --- Pages wrangler config: KV binding ---

describe("pages config: KV binding", () => {
  test("a service with kv: true produces a wrangler.toml with a kv_namespaces section containing binding name KV and the namespace ID from the lock file", () => {
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      kv_namespace_id: "kv-ns-456",
    };
    const service = pagesService("blog", "admin_only", { kv: true });

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain("[[kv_namespaces]]");
    expect(content).toContain('binding = "KV"');
    expect(content).toContain('id = "kv-ns-456"');
  });
});

// --- Pages wrangler config: all three bindings ---

describe("pages config: all bindings", () => {
  test("a service with all three cloud resources produces a wrangler.toml with all three binding sections", () => {
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "d1-abc-123",
      r2_bucket_name: "example-com-blog-bucket",
      kv_namespace_id: "kv-ns-456",
    };
    const service = pagesService("blog", "admin_only", {
      database: true,
      bucket: true,
      kv: true,
    });

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");

    // All three binding sections should be present
    expect(content).toContain("[[d1_databases]]");
    expect(content).toContain('binding = "DB"');
    expect(content).toContain('database_id = "d1-abc-123"');

    expect(content).toContain("[[r2_buckets]]");
    expect(content).toContain('binding = "BUCKET"');
    expect(content).toContain('bucket_name = "example-com-blog-bucket"');

    expect(content).toContain("[[kv_namespaces]]");
    expect(content).toContain('binding = "KV"');
    expect(content).toContain('id = "kv-ns-456"');
  });
});

// --- Pages wrangler config: no cloud resources ---

describe("pages config: no bindings", () => {
  test("a service with no cloud resources produces a wrangler.toml with no binding sections", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only");

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");

    // Should have name and pages_build_output_dir
    expect(content).toContain("name =");
    expect(content).toContain("pages_build_output_dir =");

    // No binding sections
    expect(content).not.toContain("[[d1_databases]]");
    expect(content).not.toContain("[[r2_buckets]]");
    expect(content).not.toContain("[[kv_namespaces]]");
  });
});

// --- Pages wrangler config: missing lock file entry ---

describe("pages config: missing lock file entry", () => {
  test("if a service declares database but the lock file has no corresponding entry, the generator throws a descriptive error", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only", { database: true });

    expect(() =>
      generatePagesConfig("blog", service, "example.com", lockState),
    ).toThrow(MissingResourceError);

    try {
      generatePagesConfig("blog", service, "example.com", lockState);
    } catch (err) {
      expect((err as Error).message).toContain("blog");
      expect((err as Error).message).toContain("database");
      expect((err as Error).message).toContain("lock file");
    }
  });

  test("if a service declares bucket but the lock file has no corresponding entry, the generator throws a descriptive error", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only", { bucket: true });

    expect(() =>
      generatePagesConfig("blog", service, "example.com", lockState),
    ).toThrow(MissingResourceError);
  });

  test("if a service declares kv but the lock file has no corresponding entry, the generator throws a descriptive error", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only", { kv: true });

    expect(() =>
      generatePagesConfig("blog", service, "example.com", lockState),
    ).toThrow(MissingResourceError);
  });
});

// --- Pages wrangler config: temp directory ---

describe("pages config: temp directory", () => {
  test("the generated file is written to a temporary directory, not in the user's project tree", () => {
    const lockState = emptyState();
    const service = pagesService("blog", "admin_only");

    const result = generatePagesConfig("blog", service, "example.com", lockState);
    trackTmpDir(result.tmpDir);

    // The config should be written under the OS temp directory
    expect(result.tmpDir.startsWith(tmpdir())).toBe(true);
    expect(result.configPath.startsWith(result.tmpDir)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
  });
});

// --- Fallback Worker wrangler config: Worker name ---

describe("fallback config: Worker name", () => {
  test("generated fallback Worker wrangler.toml contains the correct Worker name derived from the domain", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('name = "example-com-fallback"');
  });

  test("the Worker name uses the same domain-to-hyphen transformation as other naming conventions", () => {
    const result = generateFallbackWorkerConfig("my.cool.site");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    const expectedName = resourceName("my.cool.site", "fallback");
    expect(content).toContain(`name = "${expectedName}"`);
    expect(content).toContain('name = "my-cool-site-fallback"');
  });
});

// --- Fallback Worker wrangler config: wildcard route ---

describe("fallback config: route pattern", () => {
  test("the wildcard route pattern matches all subdomains of the domain", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('pattern = "*.example.com/*"');
  });

  test("the zone name matches the domain from config", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('zone_name = "example.com"');
  });
});

// --- Fallback Worker wrangler config: entry point ---

describe("fallback config: entry point", () => {
  test("the main entry point field is present and points to the expected Worker source filename", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toContain('main = "index.ts"');
  });
});

// --- Fallback Worker wrangler config: compatibility date ---

describe("fallback config: compatibility date", () => {
  test("a compatibility date is set", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    const content = readFileSync(result.configPath, "utf-8");
    expect(content).toMatch(/compatibility_date = "\d{4}-\d{2}-\d{2}"/);
  });
});

// --- Fallback Worker wrangler config: temp directory ---

describe("fallback config: temp directory", () => {
  test("the generated file is written to a temporary directory", () => {
    const result = generateFallbackWorkerConfig("example.com");
    trackTmpDir(result.tmpDir);

    expect(result.tmpDir.startsWith(tmpdir())).toBe(true);
    expect(result.configPath.startsWith(result.tmpDir)).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
  });
});
