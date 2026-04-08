import { describe, test, expect } from "bun:test";
import { createMockClient } from "../helpers/mock-client.js";
import {
  makeConfig,
  pagesService,
  localService,
  TEST_ACCOUNT_ID,
} from "../helpers/fixtures.js";
import {
  provisionResources,
  destroyResources,
  d1Name,
  r2Name,
  kvName,
} from "../../src/sync/provision.js";
import { emptyState, type LockState } from "../../src/lock/index.js";
import { resourceName } from "../../src/naming.js";
import type { FlaregunConfig } from "../../src/config/index.js";

// --- Test helpers ---

/** Runs the provisioner against a mock client. */
async function runProvision(
  mockClient: ReturnType<typeof createMockClient>,
  config: FlaregunConfig,
  lockState: LockState,
  serviceFilter?: string[],
) {
  return provisionResources(
    mockClient.client as unknown as Parameters<typeof provisionResources>[0],
    config,
    TEST_ACCOUNT_ID,
    lockState,
    serviceFilter,
  );
}

/** Runs the destroy function against a mock client. */
async function runDestroy(
  mockClient: ReturnType<typeof createMockClient>,
  lockState: LockState,
) {
  return destroyResources(
    mockClient.client as unknown as Parameters<typeof destroyResources>[0],
    TEST_ACCOUNT_ID,
    lockState,
  );
}

// --- Resource Name Tests ---

describe("resource naming", () => {
  test("d1Name appends -db suffix to the base resource name", () => {
    expect(d1Name("example.com", "blog")).toBe("example-com-blog-db");
  });

  test("r2Name appends -bucket suffix to the base resource name", () => {
    expect(r2Name("example.com", "blog")).toBe("example-com-blog-bucket");
  });

  test("kvName appends -kv suffix to the base resource name", () => {
    expect(kvName("example.com", "blog")).toBe("example-com-blog-kv");
  });

  test("resource names use the shared naming utility from step 005", () => {
    const base = resourceName("example.com", "blog");
    expect(d1Name("example.com", "blog")).toBe(`${base}-db`);
    expect(r2Name("example.com", "blog")).toBe(`${base}-bucket`);
    expect(kvName("example.com", "blog")).toBe(`${base}-kv`);
  });

  test("resource names follow the domain-service convention", () => {
    expect(d1Name("my.cool.site", "api")).toBe("my-cool-site-api-db");
    expect(r2Name("my.cool.site", "api")).toBe("my-cool-site-api-bucket");
    expect(kvName("my.cool.site", "api")).toBe("my-cool-site-api-kv");
  });

  test("generated resource names satisfy R2 bucket naming constraints", () => {
    const bucketName = r2Name("example.com", "blog");
    // R2: lowercase, hyphens, 3-63 chars, no leading/trailing hyphen
    expect(bucketName).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    expect(bucketName.length).toBeGreaterThanOrEqual(3);
    expect(bucketName.length).toBeLessThanOrEqual(63);
  });

  test("long domain+service names are truncated to satisfy R2 63-char limit", () => {
    // A very long domain + service name that would exceed 63 chars with suffix
    const longDomain = "my-very-long-subdomain.extremely-long-domain-name.example.com";
    const longService = "my-very-long-service-name";
    const bucketName = r2Name(longDomain, longService);
    const dbName = d1Name(longDomain, longService);
    const nsName = kvName(longDomain, longService);

    // All must be ≤ 63 chars
    expect(bucketName.length).toBeLessThanOrEqual(63);
    expect(dbName.length).toBeLessThanOrEqual(63);
    expect(nsName.length).toBeLessThanOrEqual(63);

    // Must not end with a hyphen
    expect(bucketName).toMatch(/[a-z0-9]$/);
    expect(dbName).toMatch(/[a-z0-9]$/);
    expect(nsName).toMatch(/[a-z0-9]$/);
  });
});

// --- Provisioning Tests ---

describe("provision: D1 database", () => {
  test("a service with database: true and no lock file entry results in a D1 database being created", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("d1.database.create");
    expect(createCalls.length).toBe(1);
    expect((createCalls[0][0] as { name: string }).name).toBe(
      "example-com-blog-db",
    );
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("created");
    expect(result.actions[0].resourceType).toBe("d1_database");
  });

  test("a service with database: true and an existing D1 database ID in the lock file does not create a new database", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "existing-db-id",
    };
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("d1.database.create");
    expect(createCalls.length).toBe(0);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("skipped");
    expect(result.actions[0].id).toBe("existing-db-id");
  });
});

describe("provision: R2 bucket", () => {
  test("a service with bucket: true and no lock file entry results in an R2 bucket being created", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { bucket: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("r2.buckets.create");
    expect(createCalls.length).toBe(1);
    expect((createCalls[0][0] as { name: string }).name).toBe(
      "example-com-blog-bucket",
    );
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("created");
    expect(result.actions[0].resourceType).toBe("r2_bucket");
  });

  test("a service with bucket: true and an existing R2 bucket name in the lock file does not create a new bucket", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      r2_bucket_name: "existing-bucket",
    };
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { bucket: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("r2.buckets.create");
    expect(createCalls.length).toBe(0);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("skipped");
  });
});

describe("provision: KV namespace", () => {
  test("a service with kv: true and no lock file entry results in a KV namespace being created", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { kv: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("kv.namespaces.create");
    expect(createCalls.length).toBe(1);
    expect((createCalls[0][0] as { title: string }).title).toBe(
      "example-com-blog-kv",
    );
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("created");
    expect(result.actions[0].resourceType).toBe("kv_namespace");
  });

  test("a service with kv: true and an existing KV namespace ID in the lock file does not create a new namespace", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      kv_namespace_id: "existing-ns-id",
    };
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { kv: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("kv.namespaces.create");
    expect(createCalls.length).toBe(0);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("skipped");
    expect(result.actions[0].id).toBe("existing-ns-id");
  });
});

describe("provision: multiple resources", () => {
  test("a service with all three (database, bucket, kv) results in all three being created when none are in the lock file", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", {
          database: true,
          bucket: true,
          kv: true,
        }),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    expect(mockClient.getCalls("d1.database.create").length).toBe(1);
    expect(mockClient.getCalls("r2.buckets.create").length).toBe(1);
    expect(mockClient.getCalls("kv.namespaces.create").length).toBe(1);
    expect(result.actions.length).toBe(3);
    expect(result.actions.every((a) => a.action === "created")).toBe(true);
  });

  test("a service with no cloud resource declarations results in zero provisioning API calls", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only"),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    expect(mockClient.getCalls("d1.database.create").length).toBe(0);
    expect(mockClient.getCalls("r2.buckets.create").length).toBe(0);
    expect(mockClient.getCalls("kv.namespaces.create").length).toBe(0);
    expect(result.actions.length).toBe(0);
  });
});

describe("provision: service type filtering", () => {
  test("local services are skipped — only Pages services are provisioned", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
        api: localService("api", 3000, "admin_only"),
      },
    });

    const result = await runProvision(mockClient, config, lockState);

    // Only the blog service should have been provisioned
    expect(mockClient.getCalls("d1.database.create").length).toBe(1);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].service).toBe("blog");
  });
});

describe("provision: lock file updates", () => {
  test("newly created resource IDs are stored in the lock file after provisioning", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", {
          database: true,
          bucket: true,
          kv: true,
        }),
      },
    });

    await runProvision(mockClient, config, lockState);

    // The lock state should now contain the created resource IDs
    expect(lockState.pages["blog"]).toBeDefined();
    expect(lockState.pages["blog"].d1_database_id).toBeDefined();
    expect(lockState.pages["blog"].r2_bucket_name).toBe(
      "example-com-blog-bucket",
    );
    expect(lockState.pages["blog"].kv_namespace_id).toBeDefined();
  });

  test("resource names follow the expected naming convention (domain + service derived)", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      domain: "my.cool.site",
      services: {
        api: pagesService("api", "admin_only", { database: true }),
      },
    });

    await runProvision(mockClient, config, lockState);

    const createCalls = mockClient.getCalls("d1.database.create");
    expect((createCalls[0][0] as { name: string }).name).toBe(
      "my-cool-site-api-db",
    );
  });
});

describe("provision: service name filter", () => {
  test("provisioning with a service name filter only provisions the named services", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
        docs: pagesService("docs", "admin_only", { database: true }),
        api: pagesService("api", "admin_only", { kv: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState, ["blog"]);

    expect(result.actions.length).toBe(1);
    expect(result.actions[0].service).toBe("blog");
    expect(mockClient.getCalls("d1.database.create").length).toBe(1);
    expect(mockClient.getCalls("kv.namespaces.create").length).toBe(0);
  });

  test("provisioning with a filter where all named services already have lock file entries results in zero API calls", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "existing-db-id",
    };
    const config = makeConfig({
      services: {
        blog: pagesService("blog", "admin_only", { database: true }),
        docs: pagesService("docs", "admin_only", { database: true }),
      },
    });

    const result = await runProvision(mockClient, config, lockState, ["blog"]);

    expect(mockClient.getCalls("d1.database.create").length).toBe(0);
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].action).toBe("skipped");
  });
});

// --- Destruction Tests ---

describe("destroy: individual resource types", () => {
  test("destroying with a lock file containing a D1 database entry results in a delete call for that database ID", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
    };

    const result = await runDestroy(mockClient, lockState);

    const deleteCalls = mockClient.getCalls("d1.database.delete");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe("db-123");
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].success).toBe(true);
    expect(result.actions[0].resourceType).toBe("d1_database");
  });

  test("destroying with a lock file containing an R2 bucket entry results in a delete call for that bucket name", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      r2_bucket_name: "example-com-blog-bucket",
    };

    const result = await runDestroy(mockClient, lockState);

    const deleteCalls = mockClient.getCalls("r2.buckets.delete");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe("example-com-blog-bucket");
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].success).toBe(true);
    expect(result.actions[0].resourceType).toBe("r2_bucket");
  });

  test("destroying with a lock file containing a KV namespace entry results in a delete call for that namespace ID", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      kv_namespace_id: "kv-456",
    };

    const result = await runDestroy(mockClient, lockState);

    const deleteCalls = mockClient.getCalls("kv.namespaces.delete");
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe("kv-456");
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].success).toBe(true);
    expect(result.actions[0].resourceType).toBe("kv_namespace");
  });
});

describe("destroy: multiple resource types", () => {
  test("destroying with multiple resource types deletes all of them", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
      r2_bucket_name: "example-com-blog-bucket",
      kv_namespace_id: "kv-456",
    };

    const result = await runDestroy(mockClient, lockState);

    expect(mockClient.getCalls("d1.database.delete").length).toBe(1);
    expect(mockClient.getCalls("r2.buckets.delete").length).toBe(1);
    expect(mockClient.getCalls("kv.namespaces.delete").length).toBe(1);
    expect(result.actions.length).toBe(3);
    expect(result.actions.every((a) => a.success)).toBe(true);
  });
});

describe("destroy: continue on failure", () => {
  test("if a single deletion fails, the remaining deletions still proceed", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
      r2_bucket_name: "example-com-blog-bucket",
      kv_namespace_id: "kv-456",
    };

    // Make D1 delete throw
    mockClient.client.d1.database.delete = async (...args: unknown[]) => {
      throw new Error("D1 delete failed: resource not found");
    };

    const result = await runDestroy(mockClient, lockState);

    // D1 should have failed, but R2 and KV should have succeeded
    const d1Action = result.actions.find((a) => a.resourceType === "d1_database");
    const r2Action = result.actions.find((a) => a.resourceType === "r2_bucket");
    const kvAction = result.actions.find((a) => a.resourceType === "kv_namespace");

    expect(d1Action!.success).toBe(false);
    expect(d1Action!.error).toBe("D1 delete failed: resource not found");
    expect(r2Action!.success).toBe(true);
    expect(kvAction!.success).toBe(true);
  });
});

describe("destroy: lock file cleanup", () => {
  test("successfully deleted resources are removed from the lock file", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
      r2_bucket_name: "example-com-blog-bucket",
      kv_namespace_id: "kv-456",
    };

    await runDestroy(mockClient, lockState);

    // All resource IDs should be removed from the lock state
    expect(lockState.pages["blog"].d1_database_id).toBeUndefined();
    expect(lockState.pages["blog"].r2_bucket_name).toBeUndefined();
    expect(lockState.pages["blog"].kv_namespace_id).toBeUndefined();
  });

  test("resources that failed to delete remain in the lock file for retry", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
      r2_bucket_name: "example-com-blog-bucket",
    };

    // Make R2 delete throw
    mockClient.client.r2.buckets.delete = async () => {
      throw new Error("R2 delete failed");
    };

    await runDestroy(mockClient, lockState);

    // D1 should be removed (success), R2 should remain (failure)
    expect(lockState.pages["blog"].d1_database_id).toBeUndefined();
    expect(lockState.pages["blog"].r2_bucket_name).toBe(
      "example-com-blog-bucket",
    );
  });
});

describe("destroy: empty lock file", () => {
  test("destroying with an empty lock file results in zero API calls", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();

    const result = await runDestroy(mockClient, lockState);

    expect(result.actions.length).toBe(0);
    expect(mockClient.getCalls("d1.database.delete").length).toBe(0);
    expect(mockClient.getCalls("r2.buckets.delete").length).toBe(0);
    expect(mockClient.getCalls("kv.namespaces.delete").length).toBe(0);
  });
});

describe("destroy: summary report", () => {
  test("the destruction function returns a summary indicating success/failure per resource", async () => {
    const mockClient = createMockClient();
    const lockState = emptyState();
    lockState.pages["blog"] = {
      project_name: "example-com-blog",
      d1_database_id: "db-123",
      r2_bucket_name: "example-com-blog-bucket",
    };

    // Make R2 delete throw
    mockClient.client.r2.buckets.delete = async () => {
      throw new Error("API error");
    };

    const result = await runDestroy(mockClient, lockState);

    expect(result.actions.length).toBe(2);

    const d1Action = result.actions.find(
      (a) => a.resourceType === "d1_database",
    );
    expect(d1Action).toBeDefined();
    expect(d1Action!.success).toBe(true);
    expect(d1Action!.service).toBe("blog");
    expect(d1Action!.resourceId).toBe("db-123");

    const r2Action = result.actions.find(
      (a) => a.resourceType === "r2_bucket",
    );
    expect(r2Action).toBeDefined();
    expect(r2Action!.success).toBe(false);
    expect(r2Action!.error).toBe("API error");
    expect(r2Action!.service).toBe("blog");
    expect(r2Action!.resourceId).toBe("example-com-blog-bucket");
  });
});

// --- Mock Client Extension Tests ---

describe("mock client: D1, R2, KV support", () => {
  test("mock client supports D1 database create with call tracking", async () => {
    const mockClient = createMockClient();
    const result = await mockClient.client.d1.database.create({
      account_id: TEST_ACCOUNT_ID,
      name: "test-db",
    });

    expect(result.uuid).toBeDefined();
    expect(result.name).toBe("test-db");
    expect(mockClient.getCalls("d1.database.create").length).toBe(1);
    expect(mockClient.getDatabases().length).toBe(1);
  });

  test("mock client supports D1 database delete with call tracking", async () => {
    const mockClient = createMockClient();
    mockClient.setDatabases([
      { uuid: "db-1", name: "test-db", created_at: "2024-01-01" },
    ]);

    await mockClient.client.d1.database.delete("db-1", {
      account_id: TEST_ACCOUNT_ID,
    });

    expect(mockClient.getCalls("d1.database.delete").length).toBe(1);
    expect(mockClient.getDatabases().length).toBe(0);
  });

  test("mock client supports R2 bucket create with call tracking", async () => {
    const mockClient = createMockClient();
    const result = await mockClient.client.r2.buckets.create({
      account_id: TEST_ACCOUNT_ID,
      name: "test-bucket",
    });

    expect(result.name).toBe("test-bucket");
    expect(mockClient.getCalls("r2.buckets.create").length).toBe(1);
    expect(mockClient.getBuckets().length).toBe(1);
  });

  test("mock client supports R2 bucket delete with call tracking", async () => {
    const mockClient = createMockClient();
    mockClient.setBuckets([
      { name: "test-bucket", creation_date: "2024-01-01" },
    ]);

    await mockClient.client.r2.buckets.delete("test-bucket", {
      account_id: TEST_ACCOUNT_ID,
    });

    expect(mockClient.getCalls("r2.buckets.delete").length).toBe(1);
    expect(mockClient.getBuckets().length).toBe(0);
  });

  test("mock client supports KV namespace create with call tracking", async () => {
    const mockClient = createMockClient();
    const result = await mockClient.client.kv.namespaces.create({
      account_id: TEST_ACCOUNT_ID,
      title: "test-kv",
    });

    expect(result.id).toBeDefined();
    expect(result.title).toBe("test-kv");
    expect(mockClient.getCalls("kv.namespaces.create").length).toBe(1);
    expect(mockClient.getNamespaces().length).toBe(1);
  });

  test("mock client supports KV namespace delete with call tracking", async () => {
    const mockClient = createMockClient();
    mockClient.setNamespaces([{ id: "kv-1", title: "test-kv" }]);

    await mockClient.client.kv.namespaces.delete("kv-1", {
      account_id: TEST_ACCOUNT_ID,
    });

    expect(mockClient.getCalls("kv.namespaces.delete").length).toBe(1);
    expect(mockClient.getNamespaces().length).toBe(0);
  });
});
