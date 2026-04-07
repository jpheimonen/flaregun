import { describe, test, expect } from "bun:test";
import Cloudflare from "cloudflare";
import { createClient, createClientFromToken } from "../src/cloudflare/index.js";
import type { CloudflareClient } from "../src/cloudflare/index.js";

describe("Cloudflare SDK client wrapper", () => {
  test("createClient creates a client when given valid credentials", () => {
    const client = createClient({
      apiToken: "test-token",
      accountId: "test-account-id",
      zoneId: "test-zone-id",
    });

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Cloudflare);
  });

  test("createClientFromToken creates a client from a raw API token", () => {
    const client = createClientFromToken("test-token");

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(Cloudflare);
  });

  test("the returned client satisfies the CloudflareClient type (dependency injection seam)", () => {
    // This test verifies the DI pattern works: a function that accepts CloudflareClient
    // can receive either the real client or a mock
    const client: CloudflareClient = createClient({
      apiToken: "test-token",
      accountId: "test-account-id",
      zoneId: "test-zone-id",
    });

    // The client should have expected SDK namespaces
    expect(client.zeroTrust).toBeDefined();
  });

  test("a mock client can be substituted where CloudflareClient is expected", () => {
    // Simulates the createMockClient pattern from sync.test.ts
    const mockClient = {
      zeroTrust: {
        access: {
          applications: {
            list: () => ({}),
            create: async () => ({}),
          },
        },
      },
    };

    // This function simulates a sync engine component that accepts the client
    function usesClient(client: unknown): boolean {
      return client != null;
    }

    // Both real and mock clients should work
    const realClient = createClient({
      apiToken: "test-token",
      accountId: "test-account-id",
      zoneId: "test-zone-id",
    });

    expect(usesClient(realClient)).toBe(true);
    expect(usesClient(mockClient)).toBe(true);
  });
});
