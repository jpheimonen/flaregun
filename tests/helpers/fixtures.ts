/**
 * Test fixtures for flaregun sync engine tests.
 *
 * Provides helpers to build valid config objects with sensible defaults
 * and support for overriding specific fields.
 */

import type {
  FlaregunConfig,
  ServiceConfig,
  AuthMode,
  ServiceType,
} from "../../src/config/index.js";

// --- Test constants ---

export const TEST_ACCOUNT_ID = "test-account-id";
export const TEST_TUNNEL_ID = "test-tunnel-id";
export const TEST_ZONE_ID = "test-zone-id";

// --- Config factory ---

/**
 * Creates a valid FlaregunConfig with sensible defaults.
 * Override any field to customize for specific test scenarios.
 *
 * Default config has:
 * - domain: "example.com"
 * - superusers: ["admin@example.com"]
 * - one Pages service "blog" with admin_only auth
 */
export function makeConfig(overrides?: {
  domain?: string;
  superusers?: string[];
  services?: Record<string, ServiceConfig>;
}): FlaregunConfig {
  return {
    domain: overrides?.domain ?? "example.com",
    auth: {
      provider: "google",
      superusers: overrides?.superusers ?? ["admin@example.com"],
    },
    services: overrides?.services ?? {
      blog: pagesService("blog", "admin_only"),
    },
  };
}

// --- Service config helpers ---

/**
 * Creates a Pages service config with defaults.
 * Useful for building test configs with minimal boilerplate.
 */
export function pagesService(
  subdomain: string,
  auth: AuthMode = "admin_only",
  extra?: Partial<ServiceConfig>,
): ServiceConfig {
  return {
    subdomain,
    type: "pages" as ServiceType,
    auth,
    dist: "dist/",
    functions: "functions/",
    ...extra,
  };
}

/**
 * Creates a local service config with defaults.
 * Useful for building test configs with minimal boilerplate.
 */
export function localService(
  subdomain: string,
  port: number,
  auth: AuthMode = "admin_only",
  extra?: Partial<ServiceConfig>,
): ServiceConfig {
  return {
    subdomain,
    type: "local" as ServiceType,
    auth,
    command: "node server.js",
    port,
    ...extra,
  };
}
