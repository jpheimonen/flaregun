/**
 * The Cloudflare dashboard steps setup can't do through the API.
 *
 * When the person's default browser allows it, flaregun opens a tab there and
 * clicks through the steps itself. Otherwise, or when a step can't be found,
 * it opens the page and tells the person exactly what to click.
 */

import { BrowserTab, CdpConnection } from "../browser/cdp.js";
import {
  API_TOKENS_URL,
  ZERO_TRUST_URL,
  createBootstrapToken,
  DashboardStepError,
} from "../browser/cloudflare-dashboard.js";
import {
  findBrowser,
  openInBrowser,
  openWithDefault,
  switchPage,
  SUPPORTED_NAMES,
  type BrowserLookup,
  type BrowserKind,
} from "../browser/discovery.js";
import type { SetupIO } from "./io.js";

export interface Dashboard {
  /**
   * Gets a token made from the "Create Additional Tokens" template. `accept`
   * checks a candidate with Cloudflare; the person is asked again until one works.
   */
  bootstrapToken(io: SetupIO, accept: (token: string) => Promise<boolean>): Promise<string>;
  /** Shows the Zero Trust onboarding page so the person can pick a team name and plan. */
  showZeroTrustOnboarding(io: SetupIO): Promise<void>;
  /** Disconnects from the browser. Tabs flaregun opened stay open. */
  close(): void;
}

export interface DashboardDeps {
  useBrowser: boolean;
  findBrowser: () => Promise<BrowserLookup>;
  openInBrowser: (kind: BrowserKind, url: string) => Promise<boolean>;
  openWithDefault: (url: string) => Promise<boolean>;
  connect: (endpoint: string, timeoutMs: number) => Promise<CdpConnection>;
  openTab: (conn: CdpConnection, url: string) => Promise<BrowserTab>;
  createBootstrapToken: typeof createBootstrapToken;
  /** How long to wait for the person to switch on remote debugging. */
  switchWaitMs: number;
  /** How long to wait for the person to click Allow. */
  allowWaitMs: number;
}

const DEFAULT_DEPS: DashboardDeps = {
  useBrowser: true,
  findBrowser: () => findBrowser(),
  openInBrowser: (kind, url) => openInBrowser(kind, url),
  openWithDefault: (url) => openWithDefault(url),
  connect: (endpoint, timeoutMs) => CdpConnection.connect(endpoint, timeoutMs),
  openTab: (conn, url) => BrowserTab.open(conn, url),
  createBootstrapToken,
  switchWaitMs: 3 * 60_000,
  allowWaitMs: 90_000,
};

export const MANUAL_TOKEN_STEPS = [
  `  1. Open ${API_TOKENS_URL}`,
  `  2. Click "Create Token", then "Use template" next to "Create Additional Tokens"`,
  `  3. Click "Continue to summary", then "Create Token", and copy the token`,
];

export function createDashboard(overrides: Partial<DashboardDeps> = {}): Dashboard {
  const deps: DashboardDeps = { ...DEFAULT_DEPS, ...overrides };
  // undefined: not tried yet; null: tried and not available.
  let connection: CdpConnection | null | undefined = deps.useBrowser ? undefined : null;

  async function browser(io: SetupIO): Promise<CdpConnection | null> {
    if (connection === undefined) {
      connection = await takeOverBrowser(io, deps);
    }
    return connection;
  }

  return {
    async bootstrapToken(io, accept) {
      const conn = await browser(io);
      let tabOpen = false;

      if (conn) {
        try {
          const tab = await deps.openTab(conn, API_TOKENS_URL);
          tabOpen = true;
          io.print("  Creating a token in your browser…");
          const candidates = await deps.createBootstrapToken(tab, (msg) => io.print(msg));
          for (const candidate of candidates) {
            if (await accept(candidate)) {
              io.print("  ✓ Token created in the dashboard.");
              return candidate;
            }
          }
          io.print("  The page showed a token, but Cloudflare didn't accept it.");
        } catch (err) {
          if (err instanceof DashboardStepError) {
            io.print(`  ${err.message} Please finish in the open tab.`);
          } else {
            io.print(`  Lost the browser connection (${errorMessage(err)}).`);
            connection = null;
          }
        }
      }

      if (!tabOpen) {
        await deps.openWithDefault(API_TOKENS_URL);
      }
      io.print("\nCreate a token in the Cloudflare dashboard:");
      for (const line of MANUAL_TOKEN_STEPS) io.print(line);
      io.print("flaregun uses it once to create its own token with just the permissions it needs, then deletes it.");
      io.print("(A token you already made for flaregun works too.)\n");

      while (true) {
        const token = (await io.prompt("Paste the token:")).trim();
        if (!token) continue;
        if (await accept(token)) return token;
        io.print("Cloudflare didn't accept that token. Copy it again and paste it here.");
      }
    },

    async showZeroTrustOnboarding(io) {
      const conn = await browser(io);
      let opened = false;
      if (conn) {
        try {
          await deps.openTab(conn, ZERO_TRUST_URL);
          opened = true;
        } catch {
          connection = null;
        }
      }
      if (!opened) await deps.openWithDefault(ZERO_TRUST_URL);
      io.print(`\nCloudflare wants Zero Trust switched on in the dashboard first (${ZERO_TRUST_URL}).`);
      io.print("  Pick a team name and the Free plan there. flaregun doesn't click plan or billing pages for you.");
    },

    close() {
      connection?.close();
      connection = null;
    },
  };
}

/**
 * Connects to the person's default browser. If remote debugging is off, opens
 * the page where it's switched on and waits for the person to do it.
 */
async function takeOverBrowser(io: SetupIO, deps: DashboardDeps): Promise<CdpConnection | null> {
  let { kind, endpoint } = await deps.findBrowser();
  const name = kind?.name ?? "your browser";

  if (!endpoint) {
    if (!kind) {
      io.print(
        `  flaregun can click through the Cloudflare dashboard for you in ${SUPPORTED_NAMES}, ` +
          "but your default browser isn't one of them, so you'll do a few clicks yourself.",
      );
      return null;
    }
    const page = switchPage(kind);
    io.print(`\n  flaregun can click through the Cloudflare dashboard for you in ${kind.name}.`);
    io.print(`  It needs remote debugging switched on: in ${kind.name}, open ${page} and turn it on.`);
    if (await deps.openInBrowser(kind, page)) {
      io.print(`  (flaregun just opened that page in ${kind.name}.)`);
    }
    endpoint = await io.waitUntil(
      `  Waiting for remote debugging… press Enter to do the clicks yourself instead.`,
      async () => (await deps.findBrowser()).endpoint,
      deps.switchWaitMs,
    );
    if (!endpoint) {
      io.print("  OK, you'll do the dashboard clicks yourself.");
      return null;
    }
  }

  io.print(`  ${name[0].toUpperCase()}${name.slice(1)} will ask whether to allow remote debugging. Click "Allow".`);
  try {
    const conn = await deps.connect(endpoint, deps.allowWaitMs);
    io.print(`  ✓ Connected to ${name}.`);
    return conn;
  } catch (err) {
    io.print(`  Couldn't connect to ${name} (${errorMessage(err)}). You'll do the dashboard clicks yourself.`);
    return null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
