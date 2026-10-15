/**
 * Fakes for setup tests: an in-memory Cloudflare account that behaves like the
 * parts of the API setup uses, a scripted terminal and a scripted dashboard.
 */

import type { CloudflareClient } from "../../src/cloudflare/index.js";
import type { Dashboard } from "../../src/setup/dashboard.js";
import type { SetupIO } from "../../src/setup/io.js";

/** Permission groups as /user/tokens/permission_groups returns them (a realistic subset). */
export const PERMISSION_GROUPS = [
  { id: "pg-tunnel", name: "Cloudflare Tunnel Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-tunnel-read", name: "Cloudflare Tunnel Read", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-access-apps", name: "Access: Apps and Policies Write", scopes: ["com.cloudflare.api.account"] },
  {
    id: "pg-access-org",
    name: "Access: Organizations, Identity Providers, and Groups Write",
    scopes: ["com.cloudflare.api.account"],
  },
  { id: "pg-account-settings", name: "Account Settings Read", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-zone", name: "Zone Read", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "pg-dns", name: "DNS Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "pg-redirect", name: "Single Redirect Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "pg-pages", name: "Pages Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-scripts", name: "Workers Scripts Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-routes", name: "Workers Routes Write", scopes: ["com.cloudflare.api.account.zone"] },
  { id: "pg-d1", name: "D1 Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-r2", name: "Workers R2 Storage Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-kv", name: "Workers KV Storage Write", scopes: ["com.cloudflare.api.account"] },
  { id: "pg-user", name: "User Details Read", scopes: ["com.cloudflare.api.user"] },
  { id: "pg-memberships", name: "Memberships Read", scopes: ["com.cloudflare.api.user"] },
];

const iterate = <T>(items: T[]) => ({
  async *[Symbol.asyncIterator]() {
    yield* items;
  },
});

interface FakeToken {
  id: string;
  /** "bootstrap" tokens can create tokens; "full" tokens can manage resources. */
  kind: "bootstrap" | "full";
}

export class FakeCloudflare {
  userId = "user-tag-1";
  email = "me@example.com";
  tokens = new Map<string, FakeToken>();
  accounts = [{ id: "acct-1", name: "My Account" }];
  zones: Record<string, Array<{ id: string; name: string }>> = {
    "acct-1": [{ id: "zone-1", name: "example.com" }],
  };
  organizations = new Map<string, { name: string; auth_domain: string }>();
  /** When set, creating an organization through the API fails with this message. */
  organizationCreateError: string | null = null;
  takenTeamNames = new Set<string>();
  identityProviders = new Map<string, Array<{ type: string; name: string }>>();
  tunnels: Array<{ id: string; name: string; account: string; deleted_at?: string }> = [];
  createdTokens: Array<{ name: string; policies: unknown[] }> = [];
  deletedTokenIds: string[] = [];
  calls: string[] = [];
  private nextId = 1;

  addToken(value: string, kind: FakeToken["kind"]): string {
    const id = `token-id-${this.nextId++}`;
    this.tokens.set(value, { id, kind });
    return id;
  }

  client(value: string): CloudflareClient {
    const token = () => {
      const t = this.tokens.get(value);
      if (!t) throw new Error("Invalid API Token");
      return t;
    };
    const needs = (kind: FakeToken["kind"]) => {
      if (token().kind !== kind) throw new Error("Unauthorized to access requested resource");
    };
    const track = (call: string) => this.calls.push(call);

    const client = {
      user: {
        get: async () => {
          track("user.get");
          needs("full");
          return { email: this.email };
        },
        tokens: {
          verify: async () => {
            track("tokens.verify");
            return { id: token().id, status: "active" };
          },
          get: async (id: string) => {
            track("tokens.get");
            needs("bootstrap");
            return {
              id,
              policies: [{ resources: { [`com.cloudflare.api.user.${this.userId}`]: "*" } }],
            };
          },
          permissionGroups: {
            list: () => {
              track("permissionGroups.list");
              needs("bootstrap");
              return iterate(PERMISSION_GROUPS);
            },
          },
          create: async (body: { name: string; policies: unknown[] }) => {
            track("tokens.create");
            needs("bootstrap");
            this.createdTokens.push(body);
            const value = `flaregun-token-${this.createdTokens.length}`;
            this.addToken(value, "full");
            return { id: "new", value };
          },
          delete: async (id: string) => {
            track("tokens.delete");
            needs("bootstrap");
            this.deletedTokenIds.push(id);
            for (const [v, t] of this.tokens) if (t.id === id) this.tokens.delete(v);
            return { id };
          },
        },
      },
      accounts: {
        list: () => {
          track("accounts.list");
          needs("full");
          return iterate(this.accounts);
        },
      },
      zones: {
        list: (params: { account: { id: string } }) => {
          track("zones.list");
          needs("full");
          return iterate(this.zones[params.account.id] ?? []);
        },
      },
      zeroTrust: {
        organizations: {
          list: async ({ account_id }: { account_id: string }) => {
            track("organizations.list");
            const org = this.organizations.get(account_id);
            if (!org) throw new Error("access.api.error.not_found");
            return org;
          },
          create: async (p: { account_id: string; name: string; auth_domain: string }) => {
            track("organizations.create");
            if (this.organizationCreateError) throw new Error(this.organizationCreateError);
            if (this.takenTeamNames.has(p.name)) throw new Error("auth_domain already taken");
            this.organizations.set(p.account_id, { name: p.name, auth_domain: p.auth_domain });
            return p;
          },
        },
        identityProviders: {
          list: ({ account_id }: { account_id: string }) => {
            track("identityProviders.list");
            return iterate(this.identityProviders.get(account_id) ?? []);
          },
          create: async (p: { account_id: string; type: string; name: string }) => {
            track("identityProviders.create");
            this.identityProviders.set(p.account_id, [{ type: p.type, name: p.name }]);
            return p;
          },
        },
        tunnels: {
          cloudflared: {
            get: async (id: string, { account_id }: { account_id: string }) => {
              track("tunnels.get");
              const t = this.tunnels.find((x) => x.id === id && x.account === account_id);
              if (!t) throw new Error("tunnel not found");
              return { id: t.id, name: t.name, deleted_at: t.deleted_at ?? null };
            },
            list: (p: { account_id: string; name: string; is_deleted: boolean }) => {
              track("tunnels.list");
              return iterate(
                this.tunnels.filter((t) => t.account === p.account_id && t.name === p.name && !t.deleted_at),
              );
            },
            create: async (p: { account_id: string; name: string; config_src: string }) => {
              track("tunnels.create");
              const id = `tunnel-${this.tunnels.length + 1}`;
              this.tunnels.push({ id, name: p.name, account: p.account_id });
              return { id, name: p.name };
            },
            token: {
              get: async (id: string) => {
                track("tunnels.token.get");
                return `tunnel-token-for-${id}`;
              },
            },
          },
        },
      },
    };
    return client as unknown as CloudflareClient;
  }
}

/** A terminal that answers from a script and records everything printed. */
export function scriptedIO(answers: Array<string | number> = []) {
  const output: string[] = [];
  const questions: string[] = [];
  const queue = [...answers];
  const next = (question: string) => {
    questions.push(question);
    if (queue.length === 0) throw new Error(`No scripted answer for: ${question}`);
    return queue.shift()!;
  };

  const io: SetupIO = {
    print: (msg) => output.push(msg),
    prompt: async (question, defaultValue) => String(next(question)) || defaultValue || "",
    confirm: async (question, defaultYes = false) => {
      const answer = String(next(question));
      return answer ? answer.startsWith("y") : defaultYes;
    },
    choose: async (question, options) => {
      const answer = next(question);
      const index = typeof answer === "number" ? answer : options.indexOf(answer);
      if (index < 0) throw new Error(`"${answer}" is not one of ${options.join(", ")}`);
      return index;
    },
    waitUntil: async (message, check) => {
      output.push(message);
      for (let i = 0; i < 3; i++) {
        const value = await check();
        if (value) return value;
      }
      return null;
    },
    close: () => {},
  };
  return { io, output, questions, remaining: queue };
}

/** A dashboard that "creates" the given tokens in order. */
export function scriptedDashboard(tokens: string[], onOnboarding: () => void = () => {}) {
  const record = { bootstrapCalls: 0, onboardingShown: 0, closed: false };
  const dashboard: Dashboard = {
    async bootstrapToken(_io, accept) {
      record.bootstrapCalls++;
      for (const token of tokens) {
        if (await accept(token)) return token;
      }
      throw new Error("no scripted token was accepted");
    },
    async showZeroTrustOnboarding() {
      record.onboardingShown++;
      onOnboarding();
    },
    close() {
      record.closed = true;
    },
  };
  return { dashboard, record };
}
