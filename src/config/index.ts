import { load } from "js-yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// --- Types ---

/** Three-tier auth mode for services */
export type AuthMode = "admin_only" | "authorized" | "public";

/** Service type classification — inferred from properties, not set by user */
export type ServiceType = "pages" | "local";

export interface AuthConfig {
  provider: string;
  superusers: string[];
}

export interface ServiceConfig {
  subdomain: string;
  type: ServiceType;
  auth: AuthMode;
  users?: string[];
  // Pages fields
  dist?: string;
  build?: string;
  functions?: string;
  database?: boolean;
  bucket?: boolean;
  kv?: boolean;
  // Local fields
  command?: string;
  port?: number;
  max_retries?: number;
}

export interface FlaregunConfig {
  domain: string;
  auth: AuthConfig;
  down_page?: string;
  services: Record<string, ServiceConfig>;
}

// --- Access Selector Types ---

/** Cloudflare Access selector for an exact email address */
export interface EmailSelector {
  email: { email: string };
}

/** Cloudflare Access selector for an email domain wildcard */
export interface EmailDomainSelector {
  email_domain: { domain: string };
}

export type AccessSelector = EmailSelector | EmailDomainSelector;

// --- Config Diff Types ---

export interface ServiceDiff {
  /** Fields that affect runtime behavior (auth, users, port, command, max_retries) */
  runtime: string[];
  /** Fields specific to Pages services (dist, build, functions, database, bucket, kv) */
  pagesOnly: string[];
  /** Subdomain changes affect both runtime and deployment */
  subdomain: boolean;
}

export interface ConfigDiff {
  added: string[];
  removed: string[];
  modified: Map<string, ServiceDiff>;
  globalAuthChanged: boolean;
}

// --- Validation ---

export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Config validation failed:\n  - ${errors.join("\n  - ")}`);
    this.name = "ConfigValidationError";
  }
}

const RESERVED_SUBDOMAINS = ["admin", "down"];
const RUNTIME_FIELDS = ["auth", "users", "port", "command", "max_retries"];
const PAGES_ONLY_FIELDS = ["dist", "build", "functions", "database", "bucket", "kv"];

/**
 * Infers service type from its properties.
 * Returns the type or null if ambiguous/unrecognizable (with errors added).
 */
function inferServiceType(
  name: string,
  svc: Record<string, unknown>,
  errors: string[],
): ServiceType | null {
  const hasDist = "dist" in svc && svc.dist !== undefined;
  const hasCommand = "command" in svc && svc.command !== undefined;
  const hasPort = "port" in svc && svc.port !== undefined;
  const hasCommandOrPort = hasCommand || hasPort;

  if (hasDist && hasCommandOrPort) {
    errors.push(
      `Service "${name}" has both "dist" and "command"/"port" — ambiguous type (must be either Pages or local, not both)`,
    );
    return null;
  }

  if (hasDist) {
    return "pages";
  }

  if (hasCommand && hasPort) {
    return "local";
  }

  if (hasCommand || hasPort) {
    // Has one of command/port but not both — still local but will fail field validation
    return "local";
  }

  errors.push(
    `Service "${name}" has neither "dist" (Pages) nor "command"/"port" (local) — cannot determine service type`,
  );
  return null;
}

/** Validates individual service entries, checking required fields and uniqueness constraints. */
function validateServiceEntries(
  rawServices: Record<string, unknown>,
  errors: string[],
): void {
  const ports = new Map<number, string>();
  const subdomains = new Map<string, string>();

  for (const [name, rawSvc] of Object.entries(rawServices)) {
    const svc = rawSvc as Record<string, unknown>;

    if (!svc || typeof svc !== "object") {
      errors.push(`Service "${name}" must be an object`);
      continue;
    }

    // Subdomain validation
    if (!svc.subdomain || typeof svc.subdomain !== "string") {
      errors.push(`Service "${name}" is missing required field "subdomain"`);
    } else {
      const sub = svc.subdomain as string;

      // Reserved subdomain check
      if (RESERVED_SUBDOMAINS.includes(sub)) {
        errors.push(
          `Service "${name}" uses reserved subdomain "${sub}"`,
        );
      }

      // Duplicate subdomain check
      const existing = subdomains.get(sub);
      if (existing) {
        errors.push(
          `Services "${existing}" and "${name}" share the same subdomain "${sub}"`,
        );
      } else {
        subdomains.set(sub, name);
      }
    }

    // Infer service type
    const serviceType = inferServiceType(name, svc, errors);

    if (serviceType === "local") {
      // Local services require command and port
      if (!svc.command || typeof svc.command !== "string") {
        errors.push(`Service "${name}" is missing required field "command"`);
      }
      if (svc.port === undefined || svc.port === null || typeof svc.port !== "number") {
        errors.push(`Service "${name}" is missing required field "port"`);
      } else {
        const existing = ports.get(svc.port as number);
        if (existing) {
          errors.push(
            `Services "${existing}" and "${name}" share the same port ${svc.port}`,
          );
        } else {
          ports.set(svc.port as number, name);
        }
      }

      // Cloud resources are only valid on Pages services
      for (const field of ["database", "bucket", "kv"] as const) {
        if (field in svc && svc[field] !== undefined) {
          errors.push(
            `Service "${name}" is a local service and cannot use "${field}" (only Pages services support cloud resources)`,
          );
        }
      }
    }

    if (serviceType === "pages") {
      // max_retries is only valid on local services
      if ("max_retries" in svc && svc.max_retries !== undefined) {
        errors.push(
          `Service "${name}" is a Pages service and cannot use "max_retries" (only local services support max_retries)`,
        );
      }
    }

    // Auth + users validation
    const authMode = (svc.auth as AuthMode | undefined) ?? "admin_only";
    if (svc.users !== undefined && authMode !== "authorized") {
      errors.push(
        `Service "${name}" has a "users" list but auth is "${authMode}" (users are only allowed when auth is "authorized")`,
      );
    }
  }
}

/** Converts validated raw service entries into typed ServiceConfig records. */
function buildTypedServices(
  rawServices: Record<string, unknown>,
): Record<string, ServiceConfig> {
  const services: Record<string, ServiceConfig> = {};

  for (const [name, rawSvc] of Object.entries(rawServices)) {
    const svc = rawSvc as Record<string, unknown>;
    const hasDist = "dist" in svc && svc.dist !== undefined;
    const serviceType: ServiceType = hasDist ? "pages" : "local";
    const authMode: AuthMode = (svc.auth as AuthMode | undefined) ?? "admin_only";

    const config: ServiceConfig = {
      subdomain: svc.subdomain as string,
      type: serviceType,
      auth: authMode,
    };

    // Optional fields
    if (svc.users !== undefined) config.users = svc.users as string[];
    if (svc.dist !== undefined) config.dist = svc.dist as string;
    if (svc.build !== undefined) config.build = svc.build as string;
    if (svc.database !== undefined) config.database = svc.database as boolean;
    if (svc.bucket !== undefined) config.bucket = svc.bucket as boolean;
    if (svc.kv !== undefined) config.kv = svc.kv as boolean;
    if (svc.command !== undefined) config.command = svc.command as string;
    if (svc.port !== undefined) config.port = svc.port as number;
    if (svc.max_retries !== undefined) config.max_retries = svc.max_retries as number;

    // Functions defaults to "functions/" for Pages services when not specified
    if (serviceType === "pages") {
      config.functions = (svc.functions as string | undefined) ?? "functions/";
    } else if (svc.functions !== undefined) {
      config.functions = svc.functions as string;
    }

    services[name] = config;
  }

  return services;
}

/**
 * Validates a raw parsed YAML object and returns a typed FlaregunConfig.
 * Collects all errors eagerly before throwing.
 */
export function validateConfig(raw: unknown): FlaregunConfig {
  const errors: string[] = [];
  const obj = raw as Record<string, unknown>;

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new ConfigValidationError(["Config must be a YAML object"]);
  }

  // Top-level: domain
  if (!obj.domain || typeof obj.domain !== "string") {
    errors.push('Missing required field "domain"');
  }

  // Top-level: auth
  const rawAuth = obj.auth as Record<string, unknown> | undefined;
  if (!rawAuth || typeof rawAuth !== "object") {
    errors.push('Missing required field "auth"');
  } else {
    if (!rawAuth.provider || typeof rawAuth.provider !== "string") {
      errors.push('Missing required field "auth.provider"');
    }
    if (
      !rawAuth.superusers ||
      !Array.isArray(rawAuth.superusers) ||
      rawAuth.superusers.length === 0
    ) {
      errors.push(
        'Missing required field "auth.superusers" (must be a non-empty array)',
      );
    }
  }

  // Top-level: down_page (type validation only — file existence checked in loadConfig)
  if (obj.down_page !== undefined && typeof obj.down_page !== "string") {
    errors.push('"down_page" must be a string path');
  }

  // Services: optional section, but if present must be an object
  const rawServices = (obj.services ?? {}) as Record<string, unknown>;
  if (typeof rawServices !== "object" || Array.isArray(rawServices)) {
    errors.push('"services" must be an object mapping service names to definitions');
  } else {
    validateServiceEntries(rawServices, errors);
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  return {
    domain: obj.domain as string,
    auth: {
      provider: (rawAuth as Record<string, unknown>).provider as string,
      superusers: (rawAuth as Record<string, unknown>).superusers as string[],
    },
    down_page: obj.down_page as string | undefined,
    services: buildTypedServices(rawServices),
  };
}

// --- Config Loading ---

/**
 * Parses a YAML string into a validated FlaregunConfig object.
 * Pure string parser — no filesystem access. Primary entry point for tests.
 */
export function parseConfig(yaml: string): FlaregunConfig {
  const raw = load(yaml);
  return validateConfig(raw);
}

/**
 * Reads and parses flaregun.yml from the given path (or default location),
 * validates it, and returns a fully typed FlaregunConfig object.
 * Additionally validates filesystem-dependent constraints (e.g., down_page existence).
 */
export function loadConfig(configPath?: string): FlaregunConfig {
  const filePath = configPath ?? resolve(process.cwd(), "flaregun.yml");
  const content = readFileSync(filePath, "utf-8");
  const config = parseConfig(content);

  // Filesystem-dependent validations
  const errors: string[] = [];

  if (config.down_page) {
    const downPagePath = resolve(filePath, "..", config.down_page);
    if (!existsSync(downPagePath)) {
      errors.push(
        `"down_page" file does not exist: ${config.down_page}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new ConfigValidationError(errors);
  }

  return config;
}

// --- User List Utilities ---

/** Returns true if the entry is a wildcard (e.g., `*@company.com`) */
export function isWildcard(entry: string): boolean {
  return entry.startsWith("*@");
}

/** Returns true if the entry is an exact email (not a wildcard) */
export function isExactEmail(entry: string): boolean {
  return !entry.startsWith("*@");
}

/**
 * Extracts the domain from a wildcard entry, stripping the `*@` prefix.
 * E.g., `*@company.com` -> `company.com`
 */
export function extractWildcardDomain(entry: string): string {
  return entry.slice(2);
}

/**
 * Merges superusers with a service's per-app users list, deduplicating.
 * Returns a combined array with no duplicates.
 */
export function mergeUsers(
  superusers: string[],
  serviceUsers?: string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const user of superusers) {
    if (!seen.has(user)) {
      seen.add(user);
      merged.push(user);
    }
  }

  if (serviceUsers) {
    for (const user of serviceUsers) {
      if (!seen.has(user)) {
        seen.add(user);
        merged.push(user);
      }
    }
  }

  return merged;
}

/**
 * Transforms a list of user entries into Cloudflare Access selectors.
 * - Exact emails become `{ email: { email: "user@example.com" } }`
 * - Wildcards become `{ email_domain: { domain: "company.com" } }`
 */
export function toAccessSelectors(users: string[]): AccessSelector[] {
  return users.map((entry): AccessSelector => {
    if (isWildcard(entry)) {
      return { email_domain: { domain: extractWildcardDomain(entry) } };
    }
    return { email: { email: entry } };
  });
}

/**
 * Builds the full Cloudflare Access selector list for a service.
 * - `public` → empty array (no access restriction)
 * - `admin_only` → superusers only
 * - `authorized` → merged superusers + service users
 */
export function buildServiceSelectors(
  service: ServiceConfig,
  superusers: string[],
): AccessSelector[] {
  if (service.auth === "public") {
    return [];
  }

  if (service.auth === "admin_only") {
    return toAccessSelectors(superusers);
  }

  // authorized — merge superusers with service-specific users
  const merged = mergeUsers(superusers, service.users);
  return toAccessSelectors(merged);
}

// --- Config Diffing ---

/**
 * Compares two parsed config objects and produces a structured diff.
 * The diff makes it easy for the hot-reload engine to determine which actions to take.
 */
export function diffConfigs(
  oldConfig: FlaregunConfig,
  newConfig: FlaregunConfig,
): ConfigDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const modified = new Map<string, ServiceDiff>();

  // Detect added and modified services
  for (const [name, newSvc] of Object.entries(newConfig.services)) {
    const oldSvc = oldConfig.services[name];
    if (!oldSvc) {
      added.push(name);
      continue;
    }

    const diff = diffService(oldSvc, newSvc);
    if (diff) {
      modified.set(name, diff);
    }
  }

  // Detect removed services
  for (const name of Object.keys(oldConfig.services)) {
    if (!(name in newConfig.services)) {
      removed.push(name);
    }
  }

  // Detect global auth changes
  const globalAuthChanged = hasGlobalAuthChanged(oldConfig, newConfig);

  return { added, removed, modified, globalAuthChanged };
}

/** Compares two services and returns a ServiceDiff, or null if identical. */
function diffService(
  oldSvc: ServiceConfig,
  newSvc: ServiceConfig,
): ServiceDiff | null {
  const runtime: string[] = [];
  const pagesOnly: string[] = [];
  let subdomain = false;

  // Check subdomain
  if (oldSvc.subdomain !== newSvc.subdomain) {
    subdomain = true;
  }

  // Check runtime fields
  for (const field of RUNTIME_FIELDS) {
    const oldVal = (oldSvc as Record<string, unknown>)[field];
    const newVal = (newSvc as Record<string, unknown>)[field];
    if (!deepEqual(oldVal, newVal)) {
      runtime.push(field);
    }
  }

  // Check pages-only fields
  for (const field of PAGES_ONLY_FIELDS) {
    const oldVal = (oldSvc as Record<string, unknown>)[field];
    const newVal = (newSvc as Record<string, unknown>)[field];
    if (!deepEqual(oldVal, newVal)) {
      pagesOnly.push(field);
    }
  }

  if (runtime.length === 0 && pagesOnly.length === 0 && !subdomain) {
    return null;
  }

  return { runtime, pagesOnly, subdomain };
}

/** Checks if global auth settings changed between two configs. */
function hasGlobalAuthChanged(
  oldConfig: FlaregunConfig,
  newConfig: FlaregunConfig,
): boolean {
  if (oldConfig.auth.provider !== newConfig.auth.provider) {
    return true;
  }
  return !deepEqual(oldConfig.auth.superusers, newConfig.auth.superusers);
}

/** Deep equality check for primitives, arrays, and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) =>
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
    );
  }

  return false;
}
