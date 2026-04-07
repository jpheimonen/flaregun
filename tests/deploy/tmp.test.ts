import { describe, test, expect } from "bun:test";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTmpDir, cleanupTmpDir } from "../../src/deploy/tmp.js";

// --- createTmpDir ---

describe("tmp: createTmpDir", () => {
  test("creating a temp directory returns a valid path to an existing directory", () => {
    const dir = createTmpDir();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(tmpdir())).toBe(true);
      expect(dir).toContain("flaregun-");
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test("each call creates a unique directory", () => {
    const dir1 = createTmpDir();
    const dir2 = createTmpDir();
    try {
      expect(dir1).not.toBe(dir2);
    } finally {
      cleanupTmpDir(dir1);
      cleanupTmpDir(dir2);
    }
  });
});

// --- cleanupTmpDir ---

describe("tmp: cleanupTmpDir", () => {
  test("the cleanup function removes the directory and all its contents", () => {
    const dir = createTmpDir();

    // Add some files and subdirectories
    writeFileSync(join(dir, "test.txt"), "hello", "utf-8");
    const subDir = join(dir, "sub");
    mkdirSync(subDir);
    writeFileSync(join(subDir, "nested.txt"), "world", "utf-8");

    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "test.txt"))).toBe(true);
    expect(existsSync(join(subDir, "nested.txt"))).toBe(true);

    cleanupTmpDir(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test("cleaning up a directory that has already been removed does not throw", () => {
    const dir = createTmpDir();

    // Clean up once
    cleanupTmpDir(dir);
    expect(existsSync(dir)).toBe(false);

    // Clean up again — should not throw
    expect(() => cleanupTmpDir(dir)).not.toThrow();
  });

  test("cleaning up a path that never existed does not throw", () => {
    const fakePath = join(tmpdir(), "flaregun-nonexistent-" + Date.now());
    expect(existsSync(fakePath)).toBe(false);
    expect(() => cleanupTmpDir(fakePath)).not.toThrow();
  });
});
