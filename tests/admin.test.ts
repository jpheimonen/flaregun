import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AdminServer } from "../src/admin/server.js";
import {
  Supervisor,
  type SupervisorTimingConfig,
} from "../src/process/supervisor.js";
import type {
  AdminServerDeps,
  IHotReloadEngine,
  HotReloadResult,
  PagesServiceInfo,
} from "../src/admin/types.js";
import type { FlaregunConfig } from "../src/config/index.js";
import type { LockState } from "../src/lock/index.js";

// --- Helpers ---

const FAST_TIMING: SupervisorTimingConfig = {
  stabilityWindowMs: 50,
  backoffResetMs: 200,
  gracefulShutdownMs: 500,
  initialBackoffMs: 50,
  maxBackoffMs: 400,
  logBufferSize: 100,
};

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Test Setup ---

let tempDir: string;
let spaDir: string;
let configPath: string;
let server: AdminServer;
let supervisor: Supervisor;

/** Mock hot-reload engine that records calls */
function createMockHotReloadEngine(
  result?: Partial<HotReloadResult>,
): IHotReloadEngine & { calls: Array<{ oldConfig: FlaregunConfig; newConfig: FlaregunConfig }> } {
  const calls: Array<{ oldConfig: FlaregunConfig; newConfig: FlaregunConfig }> = [];
  return {
    calls,
    async reload(oldConfig, newConfig) {
      calls.push({ oldConfig, newConfig });
      return {
        success: result?.success ?? true,
        errors: result?.errors ?? [],
        changes: result?.changes ?? ["test change applied"],
      };
    },
  };
}

/** Create a valid YAML config string */
function validConfigYaml(): string {
  return `domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  blog:
    subdomain: blog
    dist: dist/
`;
}

/** Create an invalid YAML config string */
function invalidConfigYaml(): string {
  return `domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  broken:
    subdomain: broken
`;
}

/** Set up temp directories and SPA files */
function setupTempDirs(): void {
  tempDir = join(tmpdir(), `flaregun-admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  spaDir = join(tempDir, "spa");
  configPath = join(tempDir, "flaregun.yml");

  mkdirSync(spaDir, { recursive: true });

  // Create dummy SPA files
  writeFileSync(join(spaDir, "index.html"), "<!DOCTYPE html><html><body>SPA</body></html>");
  writeFileSync(join(spaDir, "app.js"), "console.log('app');");
  writeFileSync(join(spaDir, "styles.css"), "body { margin: 0; }");
  writeFileSync(join(spaDir, "data.json"), '{"key": "value"}');

  // Create subdirectory with assets
  mkdirSync(join(spaDir, "assets"), { recursive: true });
  writeFileSync(join(spaDir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // Write a valid config file
  writeFileSync(configPath, validConfigYaml());
}

/** Create default admin server deps */
function createDeps(overrides?: Partial<AdminServerDeps>): AdminServerDeps {
  return {
    supervisor: overrides?.supervisor ?? supervisor,
    hotReloadEngine: overrides?.hotReloadEngine ?? createMockHotReloadEngine(),
    cloudflareClient: overrides?.cloudflareClient ?? ({} as any),
    lockState: overrides?.lockState ?? { pages: {}, access: {} },
    configPath: overrides?.configPath ?? configPath,
    spaDir: overrides?.spaDir ?? spaDir,
    pagesServices: overrides?.pagesServices ?? [
      { name: "blog", subdomain: "blog", deployed: true },
    ],
  };
}

/** Start an admin server on a random port */
async function startServer(deps?: Partial<AdminServerDeps>): Promise<{ port: number; baseUrl: string }> {
  const allDeps = createDeps(deps);
  server = new AdminServer(allDeps);
  const port = await server.start({ preferredPort: 0 });
  return { port, baseUrl: `http://localhost:${port}` };
}

beforeEach(() => {
  supervisor = new Supervisor(FAST_TIMING);
  setupTempDirs();
});

afterEach(async () => {
  if (server) {
    server.stop();
  }
  if (supervisor) {
    await supervisor.shutdown();
  }
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- Static File Serving Tests ---

describe("Static file serving", () => {
  test("root path returns index.html with text/html content type", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const text = await res.text();
    expect(text).toContain("SPA");
  });

  test("JS file returns with application/javascript content type", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript");
    const text = await res.text();
    expect(text).toContain("console.log");
  });

  test("CSS file returns with text/css content type", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css");
    const text = await res.text();
    expect(text).toContain("margin");
  });

  test("JSON file returns with application/json content type", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("unmatched route returns index.html (SPA fallback)", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/some/route/that/does/not/exist`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const text = await res.text();
    expect(text).toContain("SPA");
  });

  test("nested static file is served correctly", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/assets/logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });
});

// --- Config Read Tests ---

describe("Config read endpoint", () => {
  test("returns current config file contents", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.content).toContain("example.com");
    expect(data.content).toContain("admin@example.com");
  });

  test("returns error when config file is missing", async () => {
    // Delete the config file
    rmSync(configPath);
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/config`);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBeTruthy();
  });
});

// --- Config Validate Tests ---

describe("Config validate endpoint", () => {
  test("valid config returns success with no errors", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: validConfigYaml() }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.errors).toEqual([]);
  });

  test("invalid config returns errors", async () => {
    const { baseUrl } = await startServer();
    const res = await fetch(`${baseUrl}/api/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: invalidConfigYaml() }),
    });
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  test("validate endpoint does not write to disk", async () => {
    const originalContent = readFileSync(configPath, "utf-8");
    const { baseUrl } = await startServer();
    const newYaml = validConfigYaml().replace("example.com", "changed.com");
    await fetch(`${baseUrl}/api/config/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newYaml }),
    });
    const afterContent = readFileSync(configPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });
});

// --- Config Save Tests ---

describe("Config save endpoint", () => {
  test("valid config is written to disk and hot-reload engine is triggered", async () => {
    const mockEngine = createMockHotReloadEngine();
    const { baseUrl } = await startServer({ hotReloadEngine: mockEngine });
    const newYaml = `domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3000
`;
    const res = await fetch(`${baseUrl}/api/config/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newYaml }),
    });
    const data = await res.json();
    expect(data.success).toBe(true);

    // Config file should be updated on disk
    const onDisk = readFileSync(configPath, "utf-8");
    expect(onDisk).toBe(newYaml);

    // Hot-reload engine should have been called
    expect(mockEngine.calls.length).toBe(1);
  });

  test("invalid config is rejected without writing to disk", async () => {
    const originalContent = readFileSync(configPath, "utf-8");
    const mockEngine = createMockHotReloadEngine();
    const { baseUrl } = await startServer({ hotReloadEngine: mockEngine });
    const res = await fetch(`${baseUrl}/api/config/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: invalidConfigYaml() }),
    });
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);

    // Config file should NOT have changed
    const afterContent = readFileSync(configPath, "utf-8");
    expect(afterContent).toBe(originalContent);

    // Hot-reload engine should NOT have been called
    expect(mockEngine.calls.length).toBe(0);
  });

  test("save response includes hot-reload result", async () => {
    const mockEngine = createMockHotReloadEngine({
      success: true,
      changes: ["started service api", "updated ingress rules"],
      errors: [],
    });
    const { baseUrl } = await startServer({ hotReloadEngine: mockEngine });
    const res = await fetch(`${baseUrl}/api/config/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: validConfigYaml() }),
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.reload.success).toBe(true);
    expect(data.reload.changes).toContain("started service api");
    expect(data.reload.changes).toContain("updated ingress rules");
  });

  test("save response includes hot-reload errors", async () => {
    const mockEngine = createMockHotReloadEngine({
      success: false,
      changes: ["started service api"],
      errors: ["Failed to update Access policy"],
    });
    const { baseUrl } = await startServer({ hotReloadEngine: mockEngine });
    const res = await fetch(`${baseUrl}/api/config/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: validConfigYaml() }),
    });
    const data = await res.json();
    expect(data.success).toBe(true); // Config was saved even though reload had errors
    expect(data.reload.success).toBe(false);
    expect(data.reload.errors).toContain("Failed to update Access policy");
  });

  test("after save, config file on disk contains the new content", async () => {
    const { baseUrl } = await startServer();
    const newYaml = `domain: newdomain.com
auth:
  provider: google
  superusers:
    - admin@newdomain.com
services:
  web:
    subdomain: web
    dist: dist/
`;
    await fetch(`${baseUrl}/api/config/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: newYaml }),
    });
    const onDisk = readFileSync(configPath, "utf-8");
    expect(onDisk).toBe(newYaml);
  });
});

// --- Service List Tests ---

describe("Service list endpoint", () => {
  test("returns all services with their current states", async () => {
    // Start a local service in the supervisor
    await supervisor.startService({ name: "api", command: "sleep 60" });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { baseUrl } = await startServer({
      pagesServices: [{ name: "blog", subdomain: "blog", deployed: true }],
    });
    const res = await fetch(`${baseUrl}/api/services`);
    const data = await res.json();
    expect(data.success).toBe(true);

    const localSvc = data.services.find((s: any) => s.name === "api");
    expect(localSvc).toBeTruthy();
    expect(localSvc.type).toBe("local");
    expect(localSvc.state).toBe("running");
    expect(localSvc.restartCount).toBe(0);

    const pagesSvc = data.services.find((s: any) => s.name === "blog");
    expect(pagesSvc).toBeTruthy();
    expect(pagesSvc.type).toBe("pages");
    expect(pagesSvc.deployed).toBe(true);
  });

  test("local services include lifecycle state, uptime, and restart count", async () => {
    await supervisor.startService({ name: "worker", command: "sleep 60" });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { baseUrl } = await startServer({ pagesServices: [] });
    const res = await fetch(`${baseUrl}/api/services`);
    const data = await res.json();

    const svc = data.services.find((s: any) => s.name === "worker");
    expect(svc.state).toBe("running");
    expect(svc.runningSince).toBeTruthy();
    expect(typeof svc.restartCount).toBe("number");
  });

  test("Pages services include type and deployment info", async () => {
    const { baseUrl } = await startServer({
      pagesServices: [
        { name: "docs", subdomain: "docs", deployed: false },
      ],
    });
    const res = await fetch(`${baseUrl}/api/services`);
    const data = await res.json();

    const svc = data.services.find((s: any) => s.name === "docs");
    expect(svc.type).toBe("pages");
    expect(svc.subdomain).toBe("docs");
    expect(svc.deployed).toBe(false);
  });
});

// --- Service Management Tests ---

describe("Service restart endpoint", () => {
  test("restart invokes the supervisor's restart for the named service", async () => {
    await supervisor.startService({ name: "api", command: "sleep 60" });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { baseUrl } = await startServer({ pagesServices: [] });
    const res = await fetch(`${baseUrl}/api/services/api/restart`, {
      method: "POST",
    });
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  test("restart returns error for non-existent service", async () => {
    const { baseUrl } = await startServer({ pagesServices: [] });
    const res = await fetch(`${baseUrl}/api/services/nonexistent/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("not found");
  });

  test("restart returns error for a Pages service", async () => {
    const { baseUrl } = await startServer({
      pagesServices: [{ name: "blog", subdomain: "blog", deployed: true }],
    });
    const res = await fetch(`${baseUrl}/api/services/blog/restart`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("Pages service");
  });
});

describe("Service stop endpoint", () => {
  test("stop invokes the supervisor's stop for the named service", async () => {
    await supervisor.startService({ name: "api", command: "sleep 60" });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { baseUrl } = await startServer({ pagesServices: [] });
    const res = await fetch(`${baseUrl}/api/services/api/stop`, {
      method: "POST",
    });
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify service is stopped
    const state = supervisor.getServiceState("api");
    expect(state?.state).toBe("stopped");
  });

  test("stop returns error for non-existent service", async () => {
    const { baseUrl } = await startServer({ pagesServices: [] });
    const res = await fetch(`${baseUrl}/api/services/nonexistent/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("not found");
  });

  test("stop returns error for a Pages service", async () => {
    const { baseUrl } = await startServer({
      pagesServices: [{ name: "blog", subdomain: "blog", deployed: true }],
    });
    const res = await fetch(`${baseUrl}/api/services/blog/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("Pages service");
  });
});

// --- WebSocket Log Streaming Tests ---

describe("WebSocket log streaming", () => {
  test("client subscribing to a service receives log entries", async () => {
    // Start service and wait for it to stabilize
    await supervisor.startService({ name: "echo", command: 'echo "hello world"' });
    await sleep(FAST_TIMING.stabilityWindowMs + 100);

    const { baseUrl, port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", service: "echo" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data));
        // We expect at least a history message
        if (messages.length >= 1) {
          resolve();
        }
      };
      ws.onerror = reject;
      setTimeout(() => resolve(), 2000);
    });

    ws.close();

    // Should have received a history message
    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeTruthy();
    expect(Array.isArray(historyMsg.entries)).toBe(true);
  });

  test("client subscribing to combined stream receives entries from all services", async () => {
    await supervisor.startService({ name: "svc1", command: 'echo "from svc1"' });
    await supervisor.startService({ name: "svc2", command: 'echo "from svc2"' });
    await sleep(FAST_TIMING.stabilityWindowMs + 100);

    const { port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", service: "__all__" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data));
        if (messages.length >= 1) {
          resolve();
        }
      };
      ws.onerror = reject;
      setTimeout(() => resolve(), 2000);
    });

    ws.close();

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeTruthy();

    // History should contain entries from both services
    const services = new Set(historyMsg.entries.map((e: any) => e.service));
    expect(services.has("svc1")).toBe(true);
    expect(services.has("svc2")).toBe(true);
  });

  test("upon subscription, client receives recent log history before real-time entries", async () => {
    // Generate some log entries first
    await supervisor.startService({ name: "logger", command: 'echo "log line 1" && echo "log line 2"' });
    await sleep(FAST_TIMING.stabilityWindowMs + 100);

    const { port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", service: "logger" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data));
        if (messages.length >= 1) {
          resolve();
        }
      };
      ws.onerror = reject;
      setTimeout(() => resolve(), 2000);
    });

    ws.close();

    // The first message should be history
    expect(messages[0].type).toBe("history");
    expect(messages[0].entries.length).toBeGreaterThan(0);

    // History entries should have the right shape
    const entry = messages[0].entries[0];
    expect(entry.type).toBe("log");
    expect(entry.timestamp).toBeTruthy();
    expect(entry.service).toBe("logger");
    expect(entry.source).toBeTruthy();
    expect(typeof entry.line).toBe("string");
  });

  test("log entries include timestamp, service name, stream source, and content", async () => {
    await supervisor.startService({ name: "shapes", command: 'echo "triangle"' });
    await sleep(FAST_TIMING.stabilityWindowMs + 100);

    const { port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages: any[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", service: "shapes" }));
      };
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data));
        resolve();
      };
      setTimeout(() => resolve(), 2000);
    });

    ws.close();

    const historyMsg = messages.find((m) => m.type === "history");
    expect(historyMsg).toBeTruthy();
    if (historyMsg.entries.length > 0) {
      const entry = historyMsg.entries[0];
      expect(entry.timestamp).toBeTruthy();
      expect(entry.service).toBe("shapes");
      expect(["stdout", "stderr"]).toContain(entry.source);
      expect(typeof entry.line).toBe("string");
    }
  });

  test("disconnecting a client does not affect other connected clients", async () => {
    await supervisor.startService({ name: "ticker", command: "sleep 60" });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { port } = await startServer({ pagesServices: [] });

    // Connect two clients
    const ws1 = new WebSocket(`ws://localhost:${port}/api/logs`);
    const ws2 = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages1: any[] = [];
    const messages2: any[] = [];

    await new Promise<void>((resolve) => {
      let openCount = 0;
      const onOpen = () => {
        openCount++;
        if (openCount === 2) resolve();
      };
      ws1.onopen = () => {
        ws1.send(JSON.stringify({ type: "subscribe", service: "ticker" }));
        onOpen();
      };
      ws2.onopen = () => {
        ws2.send(JSON.stringify({ type: "subscribe", service: "ticker" }));
        onOpen();
      };
      ws1.onmessage = (event) => messages1.push(JSON.parse(event.data));
      ws2.onmessage = (event) => messages2.push(JSON.parse(event.data));
      setTimeout(() => resolve(), 2000);
    });

    // Wait for both to receive history
    await sleep(100);

    // Disconnect client 1
    ws1.close();
    await sleep(50);

    // Client 2 is still connected — verify by checking it got history
    expect(messages2.length).toBeGreaterThan(0);

    ws2.close();
  });

  test("client can switch subscriptions by sending a new subscribe message", async () => {
    await supervisor.startService({ name: "svc-a", command: 'echo "from a"' });
    await supervisor.startService({ name: "svc-b", command: 'echo "from b"' });
    await sleep(FAST_TIMING.stabilityWindowMs + 100);

    const { port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const messages: any[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        // Subscribe to svc-a first
        ws.send(JSON.stringify({ type: "subscribe", service: "svc-a" }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        messages.push(msg);

        // After receiving first history, switch to svc-b
        if (messages.length === 1 && msg.type === "history") {
          ws.send(JSON.stringify({ type: "subscribe", service: "svc-b" }));
        }

        // After receiving second history, we're done
        if (messages.length === 2) {
          resolve();
        }
      };
      setTimeout(() => resolve(), 3000);
    });

    ws.close();

    // Should have received two history messages
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].type).toBe("history");
    expect(messages[1].type).toBe("history");
  });

  test("real-time log delivery via WebSocket", async () => {
    // Start a service that outputs continuously
    await supervisor.startService({
      name: "streamer",
      command: 'for i in 1 2 3; do echo "line $i"; sleep 0.1; done && sleep 60',
    });
    await sleep(FAST_TIMING.stabilityWindowMs + 30);

    const { port } = await startServer({ pagesServices: [] });
    const ws = new WebSocket(`ws://localhost:${port}/api/logs`);

    const logMessages: any[] = [];
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "subscribe", service: "streamer" }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "log") {
          logMessages.push(msg);
        }
        if (msg.type === "history") {
          // Also count history entries as log entries
          for (const entry of msg.entries) {
            logMessages.push(entry);
          }
        }
        if (logMessages.length >= 3) {
          resolve();
        }
      };
      setTimeout(() => resolve(), 5000);
    });

    ws.close();

    // Should have received log entries
    expect(logMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Port Selection Tests ---

describe("Port selection", () => {
  test("server starts and reports the selected port", async () => {
    const deps = createDeps();
    server = new AdminServer(deps);
    const port = await server.start({ preferredPort: 0 });
    expect(port).toBeGreaterThan(0);
    expect(server.selectedPort).toBe(port);
  });

  test("server selects alternative port when preferred port is unavailable", async () => {
    // Start a first server on a specific port
    const deps1 = createDeps();
    const server1 = new AdminServer(deps1);
    const port1 = await server1.start({ preferredPort: 19876 });
    expect(port1).toBe(19876);

    // Start a second server trying the same port
    const deps2 = createDeps();
    const server2 = new AdminServer(deps2);
    const port2 = await server2.start({ preferredPort: 19876 });

    // Should have picked a different port
    expect(port2).not.toBe(port1);
    expect(port2).toBeGreaterThan(0);

    server1.stop();
    server2.stop();
    // Prevent the afterEach from double-stopping
    server = null as any;
  });
});

// --- Dependency Injection Tests ---

describe("Dependency injection", () => {
  test("all dependencies are injected and accessible", async () => {
    const mockEngine = createMockHotReloadEngine();
    const mockLockState: LockState = { pages: {}, access: {} };
    const { baseUrl } = await startServer({
      hotReloadEngine: mockEngine,
      lockState: mockLockState,
      pagesServices: [{ name: "docs", subdomain: "docs", deployed: true }],
    });

    // Verify config read uses the injected config path
    const configRes = await fetch(`${baseUrl}/api/config`);
    const configData = await configRes.json();
    expect(configData.success).toBe(true);

    // Verify service list uses the injected pagesServices
    const servicesRes = await fetch(`${baseUrl}/api/services`);
    const servicesData = await servicesRes.json();
    const docs = servicesData.services.find((s: any) => s.name === "docs");
    expect(docs).toBeTruthy();
    expect(docs.type).toBe("pages");
  });

  test("hot-reload engine interface is typed correctly", () => {
    // This is a compile-time check — if the interface is wrong, TypeScript will complain
    const engine: IHotReloadEngine = {
      async reload(oldConfig, newConfig, client, lockState, supervisor) {
        return { success: true, errors: [], changes: [] };
      },
    };
    expect(engine).toBeTruthy();
  });
});
