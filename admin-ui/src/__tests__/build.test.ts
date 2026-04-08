/**
 * Tests for build output and embedding.
 *
 * Verifies that the Vite build produces the expected static assets
 * in the output directory for the admin backend to serve.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const DIST_DIR = join(__dirname, "..", "..", "dist");

describe("Build output", () => {
  it("produces index.html in the dist directory", () => {
    expect(existsSync(join(DIST_DIR, "index.html"))).toBe(true);
  });

  it("produces at least one JS bundle", () => {
    const assetsDir = join(DIST_DIR, "assets");
    expect(existsSync(assetsDir)).toBe(true);

    const files = readdirSync(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("produces CSS output", () => {
    const assetsDir = join(DIST_DIR, "assets");
    expect(existsSync(assetsDir)).toBe(true);

    const files = readdirSync(assetsDir);
    const cssFiles = files.filter((f) => f.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("places build output in the expected directory for the backend to serve", () => {
    // The admin backend's handleStaticFile method serves from the spaDir
    // parameter, which at runtime is resolved to admin-ui/dist/
    expect(existsSync(DIST_DIR)).toBe(true);
    expect(existsSync(join(DIST_DIR, "index.html"))).toBe(true);
  });
});
