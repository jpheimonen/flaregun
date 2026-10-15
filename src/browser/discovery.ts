/**
 * Finds the person's own Chromium-family browser and the address its remote
 * debugging listens on.
 *
 * Recent Chrome-family browsers can expose the person's everyday profile to
 * DevTools clients: the person switches it on at `<scheme>://inspect/#remote-debugging`,
 * the browser writes a `DevToolsActivePort` file into its profile folder, and it
 * asks the person to allow each new connection. Flaregun reads that file, so it
 * drives the browser the person is already logged in to instead of starting a
 * separate one.
 */

import { existsSync, readFileSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { connect } from "net";

export const PORT_FILE = "DevToolsActivePort";
/** A browser profile folder to use instead of the default browser's usual one. */
export const PROFILE_SETTING = "FLAREGUN_BROWSER_PROFILE";

export interface BrowserKind {
  name: string;
  /** URL scheme for the browser's own pages, e.g. "brave" for brave://inspect */
  scheme: string;
  /** Linux .desktop file names that identify this browser as the default */
  desktopIds: string[];
  /** macOS bundle ids that identify this browser as the default */
  bundleIds: string[];
  /** macOS application name, used with `open -a` */
  macApp: string;
  /** Profile folders relative to the home directory on Linux */
  linuxFolders: string[];
  /** Profile folders relative to the home directory on macOS */
  macFolders: string[];
}

export const BROWSERS: BrowserKind[] = [
  {
    name: "Google Chrome",
    scheme: "chrome",
    desktopIds: ["google-chrome.desktop", "com.google.chrome.desktop"],
    bundleIds: ["com.google.chrome"],
    macApp: "Google Chrome",
    linuxFolders: [".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"],
    macFolders: ["Library/Application Support/Google/Chrome"],
  },
  {
    name: "Brave",
    scheme: "brave",
    desktopIds: ["brave-browser.desktop", "com.brave.browser.desktop"],
    bundleIds: ["com.brave.browser"],
    macApp: "Brave Browser",
    linuxFolders: [
      ".config/BraveSoftware/Brave-Browser",
      ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    ],
    macFolders: ["Library/Application Support/BraveSoftware/Brave-Browser"],
  },
  {
    name: "Microsoft Edge",
    scheme: "edge",
    desktopIds: ["microsoft-edge.desktop", "com.microsoft.edge.desktop"],
    bundleIds: ["com.microsoft.edgemac"],
    macApp: "Microsoft Edge",
    linuxFolders: [".config/microsoft-edge", ".var/app/com.microsoft.Edge/config/microsoft-edge"],
    macFolders: ["Library/Application Support/Microsoft Edge"],
  },
  {
    name: "Chromium",
    scheme: "chrome",
    desktopIds: [
      "chromium.desktop",
      "chromium-browser.desktop",
      "chromium_chromium.desktop",
      "org.chromium.chromium.desktop",
    ],
    bundleIds: ["org.chromium.chromium"],
    macApp: "Chromium",
    linuxFolders: [
      ".config/chromium",
      "snap/chromium/common/chromium",
      ".var/app/org.chromium.Chromium/config/chromium",
    ],
    macFolders: ["Library/Application Support/Chromium"],
  },
  {
    name: "Vivaldi",
    scheme: "vivaldi",
    desktopIds: ["vivaldi-stable.desktop", "vivaldi.desktop"],
    bundleIds: ["com.vivaldi.vivaldi"],
    macApp: "Vivaldi",
    linuxFolders: [".config/vivaldi"],
    macFolders: ["Library/Application Support/Vivaldi"],
  },
];

export const SUPPORTED_NAMES = "Chrome, Brave, Edge, Chromium or Vivaldi";

/** The page where the person switches on remote debugging for their own profile. */
export function switchPage(kind: BrowserKind): string {
  return `${kind.scheme}://inspect/#remote-debugging`;
}

export interface DiscoveryOptions {
  home?: string;
  system?: string;
  /** Returns the OS identity of the default browser (desktop id or bundle id). */
  defaultId?: () => Promise<string | null>;
  /** Explicit profile folder; defaults to $FLAREGUN_BROWSER_PROFILE. */
  profile?: string;
  /** Checks that the port accepts connections; stale port files outlive crashed browsers. */
  portListening?: (port: number) => Promise<boolean>;
}

export interface BrowserLookup {
  /** The default browser, or null if it isn't a supported Chrome-family browser. */
  kind: BrowserKind | null;
  /** DevTools WebSocket address when remote debugging is on, otherwise null. */
  endpoint: string | null;
}

/**
 * Looks up the default browser and, if remote debugging is on, its DevTools address.
 * When the default browser is unknown, every supported browser is checked.
 */
export async function findBrowser(options: DiscoveryOptions = {}): Promise<BrowserLookup> {
  const home = options.home ?? homedir();
  const system = options.system ?? platform();
  const portListening = options.portListening ?? isPortListening;
  const profile = options.profile ?? process.env[PROFILE_SETTING]?.trim();

  if (profile) {
    const endpoint = await readEndpoint(join(profile, PORT_FILE), portListening);
    return { kind: null, endpoint };
  }

  const identity = await (options.defaultId ?? (() => installedDefault(home, system)))();
  const kind = browserFor(identity);

  for (const candidate of kind ? [kind] : BROWSERS) {
    const folders = system === "darwin" ? candidate.macFolders : candidate.linuxFolders;
    for (const folder of folders) {
      const endpoint = await readEndpoint(join(home, folder, PORT_FILE), portListening);
      if (endpoint) {
        return { kind: candidate, endpoint };
      }
    }
  }

  return { kind, endpoint: null };
}

/** Maps a desktop id or bundle id to a supported browser. */
export function browserFor(identity: string | null): BrowserKind | null {
  const id = (identity ?? "").trim().toLowerCase();
  if (!id) return null;
  return BROWSERS.find((b) => b.desktopIds.includes(id) || b.bundleIds.includes(id)) ?? null;
}

/**
 * Reads a DevToolsActivePort file. The first line is the port, the second the
 * browser's WebSocket path.
 */
export async function readEndpoint(
  portFile: string,
  portListening: (port: number) => Promise<boolean> = isPortListening,
): Promise<string | null> {
  if (!existsSync(portFile)) return null;
  let lines: string[];
  try {
    lines = readFileSync(portFile, "utf-8").split("\n").map((l) => l.trim());
  } catch {
    return null;
  }
  const [portLine, path] = lines;
  if (!/^\d+$/.test(portLine ?? "")) return null;
  const port = parseInt(portLine, 10);
  if (port < 1 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/.test(path ?? "")) return null;
  if (!(await portListening(port))) return null;
  return `ws://127.0.0.1:${port}${path}`;
}

/** True when something accepts TCP connections on 127.0.0.1:port within half a second. */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function installedDefault(home: string, system: string): Promise<string | null> {
  if (system === "linux") {
    for (const cmd of [
      ["xdg-settings", "get", "default-web-browser"],
      ["xdg-mime", "query", "default", "x-scheme-handler/https"],
    ]) {
      const out = await runQuietly(cmd);
      if (out) return out;
    }
    return null;
  }
  if (system === "darwin") {
    const plist = join(
      home,
      "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    );
    const json = await runQuietly(["plutil", "-convert", "json", "-o", "-", plist]);
    if (!json) return null;
    try {
      const handlers = (JSON.parse(json).LSHandlers ?? []) as Array<Record<string, unknown>>;
      const https = handlers.find((h) => h.LSHandlerURLScheme === "https");
      return typeof https?.LSHandlerRoleAll === "string" ? https.LSHandlerRoleAll : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function runQuietly(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/**
 * Opens a page in the given browser. Browser-internal pages such as
 * brave://inspect can't be opened through xdg-open, but browsers accept them on
 * their own command line, which hands the URL to the already running window.
 */
export async function openInBrowser(
  kind: BrowserKind,
  url: string,
  system: string = platform(),
): Promise<boolean> {
  if (system === "darwin") {
    return (await runExit(["open", "-a", kind.macApp, url])) === 0;
  }
  const command = linuxLaunchCommand(kind);
  if (!command) return false;
  try {
    Bun.spawn([...command, url], { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/** Opens a URL with the system's default handler (xdg-open or open). */
export async function openWithDefault(url: string, system: string = platform()): Promise<boolean> {
  const cmd = system === "darwin" ? ["open", url] : ["xdg-open", url];
  return (await runExit(cmd)) === 0;
}

async function runExit(cmd: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return await proc.exited;
  } catch {
    return -1;
  }
}

/** Reads the Exec line of the browser's .desktop file to find how to launch it. */
function linuxLaunchCommand(kind: BrowserKind): string[] | null {
  const home = homedir();
  const dirs = [
    join(home, ".local/share/applications"),
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/var/lib/snapd/desktop/applications",
    "/var/lib/flatpak/exports/share/applications",
    join(home, ".local/share/flatpak/exports/share/applications"),
  ];
  for (const id of kind.desktopIds) {
    for (const dir of dirs) {
      const file = join(dir, id);
      if (!existsSync(file)) continue;
      const exec = readFileSync(file, "utf-8")
        .split("\n")
        .find((line) => line.startsWith("Exec="));
      if (!exec) continue;
      // Drop field codes such as %U and keep the program and its fixed arguments.
      const parts = exec
        .slice("Exec=".length)
        .trim()
        .split(/\s+/)
        .filter((p) => !p.startsWith("%") && !p.startsWith("@@"));
      if (parts.length > 0) return parts;
    }
  }
  return null;
}
