import { afterEach, describe, expect, test } from "bun:test";
import { BrowserTab, CdpConnection, CdpError } from "../../src/browser/cdp.js";

/** A fake browser endpoint that answers DevTools commands with `respond`. */
function fakeBrowser(respond: (msg: any) => any) {
  const received: any[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const msg = JSON.parse(String(data));
        received.push(msg);
        const reply = respond(msg);
        if (reply !== undefined) ws.send(JSON.stringify({ id: msg.id, ...reply }));
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/devtools/browser/x`, received, server };
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("CdpConnection and BrowserTab", () => {
  test("opens a tab, attaches with a session and evaluates in it", async () => {
    const browser = fakeBrowser((msg) => {
      switch (msg.method) {
        case "Target.createTarget":
          return { result: { targetId: "T1" } };
        case "Target.attachToTarget":
          return { result: { sessionId: "S1" } };
        case "Runtime.evaluate":
          return { result: { result: { value: 42 } } };
        default:
          return { result: {} };
      }
    });
    stop = () => browser.server.stop(true);

    const conn = await CdpConnection.connect(browser.url, 2000);
    const tab = await BrowserTab.open(conn, "https://example.com");
    expect(await tab.evaluate<number>("6 * 7")).toBe(42);
    conn.close();

    const methods = browser.received.map((m) => m.method);
    expect(methods).toEqual(["Target.createTarget", "Target.attachToTarget", "Target.activateTarget", "Runtime.evaluate"]);
    expect(browser.received[1].params).toEqual({ targetId: "T1", flatten: true });
    expect(browser.received[3].sessionId).toBe("S1");
    expect(browser.received[3].params).toMatchObject({ returnByValue: true, awaitPromise: true });
  });

  test("protocol errors and page exceptions become CdpErrors", async () => {
    const browser = fakeBrowser((msg) => {
      if (msg.method === "Target.createTarget") return { result: { targetId: "T1" } };
      if (msg.method === "Target.attachToTarget") return { result: { sessionId: "S1" } };
      if (msg.method === "Runtime.evaluate") {
        return { result: { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x" } } } };
      }
      if (msg.method === "Page.navigate") return { error: { message: "Cannot navigate" } };
      return { result: {} };
    });
    stop = () => browser.server.stop(true);

    const conn = await CdpConnection.connect(browser.url, 2000);
    const tab = await BrowserTab.open(conn, "about:blank");
    await expect(tab.evaluate("x")).rejects.toThrow("ReferenceError: x");
    await expect(tab.navigate("bad")).rejects.toBeInstanceOf(CdpError);
    conn.close();
  });

  test("pending commands fail when the browser goes away", async () => {
    const browser = fakeBrowser(() => undefined); // never answers
    stop = () => browser.server.stop(true);

    const conn = await CdpConnection.connect(browser.url, 2000);
    const pending = conn.send("Target.getTargets");
    await Bun.sleep(50);
    browser.server.stop(true);
    await expect(pending).rejects.toThrow("closed");
  });

  test("a refused connection is reported", async () => {
    await expect(CdpConnection.connect("ws://127.0.0.1:1/devtools/browser/x", 2000)).rejects.toBeInstanceOf(CdpError);
  });
});
