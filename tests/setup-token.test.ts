import { describe, expect, test } from "bun:test";
import { buildPolicies, selectPermissionGroups, WANTED_PERMISSIONS } from "../src/setup/token.js";
import { PERMISSION_GROUPS } from "./helpers/setup-fakes.js";

describe("selectPermissionGroups", () => {
  test("finds every wanted permission in Cloudflare's list", () => {
    const { missing, byScope } = selectPermissionGroups(PERMISSION_GROUPS);
    expect(missing).toEqual([]);
    const count = [...byScope.values()].reduce((n, list) => n + list.length, 0);
    expect(count).toBe(WANTED_PERMISSIONS.length);
  });

  test("never picks the read-only group when write access is wanted", () => {
    const { byScope } = selectPermissionGroups(PERMISSION_GROUPS);
    const ids = [...byScope.values()].flat().map((s) => s.group.id);
    expect(ids).toContain("pg-tunnel");
    expect(ids).not.toContain("pg-tunnel-read");
  });

  test("accepts the dashboard's 'Edit' names and older alternative names", () => {
    const { byScope, missing } = selectPermissionGroups([
      { id: "a", name: "Cloudflare Tunnel Edit", scopes: ["com.cloudflare.api.account"] },
      { id: "b", name: "Dynamic URL Redirects Write", scopes: ["com.cloudflare.api.account.zone"] },
    ]);
    expect(byScope.get("com.cloudflare.api.account")?.map((s) => s.group.id)).toEqual(["a"]);
    expect(byScope.get("com.cloudflare.api.account.zone")?.map((s) => s.group.id)).toEqual(["b"]);
    expect(missing.map((m) => m.names[0])).not.toContain("Cloudflare Tunnel");
  });

  test("reports permissions Cloudflare doesn't offer", () => {
    const { missing } = selectPermissionGroups(PERMISSION_GROUPS.filter((g) => g.id !== "pg-d1"));
    expect(missing.map((m) => m.why)).toEqual(["create D1 databases"]);
  });
});

describe("buildPolicies", () => {
  test("leaves user permissions out when the user ID is unknown", () => {
    const policies = buildPolicies(selectPermissionGroups(PERMISSION_GROUPS), null);
    const resources = policies.map((p) => Object.keys(p.resources)[0]);
    expect(resources).toEqual(["com.cloudflare.api.account.*", "com.cloudflare.api.account.zone.*"]);
  });
});
