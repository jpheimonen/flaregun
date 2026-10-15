import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseConfig } from "../src/config/index.js";
import { loadLockFile, saveLockFile, emptyState } from "../src/lock/index.js";
import {
  deriveTunnelName,
  generateConfigContent,
  runSetup,
  updateEnvContent,
  type SetupDeps,
} from "../src/setup/index.js";
import { FakeCloudflare, scriptedDashboard, scriptedIO } from "./helpers/setup-fakes.js";

const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_TUNNEL_TOKEN",
];

let cwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "flaregun-setup-test-"));
  // runSetup reads and sets these; keep tests independent of each other and the shell.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function deps(
  cf: FakeCloudflare,
  io: ReturnType<typeof scriptedIO>,
  dashboard: ReturnType<typeof scriptedDashboard>,
): SetupDeps {
  return {
    io: io.io,
    createClient: (token) => cf.client(token),
    dashboard: dashboard.dashboard,
    cwd,
    onboardingWaitMs: 1000,
  };
}

const readEnv = () => readFileSync(join(cwd, ".env"), "utf-8");

describe("setup in a fresh folder", () => {
  test("gets from a dashboard token to a ready tunnel with one question", async () => {
    const cf = new FakeCloudflare();
    const bootstrapId = cf.addToken("bootstrap-token", "bootstrap");
    const io = scriptedIO([""]); // accept the default admin email
    const dashboard = scriptedDashboard(["bootstrap-token"]);

    const result = await runSetup(deps(cf, io, dashboard));

    expect(result).toEqual({ success: true, domain: "example.com", configPath: join(cwd, "flaregun.yml") });
    expect(io.questions).toHaveLength(1);
    expect(io.questions[0]).toContain("Admin emails");

    // flaregun made its own token and removed the temporary one
    expect(cf.createdTokens).toHaveLength(1);
    expect(cf.deletedTokenIds).toEqual([bootstrapId]);
    expect(dashboard.record.closed).toBe(true);

    // Zero Trust switched on with a One-time PIN login
    expect(cf.organizations.get("acct-1")?.auth_domain).toBe("example.cloudflareaccess.com");
    expect(cf.identityProviders.get("acct-1")).toEqual([{ type: "onetimepin", name: "One-time PIN" }]);

    // A tunnel was created
    expect(cf.tunnels).toEqual([{ id: "tunnel-1", name: "example-com-tunnel", account: "acct-1" }]);

    const env = readEnv();
    expect(env).toContain("CLOUDFLARE_API_TOKEN=flaregun-token-1\n");
    expect(env).toContain("CLOUDFLARE_ACCOUNT_ID=acct-1\n");
    expect(env).toContain("CLOUDFLARE_ZONE_ID=zone-1\n");
    expect(env).toContain("CLOUDFLARE_TUNNEL_TOKEN=tunnel-token-for-tunnel-1\n");
    expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);

    const config = parseConfig(readFileSync(join(cwd, "flaregun.yml"), "utf-8"));
    expect(config.domain).toBe("example.com");
    expect(config.auth).toEqual({ provider: "onetimepin", superusers: ["me@example.com"] });
    expect(config.services).toEqual({});

    expect(loadLockFile(join(cwd, "flaregun.lock")).tunnel).toEqual({ id: "tunnel-1" });

    // Commands that run next in the same process see the credentials
    expect(process.env.CLOUDFLARE_TUNNEL_TOKEN).toBe("tunnel-token-for-tunnel-1");
  });

  test("the created token asks for each permission on the right kind of resource", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("bootstrap-token", "bootstrap");

    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["bootstrap-token"])));

    const policies = cf.createdTokens[0].policies as Array<{
      resources: Record<string, string>;
      permission_groups: Array<{ id: string }>;
    }>;
    const byResource = Object.fromEntries(
      policies.map((p) => [Object.keys(p.resources)[0], p.permission_groups.map((g) => g.id)]),
    );
    expect(byResource["com.cloudflare.api.account.*"]).toEqual([
      "pg-tunnel",
      "pg-access-apps",
      "pg-access-org",
      "pg-account-settings",
      "pg-pages",
      "pg-scripts",
      "pg-d1",
      "pg-r2",
      "pg-kv",
    ]);
    expect(byResource["com.cloudflare.api.account.zone.*"]).toEqual([
      "pg-zone",
      "pg-dns",
      "pg-redirect",
      "pg-routes",
    ]);
    expect(byResource["com.cloudflare.api.user.user-tag-1"]).toEqual(["pg-user", "pg-memberships"]);
  });

  test("a pasted ready-made token is used as it is", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("my-own-token", "full");

    const result = await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["my-own-token"])));

    expect(result.success).toBe(true);
    expect(cf.createdTokens).toHaveLength(0);
    expect(readEnv()).toContain("CLOUDFLARE_API_TOKEN=my-own-token\n");
  });

  test("typed admin emails replace the default", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("bootstrap-token", "bootstrap");

    await runSetup(deps(cf, scriptedIO(["a@x.com, b@y.com"]), scriptedDashboard(["bootstrap-token"])));

    const config = parseConfig(readFileSync(join(cwd, "flaregun.yml"), "utf-8"));
    expect(config.auth.superusers).toEqual(["a@x.com", "b@y.com"]);
  });
});

describe("running setup again", () => {
  test("reuses the token, Zero Trust, login method, config and tunnel without asking anything", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("bootstrap-token", "bootstrap");
    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["bootstrap-token"])));
    writeFileSync(join(cwd, ".env"), readEnv() + "MY_OWN_SETTING=keep-me\n");
    const configBefore = readFileSync(join(cwd, "flaregun.yml"), "utf-8");
    for (const key of ENV_KEYS) delete process.env[key];
    cf.calls = [];

    const io = scriptedIO([]);
    const dashboard = scriptedDashboard([]);
    const result = await runSetup(deps(cf, io, dashboard));

    expect(result.success).toBe(true);
    expect(io.questions).toEqual([]);
    expect(dashboard.record.bootstrapCalls).toBe(0);
    expect(cf.calls).not.toContain("tokens.create");
    expect(cf.calls).not.toContain("organizations.create");
    expect(cf.calls).not.toContain("identityProviders.create");
    expect(cf.calls).not.toContain("tunnels.create");
    expect(cf.tunnels).toHaveLength(1);
    expect(readFileSync(join(cwd, "flaregun.yml"), "utf-8")).toBe(configBefore);
    expect(readEnv()).toContain("MY_OWN_SETTING=keep-me\n");
    expect(io.output.join("\n")).toContain("✓ Using the API token from .env");
  });

  test("a token in .env that stopped working is replaced through the dashboard", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("bootstrap-token", "bootstrap");
    writeFileSync(join(cwd, ".env"), "CLOUDFLARE_API_TOKEN=revoked\n", { mode: 0o644 });

    const io = scriptedIO([""]);
    const result = await runSetup(deps(cf, io, scriptedDashboard(["bootstrap-token"])));

    expect(result.success).toBe(true);
    expect(io.output.join("\n")).toContain("no longer works");
    expect(readEnv()).toContain("CLOUDFLARE_API_TOKEN=flaregun-token-1\n");
    expect(readEnv()).not.toContain("revoked");
    // An older, world-readable .env is tightened once it holds new secrets.
    expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);
  });

  test("an existing tunnel with the domain's name is reused when the lock file is gone", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.tunnels.push({ id: "old-tunnel", name: deriveTunnelName("example.com"), account: "acct-1" });

    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["full"])));

    expect(cf.tunnels).toHaveLength(1);
    expect(loadLockFile(join(cwd, "flaregun.lock")).tunnel).toEqual({ id: "old-tunnel" });
    expect(readEnv()).toContain("CLOUDFLARE_TUNNEL_TOKEN=tunnel-token-for-old-tunnel\n");
  });

  test("a deleted tunnel in the lock file is replaced", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.tunnels.push({ id: "gone", name: "example-com-tunnel", account: "acct-1", deleted_at: "2026-01-01" });
    const lock = emptyState();
    lock.tunnel = { id: "gone" };
    saveLockFile(join(cwd, "flaregun.lock"), lock);

    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["full"])));

    expect(loadLockFile(join(cwd, "flaregun.lock")).tunnel?.id).toBe("tunnel-2");
  });
});

describe("accounts and domains", () => {
  test("asks which account and domain when there are several", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.accounts = [
      { id: "acct-1", name: "Personal" },
      { id: "acct-2", name: "Work" },
    ];
    cf.zones = {
      "acct-1": [{ id: "z1", name: "personal.dev" }],
      "acct-2": [
        { id: "z2", name: "work.com" },
        { id: "z3", name: "work.dev" },
      ],
    };

    const io = scriptedIO(["Work", "work.dev", ""]);
    const result = await runSetup(deps(cf, io, scriptedDashboard(["full"])));

    expect(result.domain).toBe("work.dev");
    expect(readEnv()).toContain("CLOUDFLARE_ACCOUNT_ID=acct-2\n");
    expect(readEnv()).toContain("CLOUDFLARE_ZONE_ID=z3\n");
  });

  test("an existing flaregun.yml picks its domain without asking", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.accounts = [
      { id: "acct-1", name: "Personal" },
      { id: "acct-2", name: "Work" },
    ];
    cf.zones = { "acct-1": [{ id: "z1", name: "personal.dev" }], "acct-2": [{ id: "z2", name: "work.com" }] };
    writeFileSync(
      join(cwd, "flaregun.yml"),
      generateConfigContent({ domain: "work.com", provider: "onetimepin", superusers: ["a@b.c"] }),
    );

    const io = scriptedIO([]);
    const result = await runSetup(deps(cf, io, scriptedDashboard(["full"])));

    expect(result.domain).toBe("work.com");
    expect(io.questions).toEqual([]);
  });

  test("an account without domains stops with a pointer to adding one", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.zones = {};

    const io = scriptedIO([]);
    const result = await runSetup(deps(cf, io, scriptedDashboard(["full"])));

    expect(result.success).toBe(false);
    expect(io.output.join("\n")).toContain("add-site");
  });
});

describe("Zero Trust", () => {
  test("tries another team name when the first is taken", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.takenTeamNames.add("example");

    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["full"])));

    expect(cf.organizations.get("acct-1")?.auth_domain).toBe("example-com.cloudflareaccess.com");
  });

  test("falls back to the dashboard and waits when the API can't switch it on", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.organizationCreateError = "Zero Trust onboarding required";
    const dashboard = scriptedDashboard(["full"], () =>
      cf.organizations.set("acct-1", { name: "picked", auth_domain: "picked.cloudflareaccess.com" }),
    );

    const io = scriptedIO([""]);
    const result = await runSetup(deps(cf, io, dashboard));

    expect(result.success).toBe(true);
    expect(dashboard.record.onboardingShown).toBe(1);
    expect(io.output.join("\n")).toContain("Zero Trust team: picked.cloudflareaccess.com");
  });

  test("stops with instructions when onboarding isn't finished", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.organizationCreateError = "Zero Trust onboarding required";

    const io = scriptedIO([]);
    const result = await runSetup(deps(cf, io, scriptedDashboard(["full"])));

    expect(result.success).toBe(false);
    expect(io.output.join("\n")).toContain("https://one.dash.cloudflare.com/");
    // The token is saved even though setup stopped, so the next run doesn't need the dashboard.
    expect(readEnv()).toContain("CLOUDFLARE_API_TOKEN=full\n");
  });

  test("keeps an existing login method", async () => {
    const cf = new FakeCloudflare();
    cf.addToken("full", "full");
    cf.identityProviders.set("acct-1", [{ type: "github", name: "GitHub" }]);

    await runSetup(deps(cf, scriptedIO([""]), scriptedDashboard(["full"])));

    expect(cf.calls).not.toContain("identityProviders.create");
    const config = parseConfig(readFileSync(join(cwd, "flaregun.yml"), "utf-8"));
    expect(config.auth.provider).toBe("github");
  });
});

describe("file helpers", () => {
  test("updateEnvContent replaces flaregun keys in place and keeps other lines", () => {
    const before = "# mine\nOTHER=1\nCLOUDFLARE_API_TOKEN=old\n";
    const after = updateEnvContent(before, { CLOUDFLARE_API_TOKEN: "new", CLOUDFLARE_ZONE_ID: "z" });
    expect(after).toBe("# mine\nOTHER=1\nCLOUDFLARE_API_TOKEN=new\nCLOUDFLARE_ZONE_ID=z\n");
  });

  test("the starter config is valid and has no services", () => {
    const config = parseConfig(
      generateConfigContent({ domain: "example.com", provider: "onetimepin", superusers: ["a@b.c"] }),
    );
    expect(config.services).toEqual({});
  });

  test("deriveTunnelName turns dots into dashes", () => {
    expect(deriveTunnelName("my.example.com")).toBe("my-example-com-tunnel");
  });

  test("setup doesn't leave a .env behind when the token step never finishes", async () => {
    const cf = new FakeCloudflare();
    const result = await runSetup(deps(cf, scriptedIO([]), scriptedDashboard(["unknown"])));
    expect(result.success).toBe(false);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });
});
