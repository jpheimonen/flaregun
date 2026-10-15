import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { browserFor, findBrowser, readEndpoint, switchPage } from "../../src/browser/discovery.js";

let home: string;
const listening = async () => true;
const PATH = "/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-123456789abc";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flaregun-discovery-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writePortFile(folder: string, content: string) {
  mkdirSync(join(home, folder), { recursive: true });
  writeFileSync(join(home, folder, "DevToolsActivePort"), content);
}

describe("readEndpoint", () => {
  test("turns a valid port file into a WebSocket address", async () => {
    writePortFile("p", `9222\n${PATH}\n`);
    expect(await readEndpoint(join(home, "p", "DevToolsActivePort"), listening)).toBe(`ws://127.0.0.1:9222${PATH}`);
  });

  test("ignores a stale file whose port no longer answers", async () => {
    writePortFile("p", `9222\n${PATH}\n`);
    expect(await readEndpoint(join(home, "p", "DevToolsActivePort"), async () => false)).toBeNull();
  });

  test("rejects malformed files", async () => {
    for (const content of ["", "abc\n" + PATH, "70000\n" + PATH, "9222\n/somewhere/else"]) {
      writePortFile("p", content);
      expect(await readEndpoint(join(home, "p", "DevToolsActivePort"), listening)).toBeNull();
    }
  });
});

describe("findBrowser", () => {
  test("uses the default browser's profile folder", async () => {
    writePortFile(".config/BraveSoftware/Brave-Browser", `9333\n${PATH}`);
    writePortFile(".config/google-chrome", `9444\n${PATH}`);
    const found = await findBrowser({
      home,
      system: "linux",
      defaultId: async () => "brave-browser.desktop",
      portListening: listening,
    });
    expect(found.kind?.name).toBe("Brave");
    expect(found.endpoint).toBe(`ws://127.0.0.1:9333${PATH}`);
  });

  test("reports the default browser when remote debugging is off", async () => {
    const found = await findBrowser({
      home,
      system: "linux",
      defaultId: async () => "google-chrome.desktop",
      portListening: listening,
    });
    expect(found).toEqual({ kind: browserFor("google-chrome.desktop"), endpoint: null });
    expect(switchPage(found.kind!)).toBe("chrome://inspect/#remote-debugging");
  });

  test("checks every supported browser when the default is unknown", async () => {
    writePortFile("snap/chromium/common/chromium", `9555\n${PATH}`);
    const found = await findBrowser({ home, system: "linux", defaultId: async () => "firefox.desktop", portListening: listening });
    expect(found.kind?.name).toBe("Chromium");
    expect(found.endpoint).toBe(`ws://127.0.0.1:9555${PATH}`);
  });

  test("uses macOS profile folders and bundle ids", async () => {
    writePortFile("Library/Application Support/Microsoft Edge", `9666\n${PATH}`);
    const found = await findBrowser({ home, system: "darwin", defaultId: async () => "com.microsoft.edgemac", portListening: listening });
    expect(found.kind?.name).toBe("Microsoft Edge");
    expect(found.endpoint).toBe(`ws://127.0.0.1:9666${PATH}`);
  });

  test("an explicit profile folder wins", async () => {
    writePortFile("custom", `9777\n${PATH}`);
    const found = await findBrowser({ home, profile: join(home, "custom"), portListening: listening });
    expect(found.endpoint).toBe(`ws://127.0.0.1:9777${PATH}`);
  });
});
