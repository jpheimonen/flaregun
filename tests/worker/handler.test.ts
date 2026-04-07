import { describe, test, expect } from "bun:test";
import { handleRequest } from "../../src/worker/handler.js";

// --- Test constants ---

const TEST_DOMAIN = "example.com";
const TEST_DOWN_HTML = `<!DOCTYPE html>
<html><head><title>Offline — example.com</title></head>
<body><h1>This site is currently offline</h1></body></html>`;

// --- Test helpers ---

/** Creates a Request for the given URL with an optional method. */
function makeRequest(url: string, method = "GET"): Request {
  return new Request(url, { method });
}

/** Returns a mock origin fetch that resolves with the given response. */
function mockOrigin(response: Response): (req: Request) => Promise<Response> {
  return async () => response;
}

/** Returns a mock origin fetch that throws a network error. */
function mockOriginNetworkError(
  message = "Connection refused",
): (req: Request) => Promise<Response> {
  return async () => {
    throw new TypeError(message);
  };
}

/**
 * Returns a mock origin fetch that passes the request through,
 * tracking that it was called (for verifying pass-through behavior).
 */
function mockOriginPassthrough(): {
  fetch: (req: Request) => Promise<Response>;
  calls: Request[];
} {
  const calls: Request[] = [];
  return {
    fetch: async (req: Request) => {
      calls.push(req);
      return new Response("origin content", { status: 200 });
    },
    calls,
  };
}

// --- Pass-through behavior tests ---

describe("Worker handler: pass-through behavior", () => {
  test("origin 200 response is passed through with same body and status", async () => {
    const originBody = "<html><body>Hello from origin</body></html>";
    const originResponse = new Response(originBody, {
      status: 200,
      headers: { "Content-Type": "text/html", "X-Custom": "test-value" },
    });

    const response = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(originBody);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Custom")).toBe("test-value");
  });

  test("origin 301 redirect is passed through unmodified", async () => {
    const originResponse = new Response(null, {
      status: 301,
      headers: { Location: "https://other.example.com/" },
    });

    const response = await handleRequest(
      makeRequest("https://app.example.com/old-path"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(
      "https://other.example.com/",
    );
  });

  test("origin 302 redirect is passed through unmodified", async () => {
    const originResponse = new Response(null, {
      status: 302,
      headers: { Location: "https://app.example.com/login" },
    });

    const response = await handleRequest(
      makeRequest("https://app.example.com/dashboard"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://app.example.com/login",
    );
  });

  test("origin 404 response is passed through (not a server error)", async () => {
    const originResponse = new Response("Not Found", { status: 404 });

    const response = await handleRequest(
      makeRequest("https://admin.example.com/missing"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});

// --- Offline fallback tests ---

describe("Worker handler: offline fallback", () => {
  test("origin 502 status triggers redirect to down.example.com", async () => {
    const originResponse = new Response("Bad Gateway", { status: 502 });

    const response = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });

  test("origin 503 status triggers redirect to down.example.com", async () => {
    const originResponse = new Response("Service Unavailable", { status: 503 });

    const response = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });

  test("origin 523 status triggers redirect to down.example.com", async () => {
    const originResponse = new Response("Origin Unreachable", { status: 523 });

    const response = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });

  test("network error (dead tunnel) triggers redirect to down.example.com", async () => {
    const response = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError("Failed to connect"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });
});

// --- Down page serving tests ---

describe("Worker handler: down page serving", () => {
  test("down.example.com serves inline HTML with 200 status", async () => {
    const response = await handleRequest(
      makeRequest("https://down.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError("should not be called"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  test("down page returns the embedded HTML content", async () => {
    const response = await handleRequest(
      makeRequest("https://down.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError(),
    );

    const html = await response.text();
    expect(html).toBe(TEST_DOWN_HTML);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("offline");
  });

  test("down page does not fetch from origin", async () => {
    const tracker = mockOriginPassthrough();

    await handleRequest(
      makeRequest("https://down.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      tracker.fetch,
    );

    expect(tracker.calls).toHaveLength(0);
  });

  test("down.example.com with a path still serves the down page", async () => {
    const response = await handleRequest(
      makeRequest("https://down.example.com/some/path"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
  });
});

// --- Route safety tests ---

describe("Worker handler: route safety", () => {
  test("www.example.com passes through to origin without interference", async () => {
    const tracker = mockOriginPassthrough();

    const response = await handleRequest(
      makeRequest("https://www.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      tracker.fetch,
    );

    expect(tracker.calls).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("origin content");
  });

  test("www.example.com with a path passes through to origin", async () => {
    const tracker = mockOriginPassthrough();

    await handleRequest(
      makeRequest("https://www.example.com/some/page"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      tracker.fetch,
    );

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].url).toBe("https://www.example.com/some/page");
  });

  test("bare domain example.com passes through without interference", async () => {
    const tracker = mockOriginPassthrough();

    const response = await handleRequest(
      makeRequest("https://example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      tracker.fetch,
    );

    expect(tracker.calls).toHaveLength(1);
    expect(response.status).toBe(200);
  });

  test("www.example.com is NOT redirected even when origin returns 502", async () => {
    const originResponse = new Response("Bad Gateway", { status: 502 });

    const response = await handleRequest(
      makeRequest("https://www.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    // Should pass through the 502, not redirect
    expect(response.status).toBe(502);
  });

  test("bare domain example.com is NOT redirected even when origin returns 502", async () => {
    const originResponse = new Response("Bad Gateway", { status: 502 });

    const response = await handleRequest(
      makeRequest("https://example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(originResponse),
    );

    // Should pass through the 502, not redirect
    expect(response.status).toBe(502);
  });
});

// --- Unified failure handling tests ---

describe("Worker handler: unified failure handling", () => {
  test("unknown subdomain with unreachable origin redirects to down.example.com", async () => {
    const response = await handleRequest(
      makeRequest("https://nonexistent.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError("Connection refused"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });

  test("unknown subdomain with 502 origin redirects to down.example.com", async () => {
    const response = await handleRequest(
      makeRequest("https://doesnotexist.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOrigin(new Response("Bad Gateway", { status: 502 })),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://down.example.com",
    );
  });

  test("configured-but-down service and unconfigured subdomain produce identical behavior", async () => {
    const knownServiceResponse = await handleRequest(
      makeRequest("https://admin.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError(),
    );

    const unknownSubdomainResponse = await handleRequest(
      makeRequest("https://random.example.com/"),
      TEST_DOMAIN,
      TEST_DOWN_HTML,
      mockOriginNetworkError(),
    );

    // Both should produce the same redirect
    expect(knownServiceResponse.status).toBe(unknownSubdomainResponse.status);
    expect(knownServiceResponse.headers.get("Location")).toBe(
      unknownSubdomainResponse.headers.get("Location"),
    );
  });
});

// --- Domain parameterization test ---

describe("Worker handler: domain parameterization", () => {
  test("handler works with any domain, not just example.com", async () => {
    const domain = "my-site.io";
    const html = "<html><body>Offline</body></html>";

    // Down page uses the provided domain
    const downResponse = await handleRequest(
      makeRequest("https://down.my-site.io/"),
      domain,
      html,
      mockOriginNetworkError(),
    );
    expect(downResponse.status).toBe(200);
    expect(await downResponse.text()).toBe(html);

    // 5xx redirects to the correct down URL
    const failResponse = await handleRequest(
      makeRequest("https://app.my-site.io/"),
      domain,
      html,
      mockOrigin(new Response("Bad Gateway", { status: 502 })),
    );
    expect(failResponse.status).toBe(302);
    expect(failResponse.headers.get("Location")).toBe(
      "https://down.my-site.io",
    );

    // Bare domain passthrough
    const tracker = mockOriginPassthrough();
    await handleRequest(
      makeRequest("https://my-site.io/"),
      domain,
      html,
      tracker.fetch,
    );
    expect(tracker.calls).toHaveLength(1);
  });
});
