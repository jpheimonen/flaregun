/**
 * Mock Cloudflare SDK client for testing sync logic without real API calls.
 *
 * Provides call tracking, in-memory state stores, and state manipulation methods.
 * Designed to be extended by future sync steps (tunnel, DNS, redirect, resources).
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

  // State stores
  let apps: MockApp[] = [];
  let policies: Record<string, MockPolicy[]> = {}; // keyed by app ID

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
              id: `app-${params.name}-${++idCounter}`,
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
                id: `policy-${params.name}-${++idCounter}`,
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
  };
}

/** Type for the mock client instance returned by createMockClient */
export type MockClientInstance = ReturnType<typeof createMockClient>;

/** Type for the mock client's "client" property (the SDK substitute) */
export type MockSDKClient = MockClientInstance["client"];
