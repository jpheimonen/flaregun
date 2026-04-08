import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  handleSetup,
  verifyToken,
  lookupZoneId,
  listAccounts,
  createTunnel,
  deriveTunnelName,
  generateEnvContent,
  generateConfigContent,
  stepApiToken,
  stepIdentityProvider,
  stepCreateTunnel,
  stepGenerateEnv,
  stepGenerateConfig,
  stepInitLockFile,
  printSummary,
  type SetupIO,
  type SetupDeps,
  type SetupState,
} from "../src/setup/index.js";
import { parseConfig } from "../src/config/index.js";
import { loadLockFile } from "../src/lock/index.js";

// --- Test Helpers ---

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "flaregun-setup-test-"));
}

/** Creates a mock SetupIO that feeds answers from a queue */
function createMockIO(answers: string[] = []): {
  io: SetupIO;
  output: string[];
  answerQueue: string[];
} {
  const output: string[] = [];
  const answerQueue = [...answers];

  const io: SetupIO = {
    print(msg: string) {
      output.push(msg);
    },
    async prompt(_question: string): Promise<string> {
      const answer = answerQueue.shift();
      if (answer === undefined) {
        throw new Error(`No more answers in queue for prompt: ${_question}`);
      }
      return answer;
    },
    async confirm(_question: string): Promise<boolean> {
      const answer = answerQueue.shift();
      if (answer === undefined) {
        throw new Error(`No more answers in queue for confirm: ${_question}`);
      }
      return answer.toLowerCase().startsWith("y");
    },
  };

  return { io, output, answerQueue };
}

/** Creates a mock Cloudflare client for setup wizard tests */
function createSetupMockClient(options: {
  tokenValid?: boolean;
  tokenError?: string;
  accounts?: Array<{ id: string; name: string }>;
  zones?: Array<{ id: string; name: string }>;
  tunnelResult?: { id: string; token: string };
  tunnelError?: string;
} = {}) {
  const {
    tokenValid = true,
    tokenError,
    accounts = [{ id: "acct-123", name: "My Account" }],
    zones = [{ id: "zone-456", name: "example.com" }],
    tunnelResult = { id: "tunnel-789", token: "tunnel-token-abc" },
    tunnelError,
  } = options;

  const calls: Record<string, unknown[][]> = {};
  function track(method: string, ...args: unknown[]) {
    if (!calls[method]) calls[method] = [];
    calls[method].push(args);
  }

  const client = {
    user: {
      tokens: {
        verify: async () => {
          track("tokens.verify");
          if (!tokenValid) {
            throw new Error(tokenError ?? "Authentication error");
          }
          return { status: "active" };
        },
      },
    },
    accounts: {
      list: () => {
        track("accounts.list");
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const account of accounts) {
              yield account;
            }
          },
        };
      },
    },
    zones: {
      list: (_params: any) => {
        track("zones.list", _params);
        const matchingZones = zones.filter(
          (z) => !_params?.name || z.name === _params.name,
        );
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const zone of matchingZones) {
              yield zone;
            }
          },
        };
      },
    },
    zeroTrust: {
      tunnels: {
        create: async (params: any) => {
          track("tunnels.create", params);
          if (tunnelError) {
            throw new Error(tunnelError);
          }
          return {
            id: tunnelResult.id,
            token: tunnelResult.token,
            name: params.name,
          };
        },
      },
    },
  };

  return { client, calls, getCalls: (method: string) => calls[method] ?? [] };
}

// --- Token Validation Tests ---

describe("token validation", () => {
  test("a valid API token passes verification", async () => {
    const mock = createSetupMockClient({ tokenValid: true });
    const result = await verifyToken(mock.client as any);
    expect(result.valid).toBe(true);
  });

  test("an invalid API token fails with a descriptive error", async () => {
    const mock = createSetupMockClient({
      tokenValid: false,
      tokenError: "Invalid API Token",
    });
    const result = await verifyToken(mock.client as any);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid API Token");
  });

  test("after failed validation the wizard re-prompts", async () => {
    // First call: invalid token client, second call: valid token client
    let callCount = 0;
    const invalidMock = createSetupMockClient({
      tokenValid: false,
      tokenError: "Bad token",
    });
    const validMock = createSetupMockClient({
      tokenValid: true,
      accounts: [{ id: "acct-123", name: "Test Account" }],
      zones: [{ id: "zone-456", name: "example.com" }],
    });

    const { io, output } = createMockIO([
      "bad-token",       // first token attempt (invalid)
      "good-token",      // second token attempt (valid)
      "example.com",     // domain
    ]);

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: (_token: string) => {
        callCount++;
        if (callCount === 1) return invalidMock.client as any;
        return validMock.client as any;
      },
      cwd: tmpDir,
    };

    try {
      const result = await stepApiToken(deps);

      // Should have received the valid token
      expect(result.apiToken).toBe("good-token");
      // Output should contain failure message
      const failMsg = output.find((m) => m.includes("Token validation failed"));
      expect(failMsg).toBeDefined();
      // Output should contain success message
      const successMsg = output.find((m) => m.includes("API token verified"));
      expect(successMsg).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Account and Zone Lookup Tests ---

describe("account and zone lookup", () => {
  test("a valid domain resolves to a zone ID via the SDK", async () => {
    const mock = createSetupMockClient({
      zones: [{ id: "zone-abc", name: "example.com" }],
    });
    const result = await lookupZoneId(mock.client as any, "example.com");
    expect(result.zoneId).toBe("zone-abc");
  });

  test("an invalid domain produces an error", async () => {
    const mock = createSetupMockClient({ zones: [] });
    const result = await lookupZoneId(mock.client as any, "nonexistent.com");
    expect(result.error).toContain("No zone found");
  });

  test("zone lookup re-prompts on invalid domain", async () => {
    const mock = createSetupMockClient({
      accounts: [{ id: "acct-123", name: "Test Account" }],
      zones: [{ id: "zone-456", name: "example.com" }],
    });

    const { io, output } = createMockIO([
      "valid-token",
      "bad-domain.xyz",  // first domain attempt (no zone)
      "example.com",      // second domain attempt (valid)
    ]);

    // Override zone lookup to fail first then succeed
    let domainAttempts = 0;
    const originalList = mock.client.zones.list;
    mock.client.zones.list = (params: any) => {
      domainAttempts++;
      if (domainAttempts === 1) {
        return {
          [Symbol.asyncIterator]: async function* () {
            // no zones
          },
        };
      }
      return originalList(params);
    };

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    };

    try {
      const result = await stepApiToken(deps);
      expect(result.zoneId).toBe("zone-456");
      expect(result.domain).toBe("example.com");
      const errorMsg = output.find((m) => m.includes("No zone found"));
      expect(errorMsg).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Tunnel Creation Tests ---

describe("tunnel creation", () => {
  test("deriveTunnelName converts domain to tunnel name", () => {
    expect(deriveTunnelName("example.com")).toBe("example-com-tunnel");
    expect(deriveTunnelName("my.cool.site")).toBe("my-cool-site-tunnel");
  });

  test("a tunnel is created via the SDK with correct name and account ID", async () => {
    const mock = createSetupMockClient({
      tunnelResult: { id: "tun-new-123", token: "tun-tok-new" },
    });
    const { io } = createMockIO([]);

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    };

    try {
      const result = await stepCreateTunnel(
        deps,
        mock.client as any,
        "acct-123",
        "example.com",
      );

      expect(result.tunnelId).toBe("tun-new-123");
      expect(result.tunnelToken).toBe("tun-tok-new");
      expect(result.tunnelName).toBe("example-com-tunnel");

      // Verify SDK was called with correct params
      const createCalls = mock.getCalls("tunnels.create");
      expect(createCalls.length).toBe(1);
      const params = createCalls[0][0] as any;
      expect(params.account_id).toBe("acct-123");
      expect(params.name).toBe("example-com-tunnel");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tunnel ID and token are extracted from the SDK response", async () => {
    const mock = createSetupMockClient({
      tunnelResult: { id: "extracted-id", token: "extracted-token" },
    });
    const result = await createTunnel(
      mock.client as any,
      "acct-123",
      "test-tunnel",
    );
    expect(result.id).toBe("extracted-id");
    expect(result.token).toBe("extracted-token");
  });

  test("tunnel name conflict shows error and offers alternatives", async () => {
    const mock = createSetupMockClient({
      tunnelError: "Tunnel already exists with this name",
    });
    const { io, output } = createMockIO([
      "y",                    // yes, use existing
      "existing-tunnel-id",   // tunnel ID
      "existing-tunnel-tok",  // tunnel token
    ]);

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    };

    try {
      const result = await stepCreateTunnel(
        deps,
        mock.client as any,
        "acct-123",
        "example.com",
      );

      expect(result.tunnelId).toBe("existing-tunnel-id");
      expect(result.tunnelToken).toBe("existing-tunnel-tok");
      const errorMsg = output.find((m) => m.includes("already exists"));
      expect(errorMsg).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- File Generation Tests ---

describe("env file generation", () => {
  test("generated .env contains all four required environment variables", () => {
    const content = generateEnvContent({
      apiToken: "tok-123",
      accountId: "acct-456",
      zoneId: "zone-789",
      tunnelToken: "tun-abc",
    });

    expect(content).toContain("CLOUDFLARE_API_TOKEN=tok-123");
    expect(content).toContain("CLOUDFLARE_ACCOUNT_ID=acct-456");
    expect(content).toContain("CLOUDFLARE_ZONE_ID=zone-789");
    expect(content).toContain("CLOUDFLARE_TUNNEL_TOKEN=tun-abc");
  });

  test("generated .env includes descriptive comments", () => {
    const content = generateEnvContent({
      apiToken: "tok",
      accountId: "acct",
      zoneId: "zone",
      tunnelToken: "tun",
    });

    expect(content).toContain("# Cloudflare API token");
    expect(content).toContain("# Cloudflare account identifier");
    expect(content).toContain("# Cloudflare Zone ID");
    expect(content).toContain("# Cloudflare Tunnel token");
  });

  test(".env is written without prompting if it does not exist", async () => {
    const tmpDir = makeTmpDir();
    const { io, output } = createMockIO([]);

    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateEnv(deps, {
      apiToken: "tok",
      accountId: "acct",
      zoneId: "zone",
      tunnelToken: "tun",
    });

    expect(written).toBe(true);
    expect(existsSync(join(tmpDir, ".env"))).toBe(true);
    const content = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("CLOUDFLARE_API_TOKEN=tok");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test(".env overwrite prompts user when file already exists", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, ".env"), "OLD=content\n");

    // User declines overwrite
    const { io: ioDecline } = createMockIO(["n"]);
    const depsDecline: SetupDeps = {
      io: ioDecline,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateEnv(depsDecline, {
      apiToken: "tok",
      accountId: "acct",
      zoneId: "zone",
      tunnelToken: "tun",
    });

    expect(written).toBe(false);
    const content = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(content).toBe("OLD=content\n");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test(".env is overwritten when user confirms", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, ".env"), "OLD=content\n");

    const { io } = createMockIO(["y"]);
    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateEnv(deps, {
      apiToken: "new-tok",
      accountId: "new-acct",
      zoneId: "new-zone",
      tunnelToken: "new-tun",
    });

    expect(written).toBe(true);
    const content = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("CLOUDFLARE_API_TOKEN=new-tok");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("config file generation", () => {
  test("generated flaregun.yml contains domain, auth, and homepage service", () => {
    const content = generateConfigContent({
      domain: "example.com",
      provider: "google",
      superusers: ["admin@example.com"],
    });

    expect(content).toContain("domain: example.com");
    expect(content).toContain("provider: google");
    expect(content).toContain("- admin@example.com");
    expect(content).toContain("homepage:");
    expect(content).toContain("subdomain: www");
    expect(content).toContain("dist: projects/homepage/dist");
  });

  test("generated flaregun.yml passes config loader validation", () => {
    const content = generateConfigContent({
      domain: "example.com",
      provider: "google",
      superusers: ["admin@example.com"],
    });

    const config = parseConfig(content);
    expect(config.domain).toBe("example.com");
    expect(config.auth.provider).toBe("google");
    expect(config.auth.superusers).toEqual(["admin@example.com"]);
    expect(config.services.homepage).toBeDefined();
    expect(config.services.homepage.subdomain).toBe("www");
    expect(config.services.homepage.type).toBe("pages");
  });

  test("generated flaregun.yml includes helpful comments", () => {
    const content = generateConfigContent({
      domain: "example.com",
      provider: "github",
      superusers: ["user@example.com"],
    });

    expect(content).toContain("# ");
    expect(content).toContain("Add more services");
  });

  test("generated flaregun.yml supports multiple superusers", () => {
    const content = generateConfigContent({
      domain: "example.com",
      provider: "google",
      superusers: ["admin1@example.com", "admin2@example.com"],
    });

    expect(content).toContain("- admin1@example.com");
    expect(content).toContain("- admin2@example.com");

    // Should still pass validation
    const config = parseConfig(content);
    expect(config.auth.superusers).toEqual([
      "admin1@example.com",
      "admin2@example.com",
    ]);
  });

  test("flaregun.yml is written without prompting if it does not exist", async () => {
    const tmpDir = makeTmpDir();
    const { io } = createMockIO([]);

    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateConfig(deps, {
      domain: "example.com",
      provider: "google",
      superusers: ["a@b.com"],
    });

    expect(written).toBe(true);
    expect(existsSync(join(tmpDir, "flaregun.yml"))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("flaregun.yml overwrite prompts user when file already exists", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "flaregun.yml"), "domain: old.com\n");

    // User declines
    const { io } = createMockIO(["n"]);
    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateConfig(deps, {
      domain: "example.com",
      provider: "google",
      superusers: ["a@b.com"],
    });

    expect(written).toBe(false);
    const content = readFileSync(join(tmpDir, "flaregun.yml"), "utf-8");
    expect(content).toBe("domain: old.com\n");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("flaregun.yml is overwritten when user confirms", async () => {
    const tmpDir = makeTmpDir();
    writeFileSync(join(tmpDir, "flaregun.yml"), "domain: old.com\n");

    const { io } = createMockIO(["y"]);
    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    const written = await stepGenerateConfig(deps, {
      domain: "new.com",
      provider: "github",
      superusers: ["admin@new.com"],
    });

    expect(written).toBe(true);
    const content = readFileSync(join(tmpDir, "flaregun.yml"), "utf-8");
    expect(content).toContain("domain: new.com");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// --- Lock File Tests ---

describe("lock file initialization", () => {
  test("tunnel ID is stored in the lock file", async () => {
    const tmpDir = makeTmpDir();
    const { io } = createMockIO([]);

    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    await stepInitLockFile(deps, "tunnel-id-999");

    const lockPath = join(tmpDir, "flaregun.lock");
    expect(existsSync(lockPath)).toBe(true);

    const state = loadLockFile(lockPath);
    expect(state.tunnel).toBeDefined();
    expect(state.tunnel!.id).toBe("tunnel-id-999");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("existing lock file entries are preserved when adding tunnel ID", async () => {
    const tmpDir = makeTmpDir();
    const lockPath = join(tmpDir, "flaregun.lock");

    // Write an existing lock file with some data
    writeFileSync(
      lockPath,
      "# Auto-generated by flaregun — do not edit manually.\n# This file tracks provisioned Cloudflare resource IDs.\n\npages:\n  blog:\n    project_name: example-com-blog\n",
    );

    const { io } = createMockIO([]);
    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    await stepInitLockFile(deps, "new-tunnel-id");

    const state = loadLockFile(lockPath);
    expect(state.tunnel).toBeDefined();
    expect(state.tunnel!.id).toBe("new-tunnel-id");
    // Existing pages entry should still be there
    expect(state.pages.blog).toBeDefined();
    expect(state.pages.blog.project_name).toBe("example-com-blog");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// --- Identity Provider Tests ---

describe("identity provider step", () => {
  test("collects provider name and superuser emails", async () => {
    const { io, output } = createMockIO([
      "google",                           // provider name
      "admin@example.com, dev@example.com", // superuser emails
    ]);

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: () => ({} as any),
      cwd: tmpDir,
    };

    try {
      const result = await stepIdentityProvider(deps);
      expect(result.provider).toBe("google");
      expect(result.superusers).toEqual(["admin@example.com", "dev@example.com"]);

      // Should display instructions and links
      const hasInstructions = output.some((m) => m.includes("identity provider"));
      expect(hasInstructions).toBe(true);
      const hasLink = output.some((m) => m.includes("one.dash.cloudflare.com"));
      expect(hasLink).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Step 1 Display Tests ---

describe("step 1 displays token information", () => {
  test("displays exact API token permissions and creation URL", async () => {
    const mock = createSetupMockClient({
      accounts: [{ id: "acct-1", name: "Acct" }],
      zones: [{ id: "zone-1", name: "example.com" }],
    });

    const { io, output } = createMockIO([
      "valid-token",  // token
      "example.com",  // domain
    ]);

    const tmpDir = makeTmpDir();
    const deps: SetupDeps = {
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    };

    try {
      await stepApiToken(deps);

      // Check permissions are listed
      expect(output.some((m) => m.includes("Cloudflare Tunnel: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("DNS: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("D1: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Workers R2 Storage: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Workers KV Storage: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Zone Rulesets: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Cloudflare Pages: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Workers Routes: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Access: Apps and Policies: Edit"))).toBe(true);
      expect(output.some((m) => m.includes("Organizations, Identity Providers"))).toBe(true);

      // Check URL
      expect(
        output.some((m) =>
          m.includes("dash.cloudflare.com/profile/api-tokens"),
        ),
      ).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// --- Completion Summary Tests ---

describe("completion summary", () => {
  test("displays what was created and suggests next steps", () => {
    const { io, output } = createMockIO([]);

    const state: SetupState = {
      apiToken: "tok",
      accountId: "acct",
      zoneId: "zone",
      domain: "example.com",
      provider: "google",
      superusers: ["admin@example.com"],
      tunnelId: "tunnel-123",
      tunnelToken: "tun-tok",
      tunnelName: "example-com-tunnel",
      envWritten: true,
      configWritten: true,
      lockWritten: true,
    };

    printSummary(io, state);

    // Check summary items
    expect(output.some((m) => m.includes("API token validated"))).toBe(true);
    expect(output.some((m) => m.includes("Identity provider configured"))).toBe(true);
    expect(output.some((m) => m.includes("Tunnel created"))).toBe(true);
    expect(output.some((m) => m.includes("example-com-tunnel"))).toBe(true);
    expect(output.some((m) => m.includes(".env file") && m.includes("generated"))).toBe(true);
    expect(output.some((m) => m.includes("flaregun.yml") && m.includes("generated"))).toBe(true);
    expect(output.some((m) => m.includes("Lock file") && m.includes("initialized"))).toBe(true);

    // Check next steps
    expect(output.some((m) => m.includes("flaregun up"))).toBe(true);
    expect(output.some((m) => m.includes("flaregun deploy"))).toBe(true);
    expect(output.some((m) => m.includes("flaregun.yml"))).toBe(true);
  });

  test("shows skipped status for files not written", () => {
    const { io, output } = createMockIO([]);

    const state: SetupState = {
      apiToken: "tok",
      accountId: "acct",
      zoneId: "zone",
      domain: "example.com",
      provider: "google",
      superusers: ["admin@example.com"],
      tunnelId: "tunnel-123",
      tunnelToken: "tun-tok",
      tunnelName: "example-com-tunnel",
      envWritten: false,
      configWritten: false,
      lockWritten: true,
    };

    printSummary(io, state);

    expect(output.some((m) => m.includes(".env file") && m.includes("skipped"))).toBe(true);
    expect(output.some((m) => m.includes("flaregun.yml") && m.includes("skipped"))).toBe(true);
  });
});

// --- Full Flow Integration Test ---

describe("full setup wizard flow", () => {
  test("walks through all steps and creates all files", async () => {
    const tmpDir = makeTmpDir();

    const mock = createSetupMockClient({
      tokenValid: true,
      accounts: [{ id: "acct-full", name: "Full Test Account" }],
      zones: [{ id: "zone-full", name: "mysite.com" }],
      tunnelResult: { id: "tun-full", token: "tun-tok-full" },
    });

    const { io, output } = createMockIO([
      "my-api-token",                  // Step 1: token
      "mysite.com",                    // Step 1: domain
      "github",                        // Step 2: provider
      "admin@mysite.com",              // Step 2: superusers
    ]);

    const result = await handleSetup({
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);

    // Verify .env was created with correct content
    const envPath = join(tmpDir, ".env");
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, "utf-8");
    expect(envContent).toContain("CLOUDFLARE_API_TOKEN=my-api-token");
    expect(envContent).toContain("CLOUDFLARE_ACCOUNT_ID=acct-full");
    expect(envContent).toContain("CLOUDFLARE_ZONE_ID=zone-full");
    expect(envContent).toContain("CLOUDFLARE_TUNNEL_TOKEN=tun-tok-full");

    // Verify flaregun.yml was created and is valid
    const configPath = join(tmpDir, "flaregun.yml");
    expect(existsSync(configPath)).toBe(true);
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("domain: mysite.com");
    expect(configContent).toContain("provider: github");
    expect(configContent).toContain("admin@mysite.com");

    // Verify the config passes validation
    const config = parseConfig(configContent);
    expect(config.domain).toBe("mysite.com");

    // Verify lock file was created with tunnel ID
    const lockPath = join(tmpDir, "flaregun.lock");
    expect(existsSync(lockPath)).toBe(true);
    const lockState = loadLockFile(lockPath);
    expect(lockState.tunnel!.id).toBe("tun-full");

    // Verify summary was printed
    expect(output.some((m) => m.includes("Setup Complete"))).toBe(true);
    expect(output.some((m) => m.includes("flaregun up"))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("handles existing files with overwrite declined", async () => {
    const tmpDir = makeTmpDir();

    // Pre-create files
    writeFileSync(join(tmpDir, ".env"), "EXISTING=true\n");
    writeFileSync(join(tmpDir, "flaregun.yml"), "domain: old.com\n");

    const mock = createSetupMockClient({
      tokenValid: true,
      accounts: [{ id: "acct-1", name: "Acct" }],
      zones: [{ id: "zone-1", name: "test.com" }],
      tunnelResult: { id: "tun-1", token: "tun-tok-1" },
    });

    const { io, output } = createMockIO([
      "my-token",        // Step 1: token
      "test.com",        // Step 1: domain
      "google",          // Step 2: provider
      "admin@test.com",  // Step 2: superusers
      "n",               // Step 4: decline .env overwrite
      "n",               // Step 5: decline config overwrite
    ]);

    const result = await handleSetup({
      io,
      createClient: () => mock.client as any,
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);

    // .env should be unchanged
    const envContent = readFileSync(join(tmpDir, ".env"), "utf-8");
    expect(envContent).toBe("EXISTING=true\n");

    // flaregun.yml should be unchanged
    const configContent = readFileSync(join(tmpDir, "flaregun.yml"), "utf-8");
    expect(configContent).toBe("domain: old.com\n");

    // Lock file should still be created/updated
    const lockState = loadLockFile(join(tmpDir, "flaregun.lock"));
    expect(lockState.tunnel!.id).toBe("tun-1");

    // Summary should show skipped files
    expect(output.some((m) => m.includes("skipped"))).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
