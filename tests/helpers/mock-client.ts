/**
 * Mock Cloudflare SDK client for testing sync logic without real API calls.
 *
 * Provides call tracking, in-memory state stores, and state manipulation methods.
 * Supports: Access applications/policies, tunnel configuration, DNS records,
 * and redirect rulesets.
 */

// --- Mock types ---

/** Mock Access application */
export interface MockApp {
  id: string;
  name: string;
  domain: string;
  type: string;
}

/** Mock Access policy */
export interface MockPolicy {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
}

/** Mock DNS record */
export interface MockDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

/** Mock redirect rule */
export interface MockRedirectRule {
  id?: string;
  expression?: string;
  action?: string;
  description?: string;
  action_parameters?: unknown;
}

/** Mock redirect ruleset */
export interface MockRedirectRuleset {
  id: string;
  rules: MockRedirectRule[];
}

// --- Pagination helper ---

/** Creates a paginated async iterable result matching the Cloudflare SDK's pattern. */
export function mockPageResult<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const item of items) {
        yield item;
      }
    },
  };
}

// --- Mock client factory ---

/** Creates a mock Cloudflare SDK client with call tracking and in-memory state. */
export function createMockClient() {
  const calls: Record<string, unknown[][]> = {};
  let idCounter = 0;

  function track(method: string, ...args: unknown[]) {
    if (!calls[method]) calls[method] = [];
    calls[method].push(args);
  }

  function nextId(prefix: string): string {
    return `${prefix}-${++idCounter}`;
  }

  function nextCounter(): number {
    return ++idCounter;
  }

  // State stores
  let apps: MockApp[] = [];
  let policies: Record<string, MockPolicy[]> = {}; // keyed by app ID
  let tunnelConfig: unknown = null;
  let dnsRecords: MockDnsRecord[] = [];
  let redirectRuleset: MockRedirectRuleset | null = null;

  const client = {
    zeroTrust: {
      access: {
        applications: {
          list: (...args: unknown[]) => {
            track("applications.list", ...args);
            return mockPageResult(apps);
          },
          create: async (...args: unknown[]) => {
            track("applications.create", ...args);
            const params = args[0] as {
              name: string;
              domain: string;
              type: string;
            };
            const newApp: MockApp = {
              id: `app-${params.name}-${nextCounter()}`,
              name: params.name,
              domain: params.domain,
              type: params.type,
            };
            apps.push(newApp);
            return newApp;
          },
          update: async (...args: unknown[]) => {
            track("applications.update", ...args);
            return args[0];
          },
          delete: async (...args: unknown[]) => {
            track("applications.delete", ...args);
            const appId = args[0] as string;
            // Remove from in-memory store
            apps = apps.filter((a) => a.id !== appId);
            // Cascade: remove associated policies
            delete policies[appId];
          },
          policies: {
            list: (...args: unknown[]) => {
              track("policies.list", ...args);
              const appId = args[0] as string;
              return mockPageResult(policies[appId] ?? []);
            },
            create: async (...args: unknown[]) => {
              track("policies.create", ...args);
              const appId = args[0] as string;
              const params = args[1] as {
                name: string;
                decision: string;
                include: unknown[];
              };
              const newPolicy: MockPolicy = {
                id: `policy-${params.name}-${nextCounter()}`,
                name: params.name,
                decision: params.decision,
                include: params.include,
              };
              if (!policies[appId]) policies[appId] = [];
              policies[appId].push(newPolicy);
              return newPolicy;
            },
            update: async (...args: unknown[]) => {
              track("policies.update", ...args);
              const appId = args[0] as string;
              const policyId = args[1] as string;
              const params = args[2] as {
                name: string;
                decision: string;
                include: unknown[];
              };
              const appPolicies = policies[appId] ?? [];
              const idx = appPolicies.findIndex((p) => p.id === policyId);
              if (idx >= 0) {
                appPolicies[idx] = {
                  ...appPolicies[idx],
                  include: params.include,
                  decision: params.decision,
                };
              }
              return appPolicies[idx];
            },
            delete: async (...args: unknown[]) => {
              track("policies.delete", ...args);
              const appId = args[0] as string;
              const policyId = args[1] as string;
              if (policies[appId]) {
                policies[appId] = policies[appId].filter(
                  (p) => p.id !== policyId,
                );
              }
            },
          },
        },
      },
      tunnels: {
        cloudflared: {
          configurations: {
            update: async (...args: unknown[]) => {
              track("tunnelConfig.update", ...args);
              const tunnelId = args[0] as string;
              const params = args[1] as { config: unknown };
              tunnelConfig = { tunnelId, config: params.config };
              return tunnelConfig;
            },
          },
        },
      },
    },
    dns: {
      records: {
        list: (...args: unknown[]) => {
          track("dns.records.list", ...args);
          return mockPageResult([...dnsRecords]);
        },
        create: async (...args: unknown[]) => {
          track("dns.records.create", ...args);
          const params = args[0] as {
            name: string;
            type: string;
            content: string;
          };
          const newRecord: MockDnsRecord = {
            id: nextId("dns"),
            name: params.name,
            type: params.type,
            content: params.content,
          };
          dnsRecords.push(newRecord);
          return newRecord;
        },
        update: async (...args: unknown[]) => {
          track("dns.records.update", ...args);
          const recordId = args[0] as string;
          const params = args[1] as {
            name: string;
            type: string;
            content: string;
          };
          const idx = dnsRecords.findIndex((r) => r.id === recordId);
          if (idx >= 0) {
            dnsRecords[idx] = {
              ...dnsRecords[idx],
              name: params.name,
              type: params.type,
              content: params.content,
            };
          }
          return dnsRecords[idx];
        },
        delete: async (...args: unknown[]) => {
          track("dns.records.delete", ...args);
          const recordId = args[0] as string;
          dnsRecords = dnsRecords.filter((r) => r.id !== recordId);
        },
      },
    },
    rulesets: {
      phases: {
        get: async (...args: unknown[]) => {
          track("rulesets.phases.get", ...args);
          if (!redirectRuleset) {
            throw new Error("No ruleset found for phase");
          }
          return redirectRuleset;
        },
        update: async (...args: unknown[]) => {
          track("rulesets.phases.update", ...args);
          const params = args[1] as { rules: MockRedirectRule[] };
          if (!redirectRuleset) {
            redirectRuleset = {
              id: nextId("ruleset"),
              rules: [],
            };
          }
          // Assign IDs to rules that don't have them
          redirectRuleset.rules = params.rules.map((rule) => ({
            ...rule,
            id: rule.id ?? nextId("rule"),
          }));
          return redirectRuleset;
        },
      },
    },
  };

  return {
    client,
    calls,
    // State manipulation for test setup
    setApps: (a: MockApp[]) => {
      apps = a;
    },
    getApps: () => apps,
    setPolicies: (p: Record<string, MockPolicy[]>) => {
      policies = p;
    },
    getPolicies: () => policies,
    getCalls: (method: string) => calls[method] ?? [],
    // Tunnel state
    getTunnelConfig: () => tunnelConfig,
    // DNS state
    setDnsRecords: (records: MockDnsRecord[]) => {
      dnsRecords = records;
    },
    getDnsRecords: () => dnsRecords,
    // Redirect ruleset state
    setRedirectRuleset: (ruleset: MockRedirectRuleset | null) => {
      redirectRuleset = ruleset;
    },
    getRedirectRuleset: () => redirectRuleset,
  };
}

/** Type for the mock client instance returned by createMockClient */
export type MockClientInstance = ReturnType<typeof createMockClient>;

/** Type for the mock client's "client" property (the SDK substitute) */
export type MockSDKClient = MockClientInstance["client"];
