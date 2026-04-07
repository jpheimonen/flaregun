import { describe, test, expect } from "bun:test";
import { resourceName } from "../src/naming.js";

describe("resourceName", () => {
  test("produces a valid resource name from domain and service name", () => {
    const name = resourceName("example.com", "blog");
    expect(name).toBe("example-com-blog");
  });

  test("different services on the same domain produce distinct names", () => {
    const name1 = resourceName("example.com", "blog");
    const name2 = resourceName("example.com", "api");
    expect(name1).not.toBe(name2);
    expect(name1).toBe("example-com-blog");
    expect(name2).toBe("example-com-api");
  });

  test("the same domain and service always produce the same name (deterministic)", () => {
    const name1 = resourceName("example.com", "blog");
    const name2 = resourceName("example.com", "blog");
    expect(name1).toBe(name2);
  });

  test("dots in domain names are replaced with hyphens", () => {
    const name = resourceName("my.cool.site", "api");
    expect(name).toBe("my-cool-site-api");
  });

  test("generated names are all lowercase", () => {
    const name = resourceName("Example.COM", "Blog");
    expect(name).toBe("example-com-blog");
  });

  test("generated names satisfy R2 bucket naming constraints", () => {
    const name = resourceName("example.com", "my-service");

    // Must be lowercase, hyphens, and alphanumeric only
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

    // Must be between 3 and 63 characters
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("long names are truncated to 63 characters", () => {
    const longDomain = "a".repeat(30) + ".com";
    const longService = "b".repeat(30);
    const name = resourceName(longDomain, longService);
    expect(name.length).toBeLessThanOrEqual(63);
  });

  test("truncation does not leave a trailing hyphen", () => {
    // Create a name that would end with a hyphen when truncated at 63
    const domain = "a".repeat(30) + ".b";
    const service = "c".repeat(30);
    const name = resourceName(domain, service);
    expect(name.endsWith("-")).toBe(false);
  });

  test("invalid characters are replaced with hyphens", () => {
    const name = resourceName("example.com", "my_service");
    // Underscores become hyphens
    expect(name).toBe("example-com-my-service");
  });

  test("consecutive hyphens are collapsed", () => {
    const name = resourceName("example..com", "blog");
    // Double dot becomes double hyphen, then collapsed
    expect(name).not.toContain("--");
  });

  test("does not start or end with a hyphen", () => {
    const name = resourceName("example.com", "blog");
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
  });
});
