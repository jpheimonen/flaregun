import { describe, expect, test } from "bun:test";
import { findCloudflared, releaseAsset } from "../src/tunnel/cloudflared.js";

describe("releaseAsset", () => {
  test("picks the plain binary on Linux and the archive on macOS", () => {
    expect(releaseAsset("linux", "x64")).toEqual({
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
      archive: false,
    });
    expect(releaseAsset("linux", "arm64")?.url).toEndWith("cloudflared-linux-arm64");
    expect(releaseAsset("darwin", "arm64")).toEqual({
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
      archive: true,
    });
  });

  test("has nothing for systems flaregun can't install on", () => {
    expect(releaseAsset("win32", "x64")).toBeNull();
    expect(releaseAsset("linux", "ia32")).toBeNull();
  });
});

describe("findCloudflared", () => {
  test("prefers cloudflared on PATH", async () => {
    expect(await findCloudflared(async () => true)).toBe("cloudflared");
  });
});
