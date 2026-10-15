import { describe, expect, test } from "bun:test";
import type { BrowserTab, CdpConnection } from "../src/browser/cdp.js";
import { DashboardStepError } from "../src/browser/cloudflare-dashboard.js";
import { BROWSERS } from "../src/browser/discovery.js";
import { createDashboard, type DashboardDeps } from "../src/setup/dashboard.js";
import { scriptedIO } from "./helpers/setup-fakes.js";

const BRAVE = BROWSERS.find((b) => b.name === "Brave")!;
const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/abc";

function fakes(overrides: Partial<DashboardDeps> = {}) {
  const record = { opened: [] as string[], defaultOpened: [] as string[], tabs: [] as string[], closed: 0 };
  const conn = { close: () => record.closed++ } as unknown as CdpConnection;
  const deps: Partial<DashboardDeps> = {
    findBrowser: async () => ({ kind: BRAVE, endpoint: ENDPOINT }),
    openInBrowser: async (_kind, url) => {
      record.opened.push(url);
      return true;
    },
    openWithDefault: async (url) => {
      record.defaultOpened.push(url);
      return true;
    },
    connect: async () => conn,
    openTab: async (_conn, url) => {
      record.tabs.push(url);
      return {} as BrowserTab;
    },
    createBootstrapToken: async () => ["captured-token"],
    switchWaitMs: 10,
    allowWaitMs: 10,
    ...overrides,
  };
  return { deps, record };
}

const acceptOnly = (good: string) => async (token: string) => token === good;

describe("bootstrapToken", () => {
  test("creates the token in the person's browser without asking anything", async () => {
    const { deps, record } = fakes();
    const io = scriptedIO([]);
    const dashboard = createDashboard(deps);

    expect(await dashboard.bootstrapToken(io.io, acceptOnly("captured-token"))).toBe("captured-token");
    expect(record.tabs).toEqual(["https://dash.cloudflare.com/profile/api-tokens"]);
    expect(io.questions).toEqual([]);
    expect(io.output.join("\n")).toContain('Click "Allow"');

    dashboard.close();
    expect(record.closed).toBe(1);
  });

  test("opens the remote debugging switch and waits for it", async () => {
    let switchedOn = false;
    const { deps, record } = fakes({
      findBrowser: async () => ({ kind: BRAVE, endpoint: switchedOn ? ENDPOINT : null }),
      openInBrowser: async (_kind, url) => {
        record.opened.push(url);
        switchedOn = true; // the person flips the switch
        return true;
      },
    });
    const io = scriptedIO([]);

    await createDashboard(deps).bootstrapToken(io.io, acceptOnly("captured-token"));

    expect(record.opened).toEqual(["brave://inspect/#remote-debugging"]);
    expect(io.output.join("\n")).toContain("brave://inspect/#remote-debugging");
  });

  test("asks for a paste in the open tab when a dashboard step can't be found", async () => {
    const { deps, record } = fakes({
      createBootstrapToken: async () => {
        throw new DashboardStepError('click "Continue to summary"');
      },
    });
    const io = scriptedIO(["pasted-token"]);

    expect(await createDashboard(deps).bootstrapToken(io.io, acceptOnly("pasted-token"))).toBe("pasted-token");
    expect(io.output.join("\n")).toContain('Couldn\'t click "Continue to summary"');
    expect(record.defaultOpened).toEqual([]); // the tab flaregun opened is still there
  });

  test("falls back to opening the page normally when the default browser isn't supported", async () => {
    const { deps, record } = fakes({ findBrowser: async () => ({ kind: null, endpoint: null }) });
    const io = scriptedIO(["wrong", "pasted-token"]);

    expect(await createDashboard(deps).bootstrapToken(io.io, acceptOnly("pasted-token"))).toBe("pasted-token");
    expect(record.defaultOpened).toEqual(["https://dash.cloudflare.com/profile/api-tokens"]);
    const output = io.output.join("\n");
    expect(output).toContain('"Use template" next to "Create Additional Tokens"');
    expect(output).toContain("didn't accept that token");
  });

  test("with the browser turned off, never touches it", async () => {
    let looked = false;
    const { deps } = fakes({
      useBrowser: false,
      findBrowser: async () => {
        looked = true;
        return { kind: BRAVE, endpoint: ENDPOINT };
      },
    });
    await createDashboard(deps).bootstrapToken(scriptedIO(["t"]).io, acceptOnly("t"));
    expect(looked).toBe(false);
  });

  test("a refused connection falls back to manual steps", async () => {
    const { deps } = fakes({
      connect: async () => {
        throw new Error("The browser refused the connection.");
      },
    });
    const io = scriptedIO(["t"]);
    await createDashboard(deps).bootstrapToken(io.io, acceptOnly("t"));
    expect(io.output.join("\n")).toContain("Couldn't connect to Brave");
  });
});

describe("showZeroTrustOnboarding", () => {
  test("opens Zero Trust in a browser tab and explains what to pick", async () => {
    const { deps, record } = fakes();
    const io = scriptedIO([]);
    await createDashboard(deps).showZeroTrustOnboarding(io.io);
    expect(record.tabs).toEqual(["https://one.dash.cloudflare.com/"]);
    expect(io.output.join("\n")).toContain("Free plan");
  });
});
