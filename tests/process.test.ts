import { describe, expect, test } from "bun:test";
import { binaryExists, runCommand } from "../src/process/index.js";
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import { join } from "path";

describe("binaryExists", () => {
  test("returns true for a binary known to exist (bun)", async () => {
    const result = await binaryExists("bun");
    expect(result).toBe(true);
  });

  test("returns false for a nonexistent binary name", async () => {
    const result = await binaryExists("nonexistent-binary-xyz");
    expect(result).toBe(false);
  });
});

describe("runCommand", () => {
  test("returns exit code 0 and captured stdout for a successful command", async () => {
    const result = await runCommand(["echo", "hello world"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr).toBe("");
  });

  test("returns a non-zero exit code and captured stderr for a failing command", async () => {
    const result = await runCommand(
      ["bash", "-c", "echo 'error output' >&2; exit 1"],
      process.cwd(),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe("error output");
  });

  test("executes in the specified working directory", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "flaregun-test-"));
    const result = await runCommand(["pwd"], tempDir);
    expect(result.exitCode).toBe(0);
    // Resolve symlinks (e.g., /tmp → /private/tmp on macOS)
    const actualDir = result.stdout.trim();
    expect(actualDir).toBe(tempDir);
  });
});
