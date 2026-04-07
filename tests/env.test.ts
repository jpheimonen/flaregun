import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadEnvFile,
  validateEnv,
  loadAndValidateEnv,
  EnvValidationError,
} from "../src/env/index.js";

// --- Environment Save/Restore ---

/** Keys that our tests touch in process.env */
const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_TUNNEL_TOKEN",
] as const;

/** Saved environment state for restore after each test */
let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function setAllEnv(): void {
  process.env.CLOUDFLARE_API_TOKEN = "test-api-token";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account-id";
  process.env.CLOUDFLARE_ZONE_ID = "test-zone-id";
  process.env.CLOUDFLARE_TUNNEL_TOKEN = "test-tunnel-token";
}

// --- Test Helpers ---

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "flaregun-env-test-"));
}

// --- Validation Tests ---

describe("environment validation", () => {
  beforeEach(() => {
    saveEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  test("all required variables present results in successful validation", () => {
    setAllEnv();

    const creds = validateEnv("deploy");
    expect(creds.apiToken).toBe("test-api-token");
    expect(creds.accountId).toBe("test-account-id");
    expect(creds.zoneId).toBe("test-zone-id");
  });

  test("all required variables present with tunnel token for 'up' context", () => {
    setAllEnv();

    const creds = validateEnv("up");
    expect(creds.apiToken).toBe("test-api-token");
    expect(creds.accountId).toBe("test-account-id");
    expect(creds.zoneId).toBe("test-zone-id");
    expect(creds.tunnelToken).toBe("test-tunnel-token");
  });

  test("missing CLOUDFLARE_API_TOKEN produces an error naming that variable", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_API_TOKEN;

    try {
      validateEnv("deploy");
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.missing).toContain("CLOUDFLARE_API_TOKEN");
      expect(err.message).toContain("CLOUDFLARE_API_TOKEN");
    }
  });

  test("missing CLOUDFLARE_ACCOUNT_ID produces an error naming that variable", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_ACCOUNT_ID;

    try {
      validateEnv("deploy");
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(err.message).toContain("CLOUDFLARE_ACCOUNT_ID");
    }
  });

  test("missing CLOUDFLARE_ZONE_ID produces an error naming that variable", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_ZONE_ID;

    try {
      validateEnv("deploy");
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.missing).toContain("CLOUDFLARE_ZONE_ID");
      expect(err.message).toContain("CLOUDFLARE_ZONE_ID");
    }
  });

  test("missing CLOUDFLARE_TUNNEL_TOKEN produces an error when context is 'up'", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

    try {
      validateEnv("up");
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.missing).toContain("CLOUDFLARE_TUNNEL_TOKEN");
      expect(err.message).toContain("CLOUDFLARE_TUNNEL_TOKEN");
    }
  });

  test("missing CLOUDFLARE_TUNNEL_TOKEN does NOT produce an error when context is 'deploy'", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

    // Should succeed — tunnel token is not required for deploy
    const creds = validateEnv("deploy");
    expect(creds.apiToken).toBe("test-api-token");
    expect(creds.tunnelToken).toBeUndefined();
  });

  test("missing CLOUDFLARE_TUNNEL_TOKEN does NOT produce an error when context is 'sync'", () => {
    setAllEnv();
    delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

    const creds = validateEnv("sync");
    expect(creds.apiToken).toBe("test-api-token");
    expect(creds.tunnelToken).toBeUndefined();
  });

  test("multiple missing variables are all listed in a single error message", () => {
    clearEnv();
    // Set only API token — account ID and zone ID are missing
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";

    try {
      validateEnv("deploy");
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.missing).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(err.missing).toContain("CLOUDFLARE_ZONE_ID");
      expect(err.missing.length).toBe(2);
      // Both should be in the single error message
      expect(err.message).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(err.message).toContain("CLOUDFLARE_ZONE_ID");
    }
  });

  test("when no .env file exists and no variables are set, error suggests 'flaregun setup'", () => {
    clearEnv();

    try {
      validateEnv("deploy", false);
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.message).toContain("flaregun setup");
    }
  });

  test("when no .env file exists but some variables are set, error does not suggest 'flaregun setup'", () => {
    clearEnv();
    process.env.CLOUDFLARE_API_TOKEN = "test-api-token";

    try {
      validateEnv("deploy", false);
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      // Should NOT suggest setup since some vars are partially configured
      expect(err.message).not.toContain("flaregun setup");
    }
  });

  test("when .env file exists, error suggests checking the .env file", () => {
    clearEnv();

    try {
      validateEnv("deploy", true);
      throw new Error("Expected EnvValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const err = e as EnvValidationError;
      expect(err.message).toContain(".env");
    }
  });
});

// --- .env File Loading Tests ---

describe("env file loading", () => {
  beforeEach(() => {
    saveEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  test("variables from a .env file are loaded and available for validation", () => {
    clearEnv();
    const tmpDir = makeTmpDir();
    const configPath = join(tmpDir, "flaregun.yml");
    writeFileSync(configPath, "domain: example.com\n");

    const envContent = `
CLOUDFLARE_API_TOKEN=file-api-token
CLOUDFLARE_ACCOUNT_ID=file-account-id
CLOUDFLARE_ZONE_ID=file-zone-id
CLOUDFLARE_TUNNEL_TOKEN=file-tunnel-token
`;
    writeFileSync(join(tmpDir, ".env"), envContent);

    try {
      const loaded = loadEnvFile(configPath);
      expect(loaded).toBe(true);

      const creds = validateEnv("up", loaded);
      expect(creds.apiToken).toBe("file-api-token");
      expect(creds.accountId).toBe("file-account-id");
      expect(creds.zoneId).toBe("file-zone-id");
      expect(creds.tunnelToken).toBe("file-tunnel-token");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("existing process.env values take precedence over .env file values", () => {
    clearEnv();
    process.env.CLOUDFLARE_API_TOKEN = "env-api-token";

    const tmpDir = makeTmpDir();
    const configPath = join(tmpDir, "flaregun.yml");
    writeFileSync(configPath, "domain: example.com\n");

    const envContent = `
CLOUDFLARE_API_TOKEN=file-api-token
CLOUDFLARE_ACCOUNT_ID=file-account-id
CLOUDFLARE_ZONE_ID=file-zone-id
`;
    writeFileSync(join(tmpDir, ".env"), envContent);

    try {
      loadEnvFile(configPath);

      // process.env value should win
      expect(process.env.CLOUDFLARE_API_TOKEN).toBe("env-api-token");
      // .env values should be loaded for missing keys
      expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("file-account-id");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadEnvFile returns false when no .env file exists", () => {
    const tmpDir = makeTmpDir();
    const configPath = join(tmpDir, "flaregun.yml");
    writeFileSync(configPath, "domain: example.com\n");

    try {
      const loaded = loadEnvFile(configPath);
      expect(loaded).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test(".env file handles comments, empty lines, and quoted values", () => {
    clearEnv();
    const tmpDir = makeTmpDir();
    const configPath = join(tmpDir, "flaregun.yml");
    writeFileSync(configPath, "domain: example.com\n");

    const envContent = `
# This is a comment
CLOUDFLARE_API_TOKEN="quoted-token"
CLOUDFLARE_ACCOUNT_ID='single-quoted-id'

CLOUDFLARE_ZONE_ID=unquoted-zone-id
# Another comment
`;
    writeFileSync(join(tmpDir, ".env"), envContent);

    try {
      loadEnvFile(configPath);

      expect(process.env.CLOUDFLARE_API_TOKEN).toBe("quoted-token");
      expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe("single-quoted-id");
      expect(process.env.CLOUDFLARE_ZONE_ID).toBe("unquoted-zone-id");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loadAndValidateEnv combines loading and validation", () => {
    clearEnv();
    const tmpDir = makeTmpDir();
    const configPath = join(tmpDir, "flaregun.yml");
    writeFileSync(configPath, "domain: example.com\n");

    const envContent = `
CLOUDFLARE_API_TOKEN=combined-api-token
CLOUDFLARE_ACCOUNT_ID=combined-account-id
CLOUDFLARE_ZONE_ID=combined-zone-id
`;
    writeFileSync(join(tmpDir, ".env"), envContent);

    try {
      const creds = loadAndValidateEnv(configPath, "deploy");
      expect(creds.apiToken).toBe("combined-api-token");
      expect(creds.accountId).toBe("combined-account-id");
      expect(creds.zoneId).toBe("combined-zone-id");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
