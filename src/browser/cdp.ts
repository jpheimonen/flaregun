/**
 * A small Chrome DevTools Protocol client.
 *
 * Flaregun only needs a few things from the browser: open a tab, run a snippet
 * of JavaScript in it, and close it. That fits in a thin wrapper around the
 * browser's DevTools WebSocket, so there is no browser-automation dependency.
 */

/** Raised when the browser refuses or drops the DevTools connection. */
export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.onClose());
  }

  /**
   * Connects to a browser's DevTools WebSocket. Chrome-family browsers ask the
   * person to allow the connection, so the timeout should leave time for that.
   */
  static connect(endpoint: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        ws.close();
        reject(new CdpError("The browser did not accept the connection in time."));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError("The browser refused the connection."));
      });
    });
  }

  /** Sends a protocol command and resolves with its result. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) {
      return Promise.reject(new CdpError("The browser connection is closed."));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  private onMessage(data: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.id === undefined) return; // protocol events are not used
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new CdpError(message.error.message ?? "DevTools command failed"));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(new CdpError("The browser closed the connection."));
    }
    this.pending.clear();
  }
}

/** A browser tab that flaregun opened and controls. */
export class BrowserTab {
  private constructor(
    private conn: CdpConnection,
    readonly targetId: string,
    private sessionId: string,
  ) {}

  /** Opens a new tab at the URL, brings it to the front and attaches to it. */
  static async open(conn: CdpConnection, url: string): Promise<BrowserTab> {
    const { targetId } = await conn.send("Target.createTarget", { url });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new BrowserTab(conn, targetId, sessionId);
    await tab.bringToFront();
    return tab;
  }

  async navigate(url: string): Promise<void> {
    await this.conn.send("Page.navigate", { url }, this.sessionId);
  }

  async bringToFront(): Promise<void> {
    await this.conn.send("Target.activateTarget", { targetId: this.targetId });
  }

  /**
   * Runs a JavaScript expression in the page and returns its JSON value.
   * Promises are awaited.
   */
  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.conn.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
    );
    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
      throw new CdpError(`Page script failed: ${description}`);
    }
    return response.result?.value as T;
  }

  /**
   * Re-runs the expression until it returns a truthy value or the time runs out.
   * Script errors while the page is loading count as "not yet".
   */
  async waitFor<T>(expression: string, timeoutMs: number, intervalMs = 500): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        const value = await this.evaluate<T>(expression);
        if (value) return value;
      } catch (err) {
        if (err instanceof CdpError && /closed/.test(err.message)) throw err;
      }
      if (Date.now() >= deadline) return null;
      await Bun.sleep(intervalMs);
    }
  }

  async close(): Promise<void> {
    await this.conn.send("Target.closeTarget", { targetId: this.targetId });
  }
}
