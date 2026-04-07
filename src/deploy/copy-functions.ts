/**
 * Functions copy utility.
 *
 * Copies a service's `functions/` source directory into its dist output
 * directory at `dist/functions/`. This ensures Pages Functions survive
 * build tool output wipes — build tools typically clean the dist directory
 * before writing, which would delete functions if they lived inside dist.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "fs";
import { join } from "path";

/**
 * Recursively copies all files and subdirectories from `src` into `dest`.
 * Creates directories as needed and overwrites existing files.
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copies a `functions/` source directory into `dist/functions/` within
 * the service's dist output directory.
 *
 * If `dist/functions/` already exists, its contents are replaced with
 * a fresh copy (each deploy gets a fresh copy).
 *
 * @param functionsSrcPath - Absolute path to the functions source directory
 * @param distPath - Absolute path to the service's dist output directory
 */
export function copyFunctionsToDistDir(
  functionsSrcPath: string,
  distPath: string,
): void {
  const destDir = join(distPath, "functions");

  // Remove existing dist/functions/ if present to ensure a clean copy
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }

  copyDirRecursive(functionsSrcPath, destDir);
}
