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
import { copyFunctionsToDistDir } from "../../src/deploy/copy-functions.js";

// --- Test helpers ---

let testRoot: string;

function createTestRoot(): string {
  const dir = join(
    tmpdir(),
    `flaregun-copy-fn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// --- Basic copy tests ---

describe("copyFunctionsToDistDir", () => {
  test("copies files from functions source into dist/functions/", () => {
    // Setup: create functions/ source with a file
    const fnSrc = join(testRoot, "functions");
    mkdirSync(fnSrc);
    writeFileSync(join(fnSrc, "api.ts"), "export default handler;", "utf-8");

    // Setup: create dist/ directory
    const distDir = join(testRoot, "dist");
    mkdirSync(distDir);

    // Act
    copyFunctionsToDistDir(fnSrc, distDir);

    // Assert: dist/functions/api.ts exists with correct content
    const destFile = join(distDir, "functions", "api.ts");
    expect(existsSync(destFile)).toBe(true);
    expect(readFileSync(destFile, "utf-8")).toBe("export default handler;");
  });

  test("preserves subdirectory structure within functions/", () => {
    // Setup: create functions/ with nested directories
    const fnSrc = join(testRoot, "functions");
    mkdirSync(join(fnSrc, "api", "v2"), { recursive: true });
    writeFileSync(join(fnSrc, "api", "index.ts"), "root api", "utf-8");
    writeFileSync(join(fnSrc, "api", "v2", "users.ts"), "v2 users", "utf-8");

    const distDir = join(testRoot, "dist");
    mkdirSync(distDir);

    // Act
    copyFunctionsToDistDir(fnSrc, distDir);

    // Assert: subdirectory structure is preserved
    expect(
      readFileSync(join(distDir, "functions", "api", "index.ts"), "utf-8"),
    ).toBe("root api");
    expect(
      readFileSync(join(distDir, "functions", "api", "v2", "users.ts"), "utf-8"),
    ).toBe("v2 users");
  });

  test("replaces existing dist/functions/ contents with a fresh copy", () => {
    // Setup: create functions/ source
    const fnSrc = join(testRoot, "functions");
    mkdirSync(fnSrc);
    writeFileSync(join(fnSrc, "new-file.ts"), "new content", "utf-8");

    // Setup: create existing dist/functions/ with stale content
    const distDir = join(testRoot, "dist");
    mkdirSync(join(distDir, "functions"), { recursive: true });
    writeFileSync(
      join(distDir, "functions", "old-file.ts"),
      "old content",
      "utf-8",
    );

    // Act
    copyFunctionsToDistDir(fnSrc, distDir);

    // Assert: old file is gone, new file is present
    expect(existsSync(join(distDir, "functions", "old-file.ts"))).toBe(false);
    expect(existsSync(join(distDir, "functions", "new-file.ts"))).toBe(true);
    expect(
      readFileSync(join(distDir, "functions", "new-file.ts"), "utf-8"),
    ).toBe("new content");
  });

  test("creates dist/functions/ if it does not exist", () => {
    const fnSrc = join(testRoot, "functions");
    mkdirSync(fnSrc);
    writeFileSync(join(fnSrc, "handler.ts"), "handler code", "utf-8");

    const distDir = join(testRoot, "dist");
    // Intentionally NOT creating distDir/functions

    copyFunctionsToDistDir(fnSrc, distDir);

    expect(existsSync(join(distDir, "functions", "handler.ts"))).toBe(true);
  });

  test("handles multiple files at the top level", () => {
    const fnSrc = join(testRoot, "functions");
    mkdirSync(fnSrc);
    writeFileSync(join(fnSrc, "api.ts"), "api", "utf-8");
    writeFileSync(join(fnSrc, "middleware.ts"), "middleware", "utf-8");
    writeFileSync(join(fnSrc, "tsconfig.json"), "{}", "utf-8");

    const distDir = join(testRoot, "dist");
    mkdirSync(distDir);

    copyFunctionsToDistDir(fnSrc, distDir);

    expect(existsSync(join(distDir, "functions", "api.ts"))).toBe(true);
    expect(existsSync(join(distDir, "functions", "middleware.ts"))).toBe(true);
    expect(existsSync(join(distDir, "functions", "tsconfig.json"))).toBe(true);
  });
});
