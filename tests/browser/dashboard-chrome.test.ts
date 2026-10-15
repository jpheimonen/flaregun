/**
 * Drives a real headless Chrome through the fake dashboard, the same way
 * `flaregun setup` drives the person's browser.
 *
 * Needs a Chrome or Chromium binary; set FLAREGUN_TEST_CHROME to its path.
 * Skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BrowserTab, CdpConnection } from "../../src/browser/cdp.js";
import { createBootstrapToken, DashboardStepError } from "../../src/browser/cloudflare-dashboard.js";
import { findBrowser } from "../../src/browser/discovery.js";
import { FAKE_TOKEN, startFakeDashboard } from "./fake-dashboard.js";

const CHROME = process.env.FLAREGUN_TEST_CHROME;

describe.skipIf(!CHROME)("dashboard automation in a real browser", () => {
  let profile: string;
  let chrome: ReturnType<typeof Bun.spawn>;
  let dashboard: ReturnType<typeof startFakeDashboard>;
  let conn: CdpConnection;

  beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), "flaregun-chrome-"));
    chrome = Bun.spawn(
      [CHROME!, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
      { stdout: "ignore", stderr: "ignore" },
    );
    dashboard = startFakeDashboard();

    // Chrome writes DevToolsActivePort into the profile once it listens.
    let endpoint: string | null = null;
    for (let i = 0; i < 100 && !endpoint; i++) {
      endpoint = (await findBrowser({ profile })).endpoint;
      if (!endpoint) await Bun.sleep(100);
    }
    expect(endpoint).toStartWith("ws://127.0.0.1:");
    conn = await CdpConnection.connect(endpoint!, 5000);
  }, 20_000);

  afterAll(() => {
    conn?.close();
    chrome?.kill();
    dashboard?.stop();
    rmSync(profile, { recursive: true, force: true });
  });

  const options = (tokensUrl: string) => ({ tokensUrl, loginMs: 10_000, stepMs: 5_000, intervalMs: 100 });

  test("logs in, clicks through the Create Additional Tokens template and reads the token", async () => {
    const printed: string[] = [];
    const tab = await BrowserTab.open(conn, dashboard.url);

    const tokens = await createBootstrapToken(tab, (msg) => printed.push(msg), options(dashboard.url));

    expect(tokens).toContain(FAKE_TOKEN);
    // 32-character hex IDs on the page are not tokens.
    expect(tokens).not.toContain("0123456789abcdef0123456789abcdef");
    expect(printed.join("\n")).toContain("Log in to Cloudflare");
    expect(printed.join("\n")).toContain("checking that a person is using the browser");
    // Exactly the four expected clicks, in order, with the right template.
    expect(await tab.evaluate<string[]>("window.__clicks")).toEqual([
      "Create Token",
      "Use template",
      "Continue to summary",
      "Create Token",
    ]);
    await tab.close();
  }, 30_000);

  test("reports which step it couldn't find", async () => {
    const tab = await BrowserTab.open(conn, "data:text/html,<p>nothing here</p>");
    const url = dashboard.url.replace("/profile/api-tokens", "/missing");
    await tab.navigate(url);
    const error = await createBootstrapToken(tab, () => {}, { ...options(url), stepMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(DashboardStepError);
    expect((error as DashboardStepError).step).toBe('click "Create Token"');
    await tab.close();
  }, 30_000);
});
