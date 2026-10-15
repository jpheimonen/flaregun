/**
 * `flaregun expose <port> [subdomain]`: the shortest way to a tunnel.
 *
 * Adds the port to flaregun.yml and makes it reachable at
 * https://<subdomain>.<domain>. Runs setup first when the folder isn't set up
 * yet. If `flaregun up` is already running, the running instance picks the
 * change up; otherwise this starts `up` in the foreground.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parseConfig, type FlaregunConfig } from "../config/index.js";
import {
  handleUp,
  isProcessRunning,
  readAdminPort,
  readPidFile,
  type CommandResult,
} from "../orchestrate/index.js";
import { handleSetup, type SetupResult } from "../setup/index.js";

export interface ExposeRequest {
  port: number;
  /** Defaults to the port number, e.g. https://3000.example.com */
  subdomain?: string;
  /** Skip Cloudflare Access so anyone can open it. */
  public?: boolean;
  /** Let setup drive the browser if setup has to run. */
  useBrowser?: boolean;
}

export interface ExposeDeps {
  cwd: string;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  setup: (cwd: string, useBrowser: boolean) => Promise<SetupResult>;
  up: (configPath: string) => Promise<CommandResult>;
  /** Sends new config text to a running `up` on its admin port. */
  pushToRunningUp: (adminPort: number, content: string) => Promise<void>;
  /** Returns the admin port of a running `up`, or null when none runs. */
  runningAdminPort: (pidPath: string) => number | null;
}

const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Parses `expose` arguments: `<port> [subdomain] [--public] [--no-browser]`. */
export function parseExposeArgs(args: string[]): ExposeRequest | { error: string } {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  for (const flag of flags) {
    if (flag !== "--public" && flag !== "--no-browser") {
      return { error: `Unknown option ${flag}` };
    }
  }
  const [portText, subdomain, ...extra] = positional;
  if (!portText) return { error: "Tell flaregun which port to expose, e.g. flaregun expose 3000" };
  if (extra.length > 0) return { error: `Unexpected argument "${extra[0]}"` };

  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `"${portText}" isn't a port number` };
  }
  if (subdomain !== undefined && !SUBDOMAIN.test(subdomain)) {
    return { error: `"${subdomain}" isn't a valid subdomain (use lowercase letters, digits and dashes)` };
  }
  return {
    port,
    subdomain,
    public: flags.has("--public"),
    useBrowser: !flags.has("--no-browser"),
  };
}

export type AddServiceResult =
  | { status: "added"; content: string; name: string }
  | { status: "unchanged"; name: string }
  | { status: "conflict"; message: string };

/**
 * Adds a port-only service to flaregun.yml text, keeping the person's comments
 * and layout. The service is named after its subdomain.
 */
export function addServiceToConfig(
  content: string,
  service: { subdomain: string; port: number; public: boolean },
): AddServiceResult {
  const config = parseConfig(content);
  const name = service.subdomain;

  for (const [existingName, existing] of Object.entries(config.services)) {
    if (existing.subdomain === service.subdomain || existingName === name) {
      if (existing.port === service.port && existing.subdomain === service.subdomain) {
        return { status: "unchanged", name: existingName };
      }
      const what =
        existing.type === "pages" ? "a Pages site" : `localhost:${existing.port}`;
      return {
        status: "conflict",
        message: `${service.subdomain}.${config.domain} already points at ${what} (service "${existingName}"). Pick another subdomain: flaregun expose ${service.port} <subdomain>`,
      };
    }
    if (existing.type === "local" && existing.port === service.port) {
      return {
        status: "conflict",
        message: `Port ${service.port} is already exposed as https://${existing.subdomain}.${config.domain} (service "${existingName}").`,
      };
    }
  }

  const lines = content.replace(/\n*$/, "").split("\n");
  const servicesLine = lines.findIndex((line) => /^services:\s*(\{\s*\})?\s*(#.*)?$/.test(line));

  let insertAt: number;
  let indent = "  ";
  if (servicesLine === -1) {
    lines.push("", "services:");
    insertAt = lines.length;
  } else {
    lines[servicesLine] = lines[servicesLine].replace(/\{\s*\}/, "").trimEnd();
    // Match the indentation of the existing entries, if any.
    const first = lines.slice(servicesLine + 1).find((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
    indent = first?.match(/^(\s+)/)?.[1] ?? "  ";
    // The services block ends at the next top-level key.
    const next = lines.findIndex((l, i) => i > servicesLine && /^[^\s#]/.test(l));
    insertAt = next === -1 ? lines.length : next;
    // Keep blank lines and comments that precede the next top-level key with it.
    while (insertAt > servicesLine + 1 && /^\s*(#.*)?$/.test(lines[insertAt - 1]) && insertAt < lines.length) {
      insertAt--;
    }
  }

  const key = /^\d+$/.test(name) ? `"${name}"` : name;
  const block = [
    `${indent}${key}:`,
    `${indent}${indent}subdomain: "${service.subdomain}"`,
    `${indent}${indent}port: ${service.port}`,
    ...(service.public ? [`${indent}${indent}auth: public`] : []),
  ];
  lines.splice(insertAt, 0, ...block);
  const updated = lines.join("\n") + "\n";

  parseConfig(updated); // must still be valid
  return { status: "added", content: updated, name };
}

/** POSTs the new config to a running `up`, which re-syncs Cloudflare. */
async function pushToRunningUp(adminPort: number, content: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${adminPort}/api/config/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    reload?: { success?: boolean; errors?: string[] };
  };
  if (!response.ok || !body.success) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (body.reload && body.reload.success === false) {
    throw new Error((body.reload.errors ?? []).join("; ") || "reload failed");
  }
}

function runningAdminPort(pidPath: string): number | null {
  const pid = readPidFile(pidPath);
  if (pid === null || !isProcessRunning(pid)) return null;
  return readAdminPort(pidPath);
}

const DEFAULT_DEPS: ExposeDeps = {
  cwd: process.cwd(),
  stdout: console.log,
  stderr: console.error,
  setup: (cwd, useBrowser) => handleSetup({ cwd, useBrowser }),
  up: (configPath) => handleUp(configPath),
  pushToRunningUp,
  runningAdminPort,
};

export async function handleExpose(
  request: ExposeRequest,
  overrides: Partial<ExposeDeps> = {},
): Promise<CommandResult> {
  const deps: ExposeDeps = { ...DEFAULT_DEPS, ...overrides };
  const { stdout, stderr } = deps;
  const configPath = resolve(deps.cwd, "flaregun.yml");
  const pidPath = resolve(deps.cwd, ".flaregun.pid");

  if (!existsSync(configPath)) {
    stdout("This folder isn't set up yet, so flaregun runs setup first.");
    const setup = await deps.setup(deps.cwd, request.useBrowser ?? true);
    if (!setup.success) return { success: false, error: "setup failed" };
  }

  let config: FlaregunConfig;
  let result: AddServiceResult;
  try {
    const content = readFileSync(configPath, "utf-8");
    config = parseConfig(content);
    result = addServiceToConfig(content, {
      subdomain: request.subdomain ?? String(request.port),
      port: request.port,
      public: request.public ?? false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`Config error: ${msg}`);
    return { success: false, error: msg };
  }

  if (result.status === "conflict") {
    stderr(result.message);
    return { success: false, error: result.message };
  }

  const exposed = parseConfig(result.status === "added" ? result.content : readFileSync(configPath, "utf-8"))
    .services[result.name];
  const url = `https://${exposed.subdomain}.${config.domain}`;
  const access = exposed.auth === "public" ? "anyone can open it" : "login required";

  if (result.status === "added") {
    writeFileSync(configPath, result.content, "utf-8");
    stdout(`✓ Added to flaregun.yml: ${url} → localhost:${request.port} (${access})`);
  } else {
    stdout(`${url} already points at localhost:${request.port}.`);
  }

  const adminPort = deps.runningAdminPort(pidPath);
  if (adminPort) {
    try {
      await deps.pushToRunningUp(adminPort, readFileSync(configPath, "utf-8"));
      stdout(`✓ Live now at ${url} (the running flaregun up picked it up)`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr(`The running flaregun up couldn't apply the change: ${msg}`);
      stderr("Restart it with: flaregun down && flaregun up");
      return { success: false, error: msg };
    }
  }

  stdout("Starting flaregun up…");
  return deps.up(configPath);
}
