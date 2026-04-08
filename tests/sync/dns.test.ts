import { describe, test, expect } from "bun:test";
import { createMockClient, type MockDnsRecord } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ZONE_ID,
  TEST_TUNNEL_ID,
} from "../helpers/fixtures.js";
import { syncDnsRecords } from "../../src/sync/dns.js";
import { resourceName } from "../../src/naming.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Test helpers ---

/** Runs DNS record sync against a mock client. */
async function runDnsSync(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
) {
  return syncDnsRecords(
    mockClient.client as unknown as Parameters<typeof syncDnsRecords>[0],
    config,
    TEST_ZONE_ID,
    TEST_TUNNEL_ID,
  );
}

// --- Tests ---

describe("syncDnsRecords", () => {
  // --- Wildcard CNAME ---

  test("creates a wildcard CNAME record if it does not exist", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await runDnsSync(mockClient, config);

    const creates = mockClient.getCalls("dns.records.create");
    const wildcardCreate = creates.find(
      (c) => (c[0] as { name: string }).name === `*.example.com`,
    );
    expect(wildcardCreate).toBeDefined();
    const params = wildcardCreate![0] as { name: string; content: string; type: string; proxied: boolean; ttl: number };
    expect(params.content).toBe(`${TEST_TUNNEL_ID}.cfargotunnel.com`);
    expect(params.type).toBe("CNAME");
    expect(params.proxied).toBe(true);
    expect(params.ttl).toBe(1);
  });

  test("skips creating a wildcard CNAME if it already exists with matching content", async () => {
    const mockClient = createMockClient();
    mockClient.setDnsRecords([
      {
        id: "wildcard-1",
        name: "*.example.com",
        type: "CNAME",
        content: `${TEST_TUNNEL_ID}.cfargotunnel.com`,
      },
    ]);

    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await runDnsSync(mockClient, config);

    // No create calls for the wildcard
    const creates = mockClient.getCalls("dns.records.create");
    const wildcardCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "*.example.com",
    );
    expect(wildcardCreate).toBeUndefined();
  });

  test("running DNS sync twice does not create duplicate records", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    // First sync
    await runDnsSync(mockClient, config);

    const createCountAfterFirst = mockClient.getCalls("dns.records.create").length;
    expect(createCountAfterFirst).toBeGreaterThan(0);

    // Second sync — the mock now has the records created by the first sync
    await runDnsSync(mockClient, config);

    const createCountAfterSecond = mockClient.getCalls("dns.records.create").length;
    // No new creates on the second run
    expect(createCountAfterSecond).toBe(createCountAfterFirst);
  });

  // --- Per-Pages CNAME ---

  test("creates per-Pages-service CNAME records for custom subdomains", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        blog: pagesService("blog"),
        docs: pagesService("docs"),
      },
    });

    await runDnsSync(mockClient, config);

    const creates = mockClient.getCalls("dns.records.create");

    // Check blog CNAME
    const blogProjectName = resourceName("example.com", "blog");
    const blogCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "blog.example.com",
    );
    expect(blogCreate).toBeDefined();
    expect((blogCreate![0] as { content: string }).content).toBe(
      `${blogProjectName}.pages.dev`,
    );

    // Check docs CNAME
    const docsProjectName = resourceName("example.com", "docs");
    const docsCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "docs.example.com",
    );
    expect(docsCreate).toBeDefined();
    expect((docsCreate![0] as { content: string }).content).toBe(
      `${docsProjectName}.pages.dev`,
    );
  });

  // --- www CNAME ---

  test("creates a www CNAME pointing to the appropriate Pages project", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await runDnsSync(mockClient, config);

    const creates = mockClient.getCalls("dns.records.create");
    const wwwCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "www.example.com",
    );
    expect(wwwCreate).toBeDefined();

    const blogProjectName = resourceName("example.com", "blog");
    expect((wwwCreate![0] as { content: string }).content).toBe(
      `${blogProjectName}.pages.dev`,
    );
  });

  test("www CNAME is updated (not duplicated) when it exists but points to wrong target", async () => {
    const mockClient = createMockClient();
    mockClient.setDnsRecords([
      {
        id: "www-old",
        name: "www.example.com",
        type: "CNAME",
        content: "old-project.pages.dev",
      },
    ]);

    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await runDnsSync(mockClient, config);

    // Should update, not create a new one
    const updates = mockClient.getCalls("dns.records.update");
    const wwwUpdate = updates.find(
      (c) => (c[0] as string) === "www-old",
    );
    expect(wwwUpdate).toBeDefined();

    const blogProjectName = resourceName("example.com", "blog");
    expect((wwwUpdate![1] as { content: string }).content).toBe(
      `${blogProjectName}.pages.dev`,
    );

    // Should NOT create a duplicate
    const creates = mockClient.getCalls("dns.records.create");
    const wwwCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "www.example.com",
    );
    expect(wwwCreate).toBeUndefined();
  });

  // --- Removal handling ---

  test("DNS records for Pages services removed from config are deleted", async () => {
    const mockClient = createMockClient();

    const removedProjectName = resourceName("example.com", "old-blog");

    // Pre-populate with a CNAME for a service that no longer exists
    mockClient.setDnsRecords([
      {
        id: "wildcard-1",
        name: "*.example.com",
        type: "CNAME",
        content: `${TEST_TUNNEL_ID}.cfargotunnel.com`,
      },
      {
        id: "old-blog-dns",
        name: "oldblog.example.com",
        type: "CNAME",
        content: `${removedProjectName}.pages.dev`,
      },
    ]);

    // Config only has "blog" (not "old-blog")
    const config = makeConfig({
      services: { blog: pagesService("blog") },
    });

    await runDnsSync(mockClient, config);

    // The old-blog record should have been deleted
    const deletes = mockClient.getCalls("dns.records.delete");
    const oldBlogDelete = deletes.find(
      (c) => (c[0] as string) === "old-blog-dns",
    );
    expect(oldBlogDelete).toBeDefined();
  });

  test("the wildcard CNAME is not deleted when individual services are removed", async () => {
    const mockClient = createMockClient();
    mockClient.setDnsRecords([
      {
        id: "wildcard-1",
        name: "*.example.com",
        type: "CNAME",
        content: `${TEST_TUNNEL_ID}.cfargotunnel.com`,
      },
    ]);

    // Config with no services (just ensures wildcard is preserved)
    const config = makeConfig({ services: {} });

    await runDnsSync(mockClient, config);

    // Wildcard should NOT be deleted
    const deletes = mockClient.getCalls("dns.records.delete");
    const wildcardDelete = deletes.find(
      (c) => (c[0] as string) === "wildcard-1",
    );
    expect(wildcardDelete).toBeUndefined();
  });

  test("local services do not generate per-service CNAME records", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: {
        api: localService("api", 3000),
      },
    });

    await runDnsSync(mockClient, config);

    const creates = mockClient.getCalls("dns.records.create");
    // Should only have wildcard (no per-service CNAME for local services, no www since no Pages)
    const apiCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "api.example.com",
    );
    expect(apiCreate).toBeUndefined();
  });

  test("www CNAME is not created when there are no Pages services", async () => {
    const mockClient = createMockClient();
    const config = makeConfig({
      services: { api: localService("api", 3000) },
    });

    await runDnsSync(mockClient, config);

    const creates = mockClient.getCalls("dns.records.create");
    const wwwCreate = creates.find(
      (c) => (c[0] as { name: string }).name === "www.example.com",
    );
    expect(wwwCreate).toBeUndefined();
  });
});
