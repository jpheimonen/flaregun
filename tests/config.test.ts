import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseConfig,
  loadConfig,
  ConfigValidationError,
  isWildcard,
  extractWildcardDomain,
  mergeUsers,
  toAccessSelectors,
  buildServiceSelectors,
  diffConfigs,
} from "../src/config/index.js";
import type { ServiceConfig, FlaregunConfig } from "../src/config/index.js";

// --- Test Helpers ---

/** Parses YAML expecting validation failure. Returns the collected errors. */
function expectValidationErrors(yaml: string): string[] {
  try {
    parseConfig(yaml);
    throw new Error("Expected ConfigValidationError but parsing succeeded");
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      return e.errors;
    }
    throw e;
  }
}

// --- YAML Fixtures ---

const VALID_PAGES_YAML = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  photos:
    subdomain: photos
    dist: ./photos/dist
    auth: authorized
    users:
      - friend@example.com
`;

const VALID_LOCAL_YAML = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
`;

const MULTI_SERVICE_YAML = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  photos:
    subdomain: photos
    dist: ./photos/dist
    auth: authorized
    users:
      - friend@example.com
  api:
    subdomain: api
    command: node server.js
    port: 3001
    max_retries: 5
`;

const FULL_PAGES_YAML = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
down_page: ./down.html
services:
  photos:
    subdomain: photos
    dist: ./photos/dist
    build: npm run build
    functions: ./photos/functions/
    database: true
    bucket: true
    kv: true
    auth: authorized
    users:
      - friend@example.com
`;

// --- Parsing Tests ---

describe("config parsing", () => {
  test("valid Pages service config parses and is classified as Pages", () => {
    const config = parseConfig(VALID_PAGES_YAML);

    expect(config.domain).toBe("example.com");
    expect(config.auth.provider).toBe("google");
    expect(config.auth.superusers).toEqual(["admin@example.com"]);
    expect(Object.keys(config.services)).toEqual(["photos"]);

    const photos = config.services.photos;
    expect(photos.subdomain).toBe("photos");
    expect(photos.type).toBe("pages");
    expect(photos.dist).toBe("./photos/dist");
    expect(photos.auth).toBe("authorized");
    expect(photos.users).toEqual(["friend@example.com"]);
  });

  test("valid local service config parses and is classified as local", () => {
    const config = parseConfig(VALID_LOCAL_YAML);

    const api = config.services.api;
    expect(api.subdomain).toBe("api");
    expect(api.type).toBe("local");
    expect(api.command).toBe("node server.js");
    expect(api.port).toBe(3001);
    expect(api.auth).toBe("admin_only"); // default
  });

  test("multi-service config with both Pages and local services parses correctly", () => {
    const config = parseConfig(MULTI_SERVICE_YAML);

    expect(Object.keys(config.services)).toHaveLength(2);
    expect(config.services.photos.type).toBe("pages");
    expect(config.services.api.type).toBe("local");
    expect(config.services.api.max_retries).toBe(5);
  });

  test("optional fields (build, functions, database, bucket, kv, max_retries, down_page) are parsed when present", () => {
    const config = parseConfig(FULL_PAGES_YAML);

    expect(config.down_page).toBe("./down.html");

    const photos = config.services.photos;
    expect(photos.build).toBe("npm run build");
    expect(photos.functions).toBe("./photos/functions/");
    expect(photos.database).toBe(true);
    expect(photos.bucket).toBe(true);
    expect(photos.kv).toBe(true);
  });

  test("auth mode defaults to admin_only when omitted", () => {
    const config = parseConfig(VALID_LOCAL_YAML);
    expect(config.services.api.auth).toBe("admin_only");
  });

  test("functions defaults to 'functions/' when omitted on a Pages service", () => {
    const config = parseConfig(VALID_PAGES_YAML);
    expect(config.services.photos.functions).toBe("functions/");
  });

  test("empty services section is valid", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services: {}
`;
    const config = parseConfig(yaml);
    expect(Object.keys(config.services)).toHaveLength(0);
  });

  test("missing services section defaults to empty", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
`;
    const config = parseConfig(yaml);
    expect(Object.keys(config.services)).toHaveLength(0);
  });
});

// --- Validation Tests ---

describe("config validation", () => {
  test("missing domain field produces error mentioning 'domain'", () => {
    const yaml = `
auth:
  provider: google
  superusers:
    - admin@example.com
services: {}
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("domain"))).toBe(true);
  });

  test("missing auth section produces error mentioning 'auth'", () => {
    const yaml = `
domain: example.com
services: {}
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("auth"))).toBe(true);
  });

  test("missing auth.provider produces error mentioning 'provider'", () => {
    const yaml = `
domain: example.com
auth:
  superusers:
    - admin@example.com
services: {}
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("provider"))).toBe(true);
  });

  test("empty superusers array produces error mentioning 'superusers'", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers: []
services: {}
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("superusers"))).toBe(true);
  });

  test("ambiguous type (both dist and command/port) produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  broken:
    subdomain: broken
    dist: ./dist
    command: node server.js
    port: 3001
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("broken") && msg.includes("ambiguous"))).toBe(true);
  });

  test("unrecognizable type (neither dist nor command/port) produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  broken:
    subdomain: broken
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("broken") && msg.includes("cannot determine"))).toBe(true);
  });

  test("reserved subdomain 'admin' produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  myapp:
    subdomain: admin
    command: node app.js
    port: 3001
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("myapp") && msg.includes("admin") && msg.includes("reserved"))).toBe(true);
  });

  test("reserved subdomain 'down' produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  myapp:
    subdomain: down
    command: node app.js
    port: 3001
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("myapp") && msg.includes("down") && msg.includes("reserved"))).toBe(true);
  });

  test("duplicate subdomains produce validation error listing both service names", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  app1:
    subdomain: shared
    command: node app1.js
    port: 3001
  app2:
    subdomain: shared
    command: node app2.js
    port: 3002
`;
    const errors = expectValidationErrors(yaml);
    expect(
      errors.some(
        (msg) => msg.includes("app1") && msg.includes("app2") && msg.includes("subdomain"),
      ),
    ).toBe(true);
  });

  test("duplicate ports across local services produce validation error listing both service names", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  app1:
    subdomain: app1
    command: node app1.js
    port: 3001
  app2:
    subdomain: app2
    command: node app2.js
    port: 3001
`;
    const errors = expectValidationErrors(yaml);
    expect(
      errors.some(
        (msg) => msg.includes("app1") && msg.includes("app2") && msg.includes("port"),
      ),
    ).toBe(true);
  });

  test("cloud resources (database) on local service produce validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    database: true
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("database"))).toBe(true);
  });

  test("cloud resources (bucket) on local service produce validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    bucket: true
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("bucket"))).toBe(true);
  });

  test("cloud resources (kv) on local service produce validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    kv: true
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("kv"))).toBe(true);
  });

  test("Pages service with database, bucket, and kv is accepted", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  photos:
    subdomain: photos
    dist: ./photos/dist
    database: true
    bucket: true
    kv: true
`;
    const config = parseConfig(yaml);
    const photos = config.services.photos;
    expect(photos.database).toBe(true);
    expect(photos.bucket).toBe(true);
    expect(photos.kv).toBe(true);
  });

  test("max_retries on Pages service produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  photos:
    subdomain: photos
    dist: ./photos/dist
    max_retries: 3
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("photos") && msg.includes("max_retries"))).toBe(true);
  });

  test("users on admin_only service produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    auth: admin_only
    users:
      - friend@example.com
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("users") && msg.includes("admin_only"))).toBe(true);
  });

  test("users on implicitly-defaulted admin_only service (auth omitted) produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    users:
      - friend@example.com
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("users") && msg.includes("admin_only"))).toBe(true);
  });

  test("users on public service produces validation error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
services:
  api:
    subdomain: api
    command: node server.js
    port: 3001
    auth: public
    users:
      - friend@example.com
`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("api") && msg.includes("users") && msg.includes("public"))).toBe(true);
  });

  test("users on authorized service is accepted", () => {
    const config = parseConfig(VALID_PAGES_YAML);
    expect(config.services.photos.auth).toBe("authorized");
    expect(config.services.photos.users).toEqual(["friend@example.com"]);
  });

  test("non-existent down_page file produces validation error in loadConfig", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flaregun-test-"));
    const configFile = join(tmpDir, "flaregun.yml");
    writeFileSync(
      configFile,
      `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
down_page: ./nonexistent.html
`,
    );

    try {
      loadConfig(configFile);
      throw new Error("Expected ConfigValidationError but loadConfig succeeded");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.errors.some((msg) => msg.includes("down_page"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("invalid YAML syntax produces a parse error", () => {
    const yaml = `
domain: example.com
auth:
  provider: google
  superusers:
    - admin@example.com
  broken: [
`;
    expect(() => parseConfig(yaml)).toThrow();
  });

  test("non-object YAML root produces validation error", () => {
    const yaml = `- just a list`;
    const errors = expectValidationErrors(yaml);
    expect(errors.some((msg) => msg.includes("object"))).toBe(true);
  });

  test("multiple validation errors are collected and reported together", () => {
    const yaml = `
services:
  broken:
    port: abc
`;
    const errors = expectValidationErrors(yaml);
    // Should have at least: missing domain, missing auth, and service-level errors
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test("parseConfig accepts a YAML string and returns a typed config (no filesystem needed)", () => {
    const config = parseConfig(VALID_LOCAL_YAML);
    expect(config.domain).toBe("example.com");
    expect(config.auth.provider).toBe("google");
    expect(config.services.api.type).toBe("local");
  });

  test("loadConfig reads from a file path and returns a typed config", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "flaregun-test-"));
    const configFile = join(tmpDir, "flaregun.yml");
    writeFileSync(configFile, VALID_LOCAL_YAML);

    try {
      const config = loadConfig(configFile);
      expect(config.domain).toBe("example.com");
      expect(config.services.api.type).toBe("local");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- User List Utility Tests ---

describe("user list utilities", () => {
  test("isWildcard correctly identifies wildcard entries", () => {
    expect(isWildcard("*@company.com")).toBe(true);
    expect(isWildcard("*@example.org")).toBe(true);
  });

  test("isWildcard returns false for exact emails", () => {
    expect(isWildcard("user@example.com")).toBe(false);
    expect(isWildcard("admin@gmail.com")).toBe(false);
  });

  test("extractWildcardDomain strips the *@ prefix", () => {
    expect(extractWildcardDomain("*@company.com")).toBe("company.com");
    expect(extractWildcardDomain("*@example.org")).toBe("example.org");
  });

  test("mergeUsers deduplicates when superusers overlap with service users", () => {
    const result = mergeUsers(["a@x.com"], ["a@x.com", "b@y.com"]);
    expect(result).toEqual(["a@x.com", "b@y.com"]);
  });

  test("mergeUsers returns only superusers when no service users", () => {
    const result = mergeUsers(["a@x.com", "b@y.com"]);
    expect(result).toEqual(["a@x.com", "b@y.com"]);
  });

  test("mergeUsers returns only superusers when service users is undefined", () => {
    const result = mergeUsers(["a@x.com"], undefined);
    expect(result).toEqual(["a@x.com"]);
  });

  test("mergeUsers combines without duplicates across multiple entries", () => {
    const result = mergeUsers(
      ["admin@gmail.com", "super@gmail.com"],
      ["admin@gmail.com", "*@company.com", "friend@example.com"],
    );
    expect(result).toEqual([
      "admin@gmail.com",
      "super@gmail.com",
      "*@company.com",
      "friend@example.com",
    ]);
  });
});

// --- Access Selector Tests ---

describe("access selectors", () => {
  test("exact email produces email selector", () => {
    const selectors = toAccessSelectors(["user@example.com"]);
    expect(selectors).toEqual([{ email: { email: "user@example.com" } }]);
  });

  test("wildcard produces email_domain selector with *@ stripped", () => {
    const selectors = toAccessSelectors(["*@company.com"]);
    expect(selectors).toEqual([{ email_domain: { domain: "company.com" } }]);
  });

  test("mixed user types produce correct combined selector list", () => {
    const selectors = toAccessSelectors([
      "admin@gmail.com",
      "*@company.com",
      "friend@example.com",
    ]);
    expect(selectors).toEqual([
      { email: { email: "admin@gmail.com" } },
      { email_domain: { domain: "company.com" } },
      { email: { email: "friend@example.com" } },
    ]);
  });

  test("buildServiceSelectors returns empty for public services", () => {
    const service: ServiceConfig = {
      subdomain: "public-site",
      type: "local",
      auth: "public",
      command: "echo hello",
      port: 3003,
    };
    const selectors = buildServiceSelectors(service, ["admin@example.com"]);
    expect(selectors).toEqual([]);
  });

  test("buildServiceSelectors returns superusers-only for admin_only services", () => {
    const service: ServiceConfig = {
      subdomain: "admin-app",
      type: "local",
      auth: "admin_only",
      command: "echo hello",
      port: 3001,
    };
    const selectors = buildServiceSelectors(service, ["admin@example.com"]);
    expect(selectors).toEqual([{ email: { email: "admin@example.com" } }]);
  });

  test("buildServiceSelectors returns merged list for authorized services", () => {
    const service: ServiceConfig = {
      subdomain: "photos",
      type: "pages",
      auth: "authorized",
      dist: "./dist",
      users: ["friend@example.com", "*@company.com"],
    };
    const selectors = buildServiceSelectors(service, ["admin@example.com"]);
    expect(selectors).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "friend@example.com" } },
      { email_domain: { domain: "company.com" } },
    ]);
  });

  test("buildServiceSelectors deduplicates superusers with service users", () => {
    const service: ServiceConfig = {
      subdomain: "app",
      type: "local",
      auth: "authorized",
      command: "echo hello",
      port: 3004,
      users: ["admin@example.com", "other@example.com"],
    };
    const selectors = buildServiceSelectors(service, ["admin@example.com"]);
    expect(selectors).toEqual([
      { email: { email: "admin@example.com" } },
      { email: { email: "other@example.com" } },
    ]);
  });
});

// --- Config Differ Tests ---

describe("config diffing", () => {
  /** Helper to create a base config for diffing tests. */
  function baseConfig(): FlaregunConfig {
    return {
      domain: "example.com",
      auth: {
        provider: "google",
        superusers: ["admin@example.com"],
      },
      services: {
        photos: {
          subdomain: "photos",
          type: "pages",
          auth: "authorized",
          dist: "./photos/dist",
          functions: "functions/",
          users: ["friend@example.com"],
        },
        api: {
          subdomain: "api",
          type: "local",
          auth: "admin_only",
          command: "node server.js",
          port: 3001,
        },
      },
    };
  }

  test("identical configs produce empty diff", () => {
    const config = baseConfig();
    const diff = diffConfigs(config, structuredClone(config));

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified.size).toBe(0);
    expect(diff.globalAuthChanged).toBe(false);
  });

  test("adding a service produces a diff listing it as added", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.blog = {
      subdomain: "blog",
      type: "pages",
      auth: "public",
      dist: "./blog/dist",
      functions: "functions/",
    };

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.added).toEqual(["blog"]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified.size).toBe(0);
  });

  test("removing a service produces a diff listing it as removed", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    delete newConfig.services.api;

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.removed).toEqual(["api"]);
    expect(diff.added).toEqual([]);
    expect(diff.modified.size).toBe(0);
  });

  test("changing service auth mode produces a diff with auth identified as changed", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.api.auth = "public";

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("api")).toBe(true);
    expect(diff.modified.get("api")!.runtime).toContain("auth");
  });

  test("changing service port produces a diff with port identified as changed", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.api.port = 4001;

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("api")).toBe(true);
    expect(diff.modified.get("api")!.runtime).toContain("port");
  });

  test("changing service command produces a diff with command identified as changed", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.api.command = "bun run server.ts";

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("api")).toBe(true);
    expect(diff.modified.get("api")!.runtime).toContain("command");
  });

  test("changing service users produces a diff with users identified as changed", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.photos.users = ["friend@example.com", "new@example.com"];

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("photos")).toBe(true);
    expect(diff.modified.get("photos")!.runtime).toContain("users");
  });

  test("changing global superusers produces a diff indicating global auth change", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.auth.superusers = ["admin@example.com", "new-admin@example.com"];

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.globalAuthChanged).toBe(true);
  });

  test("changing Pages-only fields produces a diff categorizing them as Pages-only", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.photos.dist = "./photos/new-dist";
    newConfig.services.photos.build = "npm run build";
    newConfig.services.photos.database = true;
    newConfig.services.photos.bucket = true;
    newConfig.services.photos.kv = true;

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("photos")).toBe(true);
    const photosDiff = diff.modified.get("photos")!;
    expect(photosDiff.pagesOnly).toContain("dist");
    expect(photosDiff.pagesOnly).toContain("build");
    expect(photosDiff.pagesOnly).toContain("database");
    expect(photosDiff.pagesOnly).toContain("bucket");
    expect(photosDiff.pagesOnly).toContain("kv");
  });

  test("subdomain change is detected", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);
    newConfig.services.api.subdomain = "new-api";

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.modified.has("api")).toBe(true);
    expect(diff.modified.get("api")!.subdomain).toBe(true);
  });

  test("multiple changes in one diff", () => {
    const oldConfig = baseConfig();
    const newConfig = structuredClone(oldConfig);

    // Modify photos
    newConfig.services.photos.auth = "public";
    // Remove api
    delete newConfig.services.api;
    // Add blog
    newConfig.services.blog = {
      subdomain: "blog",
      type: "pages",
      auth: "public",
      dist: "./blog/dist",
      functions: "functions/",
    };
    // Change global auth
    newConfig.auth.superusers = ["admin@example.com", "boss@example.com"];

    const diff = diffConfigs(oldConfig, newConfig);
    expect(diff.added).toEqual(["blog"]);
    expect(diff.removed).toEqual(["api"]);
    expect(diff.modified.has("photos")).toBe(true);
    expect(diff.modified.get("photos")!.runtime).toContain("auth");
    expect(diff.globalAuthChanged).toBe(true);
  });
});
