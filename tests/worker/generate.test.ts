import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  generateWorkerSource,
  writeWorkerSource,
  resolveDownPageHtml,
  DownPageNotFoundError,
  WORKER_SOURCE_FILENAME,
} from "../../src/worker/generate.js";
import { defaultDownPageHtml } from "../../src/worker/down-page.js";
import { cleanupTmpDir, createTmpDir } from "../../src/deploy/tmp.js";

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

// --- Generated source: domain embedding ---

describe("generator: domain embedding", () => {
  test("the generated source contains the configured domain name", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain('"example.com"');
    expect(source).toContain("example.com");
  });

  test("the generated source does not contain hardcoded personal-homepage domain", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).not.toContain("heimonen.cc");
    expect(source).not.toContain("heimonen");
  });

  test("the domain is correctly parameterized for different domains", () => {
    const { source } = generateWorkerSource({ domain: "my-cool-site.io" });

    expect(source).toContain('"my-cool-site.io"');
    expect(source).not.toContain("example.com");
  });
});

// --- Generated source: down page HTML ---

describe("generator: down page HTML embedding", () => {
  test("when no custom down_page is provided, the built-in default HTML is embedded", () => {
    const { source, downPageHtml } = generateWorkerSource({
      domain: "example.com",
    });

    // The default HTML should be used
    const expectedHtml = defaultDownPageHtml("example.com");
    expect(downPageHtml).toBe(expectedHtml);

    // The generated source should contain the HTML
    expect(source).toContain("This site is currently offline");
    expect(source).toContain("DOWN_PAGE_HTML");
  });

  test("the built-in default HTML contains the domain name from config", () => {
    const { downPageHtml } = generateWorkerSource({
      domain: "my-site.org",
    });

    expect(downPageHtml).toContain("my-site.org");
    expect(downPageHtml).toContain("Offline");
  });

  test("when a custom down_page file path is provided and the file exists, its contents are embedded", () => {
    const tmpDir = createTmpDir();
    trackTmpDir(tmpDir);

    const customHtml = `<!DOCTYPE html>
<html><head><title>Custom Offline</title></head>
<body><h1>Custom down page for my site</h1></body></html>`;

    const customFilePath = join(tmpDir, "custom-down.html");
    writeFileSync(customFilePath, customHtml, "utf-8");

    const { source, downPageHtml } = generateWorkerSource({
      domain: "example.com",
      downPagePath: "custom-down.html",
      basePath: tmpDir,
    });

    expect(downPageHtml).toBe(customHtml);
    expect(source).toContain("Custom down page for my site");
  });

  test("when a custom down_page file is specified but does not exist, the generator throws a descriptive error", () => {
    expect(() =>
      generateWorkerSource({
        domain: "example.com",
        downPagePath: "nonexistent-page.html",
        basePath: "/tmp/does-not-exist",
      }),
    ).toThrow(DownPageNotFoundError);

    try {
      generateWorkerSource({
        domain: "example.com",
        downPagePath: "nonexistent-page.html",
        basePath: "/tmp/does-not-exist",
      });
    } catch (err) {
      expect((err as Error).message).toContain("nonexistent-page.html");
      expect((err as Error).message).toContain("down page");
    }
  });

  test("custom HTML is embedded as-is without domain injection", () => {
    const tmpDir = createTmpDir();
    trackTmpDir(tmpDir);

    const customHtml = "<html><body>No domain here</body></html>";
    const customFilePath = join(tmpDir, "custom.html");
    writeFileSync(customFilePath, customHtml, "utf-8");

    const { downPageHtml } = generateWorkerSource({
      domain: "example.com",
      downPagePath: "custom.html",
      basePath: tmpDir,
    });

    // Custom HTML should not have the domain injected
    expect(downPageHtml).toBe(customHtml);
    expect(downPageHtml).not.toContain("example.com");
  });
});

// --- Generated source: structure and exports ---

describe("generator: source structure", () => {
  test("the generated source exports handleRequest", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain("export async function handleRequest");
  });

  test("the generated source exports default fetch handler", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain("export default");
    expect(source).toContain("async fetch(request: Request)");
  });

  test("handleRequest accepts an injectable originFetch parameter", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain("originFetch: FetchFn = globalThis.fetch");
  });

  test("the generated source defines the FetchFn type", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain("type FetchFn");
  });

  test("the generated source includes routing constants", () => {
    const { source } = generateWorkerSource({ domain: "example.com" });

    expect(source).toContain("const DOMAIN =");
    expect(source).toContain("const DOWN_URL =");
    expect(source).toContain("const DOWN_PAGE_HTML =");
  });
});

// --- Generated source: HTML escaping ---

describe("generator: HTML escaping", () => {
  test("backticks in custom HTML are escaped in the generated source", () => {
    const tmpDir = createTmpDir();
    trackTmpDir(tmpDir);

    const htmlWithBackticks = "<html><body>Use `code` here</body></html>";
    writeFileSync(join(tmpDir, "ticks.html"), htmlWithBackticks, "utf-8");

    const { source } = generateWorkerSource({
      domain: "example.com",
      downPagePath: "ticks.html",
      basePath: tmpDir,
    });

    // The source should have escaped backticks so it's valid in a template literal
    expect(source).toContain("\\`code\\`");
  });

  test("template literal expressions in custom HTML are escaped", () => {
    const tmpDir = createTmpDir();
    trackTmpDir(tmpDir);

    const htmlWithExpr = "<html><body>${dangerous}</body></html>";
    writeFileSync(join(tmpDir, "expr.html"), htmlWithExpr, "utf-8");

    const { source } = generateWorkerSource({
      domain: "example.com",
      downPagePath: "expr.html",
      basePath: tmpDir,
    });

    // The ${} should be escaped so it's treated as literal text
    expect(source).toContain("\\${dangerous}");
  });
});

// --- File writing ---

describe("generator: file writing", () => {
  test("writeWorkerSource writes the generated source to the target directory", () => {
    const targetDir = createTmpDir();
    trackTmpDir(targetDir);

    const filePath = writeWorkerSource(targetDir, { domain: "example.com" });

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('"example.com"');
    expect(content).toContain("export async function handleRequest");
  });

  test("the written filename matches the wrangler.toml entry point (index.ts)", () => {
    const targetDir = createTmpDir();
    trackTmpDir(targetDir);

    const filePath = writeWorkerSource(targetDir, { domain: "example.com" });

    expect(filePath).toBe(join(targetDir, "index.ts"));
    expect(WORKER_SOURCE_FILENAME).toBe("index.ts");
  });

  test("the written file is in the target directory (temp directory placement)", () => {
    const targetDir = createTmpDir();
    trackTmpDir(targetDir);

    const filePath = writeWorkerSource(targetDir, { domain: "example.com" });

    expect(filePath.startsWith(targetDir)).toBe(true);
    expect(filePath.startsWith(tmpdir())).toBe(true);
  });
});

// --- resolveDownPageHtml ---

describe("generator: resolveDownPageHtml", () => {
  test("returns default HTML when no path is provided", () => {
    const html = resolveDownPageHtml("example.com");

    expect(html).toBe(defaultDownPageHtml("example.com"));
    expect(html).toContain("example.com");
    expect(html).toContain("offline");
  });

  test("reads custom file when path is provided", () => {
    const tmpDir = createTmpDir();
    trackTmpDir(tmpDir);

    const customContent = "<html>Custom</html>";
    writeFileSync(join(tmpDir, "down.html"), customContent, "utf-8");

    const html = resolveDownPageHtml("example.com", "down.html", tmpDir);
    expect(html).toBe(customContent);
  });

  test("throws DownPageNotFoundError when custom file doesn't exist", () => {
    expect(() =>
      resolveDownPageHtml("example.com", "missing.html", "/tmp"),
    ).toThrow(DownPageNotFoundError);
  });
});

// --- Default down page template ---

describe("generator: default down page template", () => {
  test("default HTML is valid and self-contained", () => {
    const html = defaultDownPageHtml("example.com");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
  });

  test("default HTML includes the domain in the title", () => {
    const html = defaultDownPageHtml("my-domain.org");

    expect(html).toContain("my-domain.org");
    expect(html).toContain("<title>");
  });

  test("default HTML has dark theme styling", () => {
    const html = defaultDownPageHtml("example.com");

    expect(html).toContain("#0a0a0a");
    expect(html).toContain("background:");
  });

  test("default HTML contains an offline message", () => {
    const html = defaultDownPageHtml("example.com");

    expect(html.toLowerCase()).toContain("offline");
  });
});
