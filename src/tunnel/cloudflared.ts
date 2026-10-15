/**
 * Finds cloudflared, and downloads it from Cloudflare's GitHub releases when
 * it's missing so the person doesn't have to install it themselves.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Where flaregun keeps its own copy of cloudflared. */
export const LOCAL_BIN_DIR = join(homedir(), ".local", "share", "flaregun", "bin");
export const LOCAL_CLOUDFLARED = join(LOCAL_BIN_DIR, "cloudflared");

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";
export const INSTALL_DOCS =
  "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";

/** The release file for this machine, or null where flaregun can't install it. */
export function releaseAsset(
  system: string = process.platform,
  arch: string = process.arch,
): { url: string; archive: boolean } | null {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!cpu) return null;
  if (system === "linux") return { url: `${RELEASES}/cloudflared-linux-${cpu}`, archive: false };
  if (system === "darwin") return { url: `${RELEASES}/cloudflared-darwin-${cpu}.tgz`, archive: true };
  return null;
}

/**
 * Returns the cloudflared command to run: "cloudflared" when it's on PATH,
 * flaregun's own copy when that exists, otherwise null.
 */
export async function findCloudflared(
  binaryExists: (name: string) => Promise<boolean>,
): Promise<string | null> {
  if (await binaryExists("cloudflared")) return "cloudflared";
  if (existsSync(LOCAL_CLOUDFLARED)) return LOCAL_CLOUDFLARED;
  return null;
}

/** Downloads cloudflared into LOCAL_BIN_DIR and returns its path. */
export async function installCloudflared(
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const asset = releaseAsset();
  if (!asset) {
    throw new Error(`flaregun can't download cloudflared for this system. Install it from ${INSTALL_DOCS}`);
  }

  const response = await fetchFn(asset.url);
  if (!response.ok) {
    throw new Error(`Downloading cloudflared failed (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  mkdirSync(LOCAL_BIN_DIR, { recursive: true });

  if (asset.archive) {
    const archivePath = join(LOCAL_BIN_DIR, "cloudflared.tgz");
    writeFileSync(archivePath, bytes);
    const tar = Bun.spawn(["tar", "-xzf", archivePath, "-C", LOCAL_BIN_DIR], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await tar.exited) !== 0) {
      throw new Error(`Unpacking cloudflared failed: ${await new Response(tar.stderr).text()}`);
    }
  } else {
    const partial = `${LOCAL_CLOUDFLARED}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, LOCAL_CLOUDFLARED);
  }
  chmodSync(LOCAL_CLOUDFLARED, 0o755);
  return LOCAL_CLOUDFLARED;
}
