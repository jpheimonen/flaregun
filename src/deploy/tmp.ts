/**
 * Temporary directory management for deploy pipeline.
 *
 * Creates and cleans up temporary directories used by the wrangler config
 * generator and fallback Worker generator. Temporary directories are created
 * in the OS temp directory and cleaned up after wrangler completes.
 */

import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Creates a temporary directory with a flaregun-specific prefix.
 *
 * The directory is created under the OS temp directory (e.g., /tmp/flaregun-XXXXXX).
 * The caller is responsible for cleaning up via {@link cleanupTmpDir}.
 *
 * @returns Absolute path to the newly created temporary directory
 */
export function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "flaregun-"));
}

/**
 * Removes a temporary directory and all its contents.
 *
 * Safe to call on a directory that has already been removed — does not throw
 * if the path no longer exists.
 *
 * @param dirPath - Absolute path to the temporary directory to remove
 */
export function cleanupTmpDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    return;
  }
  rmSync(dirPath, { recursive: true, force: true });
}
