import { describe, test, expect } from "bun:test";
import { createMockClient } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ACCOUNT_ID,
  TEST_TUNNEL_ID,
} from "../helpers/fixtures.js";
import { syncTunnelIngress } from "../../src/sync/ingress.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Constants ---

const ADMIN_PORT = 9000;

// --- Test helpers ---

/** Runs tunnel ingress sync against a mock client. */
async function runIngressSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
) {
  return syncTunnelIngress(
    mockClient.client as unknown as Parameters<typeof syncTunnelIngress>[0],
    config,
    TEST_ACCOUNT_ID,
    TEST_TUNNEL_ID,
    ADMIN_PORT,
  );
}

/** Extracts the ingress array from the last tunnelConfig.update call. */
function getLastIngress(mockClient: ReturnType<typeof createMockClient>) {
  const calls = mockClient.getCalls("tunnelConfig.update");
  expect(calls.length).toBeGreaterThan(0);
  const lastCall = calls[calls.length - 1];
  const params = lastCall[1] as { config: { ingress: Array<{ hostname: string; service: string }> } };
  return params.config.ingress;
}

// --- Tests ---

describe("syncTunnelIngress", () => {
  test("pushes ingress rules for all local services plus catch-all 404", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        api: localService("api", 3000),
        worker: localService("worker", 4000),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    // 2 local services + 1 admin + 1 catch-all = 4
    expect(ingress.length).toBe(4);

    // Check services are present (sorted alphabetically)
    expect(ingress[0].hostname).toBe("admin.example.com");
    expect(ingress[0].service).toBe(`http://localhost:${ADMIN_PORT}`);

    expect(ingress[1].hostname).toBe("api.example.com");
    expect(ingress[1].service).toBe("http://localhost:3000");

    expect(ingress[2].hostname).toBe("worker.example.com");
    expect(ingress[2].service).toBe("http://localhost:4000");

    // Catch-all is last
    expect(ingress[3].hostname).toBe("");
    expect(ingress[3].service).toBe("http_status:404");
  });

  test("ingress rules are sorted alphabetically by hostname", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        zebra: localService("zebra", 5000),
        alpha: localService("alpha", 6000),
        middle: localService("middle", 7000),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    const hostnames = ingress.slice(0, -1).map((r) => r.hostname);
    const sorted = [...hostnames].sort();
    expect(hostnames).toEqual(sorted);
  });

  test("the admin UI produces an implicit ingress rule for admin.domain", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        api: localService("api", 3000),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    const adminRule = ingress.find((r) => r.hostname === "admin.example.com");
    expect(adminRule).toBeDefined();
    expect(adminRule!.service).toBe(`http://localhost:${ADMIN_PORT}`);
  });

  test("Pages services do not appear in the ingress rules", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog"),
        api: localService("api", 3000),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    const blogRule = ingress.find((r) => r.hostname === "blog.example.com");
    expect(blogRule).toBeUndefined();

    // api and admin should be present
    const apiRule = ingress.find((r) => r.hostname === "api.example.com");
    expect(apiRule).toBeDefined();
    const adminRule = ingress.find((r) => r.hostname === "admin.example.com");
    expect(adminRule).toBeDefined();
  });

  test("changed ports produce updated ingress configuration", async () => {
    const mockClient = createMockClient();

    // First sync with port 3000
    const config1 = makeConfig({
      services: { api: localService("api", 3000) },
    });
    await runIngressSync(mockClient, config1);
    const ingress1 = getLastIngress(mockClient);
    const apiRule1 = ingress1.find((r) => r.hostname === "api.example.com");
    expect(apiRule1!.service).toBe("http://localhost:3000");

    // Second sync with port 4000
    const config2 = makeConfig({
      services: { api: localService("api", 4000) },
    });
    await runIngressSync(mockClient, config2);
    const ingress2 = getLastIngress(mockClient);
    const apiRule2 = ingress2.find((r) => r.hostname === "api.example.com");
    expect(apiRule2!.service).toBe("http://localhost:4000");
  });

  test("removing a local service from config results in its rule being absent", async () => {
    const mockClient = createMockClient();

    // First sync with two services
    const config1 = makeConfig({
      services: {
        api: localService("api", 3000),
        worker: localService("worker", 4000),
      },
    });
    await runIngressSync(mockClient, config1);
    const ingress1 = getLastIngress(mockClient);
    expect(ingress1.some((r) => r.hostname === "worker.example.com")).toBe(true);

    // Second sync without 'worker'
    const config2 = makeConfig({
      services: { api: localService("api", 3000) },
    });
    await runIngressSync(mockClient, config2);
    const ingress2 = getLastIngress(mockClient);
    expect(ingress2.some((r) => r.hostname === "worker.example.com")).toBe(false);
  });

  test("the catch-all 404 is always the last rule", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        api: localService("api", 3000),
        blog: pagesService("blog"),
        worker: localService("worker", 4000),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    const lastRule = ingress[ingress.length - 1];
    expect(lastRule.hostname).toBe("");
    expect(lastRule.service).toBe("http_status:404");
  });

  test("the entire ingress configuration is pushed as a full replacement", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { api: localService("api", 3000) },
    });

    await runIngressSync(mockClient, config);

    const calls = mockClient.getCalls("tunnelConfig.update");
    expect(calls.length).toBe(1);

    // Verify the tunnel ID was passed correctly
    expect(calls[0][0]).toBe(TEST_TUNNEL_ID);
  });

  test("with only Pages services, ingress has only admin + catch-all", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog"),
        docs: pagesService("docs"),
      },
    });

    await runIngressSync(mockClient, config);

    const ingress = getLastIngress(mockClient);
    // Only admin + catch-all
    expect(ingress.length).toBe(2);
    expect(ingress[0].hostname).toBe("admin.example.com");
    expect(ingress[1].hostname).toBe("");
  });
});
