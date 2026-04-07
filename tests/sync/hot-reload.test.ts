/**
 * Tests for the hot-reload engine (step 013).
 *
 * Uses mock/stub implementations of the process supervisor, sync functions,
 * and lock file manager. Verifies that the engine maps diff categories to the
 * correct actions without actually starting processes or calling Cloudflare APIs.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createMockClient, type MockClientInstance } from "../helpers/mock-client.js";
import { createHotReloadEngine, type HotReloadDeps } from "../../src/sync/hot-reload.js";
import type { IHotReloadEngine, HotReloadResult } from "../../src/admin/types.js";
import type { FlaregunConfig } from "../../src/config/index.js";
import type { LockState } from "../../src/lock/index.js";
import { emptyState } from "../../src/lock/index.js";
import type { CloudflareClient } from "../../src/cloudflare/index.js";

// --- Mock Supervisor ---

interface SupervisorCall {
  method: string;
  args: unknown[];
}

/**
 * Creates a mock supervisor that records all method calls.
 * Simulates the Supervisor API from step 011 without spawning real processes.
 */
function createMockSupervisor() {
  const calls: SupervisorCall[] = [];
  let failOn: Set<string> = new Set();

  return {
    calls,
    failOn,
    setFailOn(methods: string[]) {
      failOn = new Set(methods);
    },
    async startService(config: { name: string; command: string; maxRetries?: number }) {
      calls.push({ method: "startService", args: [config] });
      if (failOn.has("startService")) {
        throw new Error(`Mock startService failure for ${config.name}`);
      }
    },
    async stopService(name: string) {
      calls.push({ method: "stopService", args: [name] });
      if (failOn.has("stopService")) {
        throw new Error(`Mock stopService failure for ${name}`);
      }
    },
    async restartService(name: string) {
      calls.push({ method: "restartService", args: [name] });
      if (failOn.has("restartService")) {
        throw new Error(`Mock restartService failure for ${name}`);
      }
    },
    // Stub methods not used by hot-reload
    getServiceState: () => null,
    getAllServiceStates: () => new Map(),
    getLogBuffer: () => [],
    subscribeToLogs: () => () => {},
    subscribeToAllLogs: () => () => {},
    shutdown: async () => {},
    get isShuttingDown() { return false; },
    get serviceNames() { return []; },
  };
}

// --- Test Helpers ---

/** Base config for testing — a single local service with public auth */
function baseConfig(overrides?: Partial<FlaregunConfig>): FlaregunConfig {
  return {
    domain: "example.com",
    auth: {
      provider: "onetimepin",
      superusers: ["admin@example.com"],
    },
    services: {},
    ...overrides,
  };
}

/** Creates a local service config */
function localService(
  subdomain: string,
  opts?: {
    auth?: FlaregunConfig["services"][string]["auth"];
    command?: string;
    port?: number;
    users?: string[];
    max_retries?: number;
  },
): FlaregunConfig["services"][string] {
  return {
    subdomain,
    type: "local" as const,
    auth: opts?.auth ?? "public",
    command: opts?.command ?? `serve --port ${opts?.port ?? 3000}`,
    port: opts?.port ?? 3000,
    users: opts?.users,
    max_retries: opts?.max_retries,
  };
}

/** Creates a Pages service config */
function pagesService(
  subdomain: string,
  opts?: {
    auth?: FlaregunConfig["services"][string]["auth"];
    users?: string[];
    dist?: string;
    build?: string;
    functions?: string;
    database?: boolean;
    bucket?: boolean;
    kv?: boolean;
  },
): FlaregunConfig["services"][string] {
  return {
    subdomain,
    type: "pages" as const,
    auth: opts?.auth ?? "public",
    dist: opts?.dist ?? "./dist",
    build: opts?.build,
    functions: opts?.functions,
    database: opts?.database,
    bucket: opts?.bucket,
    kv: opts?.kv,
    users: opts?.users,
  };
}

// --- Test Setup ---

let mockClient: MockClientInstance;
let mockSupervisor: ReturnType<typeof createMockSupervisor>;
let lockState: LockState;
let saveLockCalls: LockState[];
let engine: IHotReloadEngine;
let deps: HotReloadDeps;

function setup() {
  mockClient = createMockClient();
  mockSupervisor = createMockSupervisor();
  lockState = emptyState();
  saveLockCalls = [];
  deps = {
    credentials: {
      accountId: "test-account",
      zoneId: "test-zone",
      tunnelId: "test-tunnel",
    },
    saveLock: (state: LockState) => {
      saveLockCalls.push(JSON.parse(JSON.stringify(state)));
    },
    adminPort: 9100,
  };
  engine = createHotReloadEngine(deps);
}

function reload(
  oldConfig: FlaregunConfig,
  newConfig: FlaregunConfig,
): Promise<HotReloadResult> {
  return engine.reload(
    oldConfig,
    newConfig,
    mockClient.client as unknown as CloudflareClient,
    lockState,
    mockSupervisor as any,
  );
}

// --- Tests ---

describe("Hot-reload engine", () => {
  beforeEach(setup);

  // ============================================================
  // No-op test
  // ============================================================

  describe("no-op (identical configs)", () => {
    test("identical configs produce no actions", async () => {
      const config = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });

      const result = await reload(config, config);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.changes).toHaveLength(0);
      expect(mockSupervisor.calls).toHaveLength(0);
      expect(saveLockCalls).toHaveLength(0);
    });
  });

  // ============================================================
  // Service addition tests
  // ============================================================

  describe("service addition", () => {
    test("adding a local service starts it via the process supervisor", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const startCalls = mockSupervisor.calls.filter(
        (c) => c.method === "startService",
      );
      expect(startCalls).toHaveLength(1);
      expect((startCalls[0].args[0] as any).name).toBe("api");
      expect((startCalls[0].args[0] as any).command).toBe("node server.js");
    });

    test("adding a local service with non-public auth creates an Access application and policy", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "admin_only" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Access applications should have been created
      const appCreateCalls = mockClient.getCalls("applications.create");
      expect(appCreateCalls.length).toBeGreaterThan(0);
      // Policy should have been created
      const policyCreateCalls = mockClient.getCalls("policies.create");
      expect(policyCreateCalls.length).toBeGreaterThan(0);
      // Check that the change was reported
      expect(result.changes.some((c) => c.includes("Access application") && c.includes("api"))).toBe(true);
    });

    test("adding a local service updates the tunnel ingress rules", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const ingressCalls = mockClient.getCalls("tunnelConfig.update");
      expect(ingressCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("ingress") && c.includes("api"))).toBe(true);
    });

    test("adding a Pages service with non-public auth creates an Access application and policy", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          blog: pagesService("blog", { auth: "authorized", users: ["user@example.com"] }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const appCreateCalls = mockClient.getCalls("applications.create");
      expect(appCreateCalls.length).toBeGreaterThan(0);
    });

    test("adding a Pages service does not start any process or update ingress rules", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          blog: pagesService("blog"),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // No supervisor calls
      expect(mockSupervisor.calls).toHaveLength(0);
      // No ingress update
      const ingressCalls = mockClient.getCalls("tunnelConfig.update");
      expect(ingressCalls).toHaveLength(0);
    });
  });

  // ============================================================
  // Service removal tests
  // ============================================================

  describe("service removal", () => {
    test("removing a local service stops it via the process supervisor", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });
      const newConfig = baseConfig({ services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const stopCalls = mockSupervisor.calls.filter(
        (c) => c.method === "stopService",
      );
      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0].args[0]).toBe("api");
    });

    test("removing a service with an Access application deletes the application and policy", async () => {
      // Set up lock state as if the service had an Access app
      lockState.access["api"] = { app_id: "existing-app-id" };
      // Pre-populate mock client state
      mockClient.setApps([
        { id: "existing-app-id", name: "api", domain: "api.example.com", type: "self_hosted" },
      ]);

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "admin_only" }),
        },
      });
      const newConfig = baseConfig({ services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Access app should have been deleted
      const deleteCalls = mockClient.getCalls("applications.delete");
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("Access application") && c.includes("api"))).toBe(true);
    });

    test("removing a local service updates the tunnel ingress rules", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });
      const newConfig = baseConfig({ services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const ingressCalls = mockClient.getCalls("tunnelConfig.update");
      expect(ingressCalls.length).toBeGreaterThan(0);
    });

    test("removing a Pages service does not stop any process", async () => {
      const oldConfig = baseConfig({
        services: {
          blog: pagesService("blog"),
        },
      });
      const newConfig = baseConfig({ services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // No supervisor calls (no stop)
      expect(mockSupervisor.calls).toHaveLength(0);
    });
  });

  // ============================================================
  // Service modification tests
  // ============================================================

  describe("service modification", () => {
    test("changing a service's port restarts the service and updates ingress rules", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 4000, command: "node server.js" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Should stop then start (restart)
      const stopCalls = mockSupervisor.calls.filter((c) => c.method === "stopService");
      const startCalls = mockSupervisor.calls.filter((c) => c.method === "startService");
      expect(stopCalls).toHaveLength(1);
      expect(startCalls).toHaveLength(1);
      // Ingress should be updated
      const ingressCalls = mockClient.getCalls("tunnelConfig.update");
      expect(ingressCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("port changed"))).toBe(true);
    });

    test("changing a service's command restarts the service with the new command", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "bun server.ts" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Should stop then start
      const stopCalls = mockSupervisor.calls.filter((c) => c.method === "stopService");
      const startCalls = mockSupervisor.calls.filter((c) => c.method === "startService");
      expect(stopCalls).toHaveLength(1);
      expect(startCalls).toHaveLength(1);
      // The new command should be passed
      expect((startCalls[0].args[0] as any).command).toBe("bun server.ts");
      expect(result.changes.some((c) => c.includes("command changed"))).toBe(true);
    });

    test("changing auth from public to authorized creates an Access application and policy", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "public" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "authorized", users: ["user@example.com"] }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      const appCreateCalls = mockClient.getCalls("applications.create");
      expect(appCreateCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("public to authorized"))).toBe(true);
    });

    test("changing auth from authorized to public deletes the Access application and policy", async () => {
      // Set up existing access entry
      lockState.access["api"] = { app_id: "existing-app-id" };
      mockClient.setApps([
        { id: "existing-app-id", name: "api", domain: "api.example.com", type: "self_hosted" },
      ]);

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "authorized", users: ["user@example.com"] }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "public" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // The access sync should delete the app since it's now public
      const deleteCalls = mockClient.getCalls("applications.delete");
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("authorized to public"))).toBe(true);
    });

    test("changing auth between admin_only and authorized updates the Access policy selectors", async () => {
      // Set up existing access entry
      lockState.access["api"] = { app_id: "existing-app-id" };
      mockClient.setApps([
        { id: "existing-app-id", name: "api", domain: "api.example.com", type: "self_hosted" },
      ]);
      mockClient.setPolicies({
        "existing-app-id": [
          { id: "policy-1", name: "api", decision: "allow", include: [] },
        ],
      });

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "admin_only" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "authorized", users: ["user@example.com"] }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Policy should have been updated (not created/deleted)
      const policyUpdateCalls = mockClient.getCalls("policies.update");
      expect(policyUpdateCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("admin_only to authorized"))).toBe(true);
    });

    test("changing the users list on an authorized service updates the Access policy", async () => {
      lockState.access["api"] = { app_id: "existing-app-id" };
      mockClient.setApps([
        { id: "existing-app-id", name: "api", domain: "api.example.com", type: "self_hosted" },
      ]);
      mockClient.setPolicies({
        "existing-app-id": [
          { id: "policy-1", name: "api", decision: "allow", include: [] },
        ],
      });

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "authorized", users: ["user@example.com"] }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "authorized", users: ["user@example.com", "new@example.com"] }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Policy should have been updated with new users
      const policyUpdateCalls = mockClient.getCalls("policies.update");
      expect(policyUpdateCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("users list changed"))).toBe(true);
    });

    test("changing max_retries updates the supervisor configuration without restarting", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js", max_retries: 3 }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js", max_retries: 5 }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // No restart — no stop/start/restart calls
      const restartCalls = mockSupervisor.calls.filter(
        (c) => c.method === "restartService" || c.method === "stopService" || c.method === "startService",
      );
      expect(restartCalls).toHaveLength(0);
      expect(result.changes.some((c) => c.includes("max_retries"))).toBe(true);
    });
  });

  // ============================================================
  // Global auth change tests
  // ============================================================

  describe("global auth changes", () => {
    test("changing global superusers updates all non-public Access policies", async () => {
      // Set up existing access entries
      lockState.access["api"] = { app_id: "app-api" };
      lockState.access["dashboard"] = { app_id: "app-dashboard" };
      mockClient.setApps([
        { id: "app-api", name: "api", domain: "api.example.com", type: "self_hosted" },
        { id: "app-dashboard", name: "dashboard", domain: "dashboard.example.com", type: "self_hosted" },
      ]);
      mockClient.setPolicies({
        "app-api": [{ id: "p1", name: "api", decision: "allow", include: [] }],
        "app-dashboard": [{ id: "p2", name: "dashboard", decision: "allow", include: [] }],
      });

      const oldConfig = baseConfig({
        auth: { provider: "onetimepin", superusers: ["admin@example.com"] },
        services: {
          api: localService("api", { auth: "admin_only" }),
          dashboard: localService("dashboard", { auth: "authorized", users: ["user@example.com"], port: 3001 }),
        },
      });
      const newConfig = baseConfig({
        auth: { provider: "onetimepin", superusers: ["admin@example.com", "newadmin@example.com"] },
        services: {
          api: localService("api", { auth: "admin_only" }),
          dashboard: localService("dashboard", { auth: "authorized", users: ["user@example.com"], port: 3001 }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Access policies should have been synced (update calls for all non-public services)
      const policyCalls = [
        ...mockClient.getCalls("policies.create"),
        ...mockClient.getCalls("policies.update"),
      ];
      expect(policyCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("superuser"))).toBe(true);
    });

    test("changing the identity provider logs a note but takes no programmatic action", async () => {
      const oldConfig = baseConfig({
        auth: { provider: "onetimepin", superusers: ["admin@example.com"] },
        services: {},
      });
      const newConfig = baseConfig({
        auth: { provider: "google", superusers: ["admin@example.com"] },
        services: {},
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      expect(result.changes.some((c) => c.includes("Identity provider changed"))).toBe(true);
      expect(result.changes.some((c) => c.includes("portal manually"))).toBe(true);
    });
  });

  // ============================================================
  // Pages-only change tests
  // ============================================================

  describe("Pages-only field changes", () => {
    test("changes to dist, build, functions do not trigger any runtime actions", async () => {
      const oldConfig = baseConfig({
        services: {
          blog: pagesService("blog", { dist: "./dist", build: "npm run build" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          blog: pagesService("blog", { dist: "./output", build: "bun build" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // No supervisor calls, no Cloudflare calls
      expect(mockSupervisor.calls).toHaveLength(0);
      expect(mockClient.getCalls("tunnelConfig.update")).toHaveLength(0);
      expect(mockClient.getCalls("applications.create")).toHaveLength(0);
      expect(saveLockCalls).toHaveLength(0);
      expect(result.changes.some((c) => c.includes("Pages-only"))).toBe(true);
    });

    test("changes to database, bucket, kv do not trigger runtime actions", async () => {
      const oldConfig = baseConfig({
        services: {
          blog: pagesService("blog", { database: false, bucket: false, kv: false }),
        },
      });
      const newConfig = baseConfig({
        services: {
          blog: pagesService("blog", { database: true, bucket: true, kv: true }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      expect(mockSupervisor.calls).toHaveLength(0);
      expect(saveLockCalls).toHaveLength(0);
    });

    test("a service with both runtime changes and Pages-only changes applies only the runtime actions", async () => {
      // A Pages service with auth change + dist change
      const oldConfig = baseConfig({
        services: {
          blog: pagesService("blog", { auth: "public", dist: "./dist" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          blog: pagesService("blog", { auth: "admin_only", dist: "./output" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Should have created Access app (runtime change)
      const appCreateCalls = mockClient.getCalls("applications.create");
      expect(appCreateCalls.length).toBeGreaterThan(0);
      // Should note Pages-only changes were skipped
      expect(result.changes.some((c) => c.includes("Pages-only"))).toBe(true);
    });
  });

  // ============================================================
  // Domain change test
  // ============================================================

  describe("domain change", () => {
    test("changing the domain returns an error (requires full restart)", async () => {
      const oldConfig = baseConfig({ domain: "old.example.com", services: {} });
      const newConfig = baseConfig({ domain: "new.example.com", services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Domain change");
      expect(result.errors[0]).toContain("cannot change domain via hot-reload");
      expect(result.changes).toHaveLength(0);
    });
  });

  // ============================================================
  // Error handling tests
  // ============================================================

  describe("error handling and resilience", () => {
    test("a failure in one action does not prevent other actions from being applied", async () => {
      // Set the supervisor to fail on startService
      mockSupervisor.setFailOn(["startService"]);

      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
          web: localService("web", { port: 4000, command: "serve web" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      // Both services were attempted
      const startCalls = mockSupervisor.calls.filter((c) => c.method === "startService");
      expect(startCalls).toHaveLength(2);
      // But both failed
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Ingress updates should still have been attempted
      const ingressCalls = mockClient.getCalls("tunnelConfig.update");
      expect(ingressCalls.length).toBeGreaterThan(0);
    });

    test("the result includes both successful and failed actions", async () => {
      // Add two services — one local (will succeed) and one local with auth (access might fail)
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, auth: "public" }),
        },
      });
      // Change port (succeeds) and add another service
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 4000, auth: "public" }),
          web: localService("web", { port: 5000 }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      // Should have changes reported
      expect(result.changes.length).toBeGreaterThan(0);
    });

    test("a hot-reload failure does not crash or stop the running system", async () => {
      // Set supervisor to fail on everything
      mockSupervisor.setFailOn(["startService", "stopService", "restartService"]);

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 4000 }),
          web: localService("web", { port: 5000 }),
        },
      });

      // The reload should not throw — errors are captured in the result
      const result = await reload(oldConfig, newConfig);

      expect(result).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
      // The function returned normally — did not throw/crash
      expect(typeof result.success).toBe("boolean");
    });
  });

  // ============================================================
  // Lock file tests
  // ============================================================

  describe("lock file management", () => {
    test("the lock file is saved after Cloudflare resources are modified (Access apps created)", async () => {
      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { auth: "admin_only" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Lock file should have been saved
      expect(saveLockCalls.length).toBeGreaterThan(0);
      expect(result.changes.some((c) => c.includes("lock file"))).toBe(true);
    });

    test("the lock file is saved after Access apps are deleted", async () => {
      lockState.access["api"] = { app_id: "existing-app-id" };
      mockClient.setApps([
        { id: "existing-app-id", name: "api", domain: "api.example.com", type: "self_hosted" },
      ]);

      const oldConfig = baseConfig({
        services: {
          api: localService("api", { auth: "admin_only" }),
        },
      });
      const newConfig = baseConfig({ services: {} });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      expect(saveLockCalls.length).toBeGreaterThan(0);
    });

    test("the lock file is not saved if no Cloudflare resources were modified (local restart only)", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "bun server.ts" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // No lock file save — only a local process restart
      expect(saveLockCalls).toHaveLength(0);
    });

    test("the lock file is saved after successful Cloudflare mutations even if other actions failed", async () => {
      // Supervisor fails but Access sync succeeds
      mockSupervisor.setFailOn(["startService"]);

      const oldConfig = baseConfig({ services: {} });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, auth: "admin_only" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      // Start failed but Access sync succeeded
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Lock file should still be saved (Cloudflare resources were modified)
      expect(saveLockCalls.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Mixed scenario tests
  // ============================================================

  describe("mixed scenarios", () => {
    test("adding and removing services simultaneously applies all actions", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000 }),
        },
      });
      const newConfig = baseConfig({
        services: {
          web: localService("web", { port: 4000 }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Should have stopped api and started web
      const stopCalls = mockSupervisor.calls.filter((c) => c.method === "stopService");
      const startCalls = mockSupervisor.calls.filter((c) => c.method === "startService");
      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0].args[0]).toBe("api");
      expect(startCalls).toHaveLength(1);
      expect((startCalls[0].args[0] as any).name).toBe("web");
    });

    test("port change with command change restarts service once", async () => {
      const oldConfig = baseConfig({
        services: {
          api: localService("api", { port: 3000, command: "node server.js" }),
        },
      });
      const newConfig = baseConfig({
        services: {
          api: localService("api", { port: 4000, command: "bun server.ts" }),
        },
      });

      const result = await reload(oldConfig, newConfig);

      expect(result.success).toBe(true);
      // Should restart once, not twice
      const stopCalls = mockSupervisor.calls.filter((c) => c.method === "stopService");
      const startCalls = mockSupervisor.calls.filter((c) => c.method === "startService");
      expect(stopCalls).toHaveLength(1);
      expect(startCalls).toHaveLength(1);
      expect(result.changes.some((c) => c.includes("port and command changed"))).toBe(true);
    });
  });
});
