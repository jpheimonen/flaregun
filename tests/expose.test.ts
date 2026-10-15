import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseConfig } from "../src/config/index.js";
import {
  addServiceToConfig,
  handleExpose,
  parseExposeArgs,
  type ExposeDeps,
} from "../src/expose/index.js";
import { generateConfigContent } from "../src/setup/index.js";

const STARTER = generateConfigContent({
  domain: "example.com",
  provider: "onetimepin",
  superusers: ["me@example.com"],
});

describe("parseExposeArgs", () => {
  test("reads port, subdomain and flags", () => {
    expect(parseExposeArgs(["3000"])).toEqual({ port: 3000, subdomain: undefined, public: false, useBrowser: true });
    expect(parseExposeArgs(["8080", "grafana", "--public", "--no-browser"])).toEqual({
      port: 8080,
      subdomain: "grafana",
      public: true,
      useBrowser: false,
    });
  });

  test("explains bad input", () => {
    expect(parseExposeArgs([])).toEqual({ error: expect.stringContaining("which port") });
    expect(parseExposeArgs(["http"])).toEqual({ error: expect.stringContaining("isn't a port") });
    expect(parseExposeArgs(["70000"])).toEqual({ error: expect.stringContaining("isn't a port") });
    expect(parseExposeArgs(["3000", "Bad_Name"])).toEqual({ error: expect.stringContaining("valid subdomain") });
    expect(parseExposeArgs(["3000", "--open"])).toEqual({ error: "Unknown option --open" });
    expect(parseExposeArgs(["3000", "a", "b"])).toEqual({ error: 'Unexpected argument "b"' });
  });
});

describe("addServiceToConfig", () => {
  test("adds a port-only service to the starter config and keeps its comments", () => {
    const result = addServiceToConfig(STARTER, { subdomain: "3000", port: 3000, public: false });
    expect(result.status).toBe("added");
    if (result.status !== "added") return;

    expect(result.content).toContain("# Add one quickly with: flaregun expose <port> [subdomain]");
    const config = parseConfig(result.content);
    expect(config.services["3000"]).toMatchObject({ subdomain: "3000", port: 3000, type: "local", auth: "admin_only" });
    expect(config.services["3000"].command).toBeUndefined();
  });

  test("adds next to existing services, before later top-level keys, matching indentation", () => {
    const content = `domain: example.com
auth:
  provider: onetimepin
  superusers: [me@example.com]
services:
    api:
        subdomain: api
        port: 4000
        command: bun run api.ts

# the down page
down_page: ./down.html
`;
    const result = addServiceToConfig(content, { subdomain: "demo", port: 5173, public: true });
    expect(result.status).toBe("added");
    if (result.status !== "added") return;

    expect(result.content).toContain(`    demo:
        subdomain: "demo"
        port: 5173
        auth: public

# the down page
down_page: ./down.html`);
    const config = parseConfig(result.content);
    expect(Object.keys(config.services)).toEqual(["api", "demo"]);
    expect(config.down_page).toBe("./down.html");
  });

  test("adds a services section when there is none", () => {
    const content = "domain: example.com\nauth:\n  provider: onetimepin\n  superusers: [me@example.com]\n";
    const result = addServiceToConfig(content, { subdomain: "app", port: 3000, public: false });
    expect(result.status).toBe("added");
    if (result.status === "added") {
      expect(parseConfig(result.content).services.app.port).toBe(3000);
    }
  });

  test("exposing the same port on the same subdomain again changes nothing", () => {
    const first = addServiceToConfig(STARTER, { subdomain: "app", port: 3000, public: false });
    if (first.status !== "added") throw new Error("expected added");
    expect(addServiceToConfig(first.content, { subdomain: "app", port: 3000, public: false })).toEqual({
      status: "unchanged",
      name: "app",
    });
  });

  test("refuses to reuse a subdomain or a port that's already exposed", () => {
    const first = addServiceToConfig(STARTER, { subdomain: "app", port: 3000, public: false });
    if (first.status !== "added") throw new Error("expected added");

    const sameSubdomain = addServiceToConfig(first.content, { subdomain: "app", port: 4000, public: false });
    expect(sameSubdomain.status).toBe("conflict");
    if (sameSubdomain.status === "conflict") expect(sameSubdomain.message).toContain("already points at localhost:3000");

    const samePort = addServiceToConfig(first.content, { subdomain: "other", port: 3000, public: false });
    expect(samePort.status).toBe("conflict");
    if (samePort.status === "conflict") expect(samePort.message).toContain("https://app.example.com");
  });
});

describe("handleExpose", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "flaregun-expose-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function deps(overrides: Partial<ExposeDeps> = {}) {
    const record = { setupRuns: 0, upRuns: [] as string[], pushed: [] as Array<[number, string]>, out: [] as string[] };
    const all: ExposeDeps = {
      cwd,
      stdout: (m) => record.out.push(m),
      stderr: (m) => record.out.push(m),
      setup: async () => {
        record.setupRuns++;
        writeFileSync(join(cwd, "flaregun.yml"), STARTER);
        return { success: true, domain: "example.com" };
      },
      up: async (configPath) => {
        record.upRuns.push(configPath);
        return { success: true };
      },
      pushToRunningUp: async (port, content) => {
        record.pushed.push([port, content]);
      },
      runningAdminPort: () => null,
      ...overrides,
    };
    return { all, record };
  }

  test("in a fresh folder: runs setup, adds the port and starts up", async () => {
    const { all, record } = deps();
    const result = await handleExpose({ port: 3000 }, all);

    expect(result.success).toBe(true);
    expect(record.setupRuns).toBe(1);
    expect(record.upRuns).toEqual([join(cwd, "flaregun.yml")]);
    expect(record.out.join("\n")).toContain("https://3000.example.com → localhost:3000 (login required)");
    expect(parseConfig(readFileSync(join(cwd, "flaregun.yml"), "utf-8")).services["3000"].port).toBe(3000);
  });

  test("hands the change to a running up instead of starting another", async () => {
    writeFileSync(join(cwd, "flaregun.yml"), STARTER);
    const { all, record } = deps({ runningAdminPort: () => 9101 });

    const result = await handleExpose({ port: 8080, subdomain: "grafana", public: true }, all);

    expect(result.success).toBe(true);
    expect(record.setupRuns).toBe(0);
    expect(record.upRuns).toEqual([]);
    expect(record.pushed[0][0]).toBe(9101);
    expect(record.pushed[0][1]).toContain("grafana:");
    expect(record.out.join("\n")).toContain("Live now at https://grafana.example.com");
  });

  test("stops when setup fails", async () => {
    const { all, record } = deps({ setup: async () => ({ success: false }) });
    const result = await handleExpose({ port: 3000 }, all);
    expect(result.success).toBe(false);
    expect(record.upRuns).toEqual([]);
    expect(existsSync(join(cwd, "flaregun.yml"))).toBe(false);
  });

  test("a conflict leaves the config untouched", async () => {
    const first = addServiceToConfig(STARTER, { subdomain: "app", port: 3000, public: false });
    if (first.status !== "added") throw new Error("expected added");
    writeFileSync(join(cwd, "flaregun.yml"), first.content);
    const { all, record } = deps();

    const result = await handleExpose({ port: 4000, subdomain: "app" }, all);

    expect(result.success).toBe(false);
    expect(readFileSync(join(cwd, "flaregun.yml"), "utf-8")).toBe(first.content);
    expect(record.upRuns).toEqual([]);
  });

  test("reports when the running up can't apply the change", async () => {
    writeFileSync(join(cwd, "flaregun.yml"), STARTER);
    const { all, record } = deps({
      runningAdminPort: () => 9100,
      pushToRunningUp: async () => {
        throw new Error("Access sync failed");
      },
    });
    const result = await handleExpose({ port: 3000 }, all);
    expect(result.success).toBe(false);
    expect(record.out.join("\n")).toContain("flaregun down && flaregun up");
  });
});
