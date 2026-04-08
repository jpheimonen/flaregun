/**
 * Admin UI backend server.
 *
 * A Bun HTTP server that serves the admin dashboard SPA, provides REST
 * endpoints for config management and service control, and exposes a
 * WebSocket endpoint for real-time log streaming.
 *
 * The server relies on Cloudflare Access for authentication — it is only
 * reachable through the tunnel and the Access application with `admin_only`
 * policy ensures only superusers can access it.
 */

import { readFileSync, writeFileSync, statSync } from "fs";
import { join, extname, resolve } from "path";
import { parseConfig, ConfigValidationError } from "../config/index.js";
import type { FlaregunConfig } from "../config/index.js";
import type { LogEntry, LogSubscriber } from "../process/supervisor.js";
import type {
  AdminServerDeps,
  AdminServerOptions,
  LogSubscribeMessage,
  LogStreamMessage,
  LogHistoryMessage,
} from "./types.js";
import type { Server, ServerWebSocket } from "bun";

// --- MIME Types ---

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".map": "application/json",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// --- WebSocket Data ---

interface WSData {
  /** Current service subscription, or "__all__" for combined, or null if not subscribed */
  subscribedService: string | null;
  /** Unsubscribe function for the current subscription */
  unsubscribe: (() => void) | null;
}

// --- Admin Server ---

const DEFAULT_PREFERRED_PORT = 9100;
const DEFAULT_MAX_PORT_ATTEMPTS = 10;

export class AdminServer {
  private server: Server<WSData> | null = null;
  private deps: AdminServerDeps;
  private port: number = 0;

  constructor(deps: AdminServerDeps) {
    this.deps = deps;
  }

  /**
   * Start the HTTP/WebSocket server.
   * Attempts to bind to the preferred port, trying alternatives if unavailable.
   * Returns the port the server is listening on.
   */
  async start(options?: AdminServerOptions): Promise<number> {
    const preferredPort = options?.preferredPort ?? DEFAULT_PREFERRED_PORT;
    const maxAttempts = options?.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const portToTry = preferredPort + attempt;
      try {
        this.server = this.createServer(portToTry);
        this.port = this.server.port ?? portToTry;
        return this.port;
      } catch (err) {
        // Port in use — try next
        if (attempt === maxAttempts - 1) {
          throw new Error(
            `Failed to bind to any port in range ${preferredPort}-${preferredPort + maxAttempts - 1}`,
          );
        }
      }
    }

    // Should never reach here
    throw new Error("Failed to start admin server");
  }

  /** Gracefully shut down the server. */
  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  /** The port the server is listening on. 0 if not started. */
  get selectedPort(): number {
    return this.port;
  }

  private createServer(port: number): Server<WSData> {
    return Bun.serve({
      port,
      fetch: (req, server) => this.handleRequest(req, server),
      websocket: {
        open: (_ws: ServerWebSocket<WSData>) => {
          // Nothing to do on open — wait for subscribe message
        },
        message: (ws: ServerWebSocket<WSData>, message: string | Buffer) => {
          this.handleWebSocketMessage(ws, message);
        },
        close: (ws: ServerWebSocket<WSData>) => {
          this.cleanupWebSocket(ws);
        },
      },
    });
  }

  // --- Request Router ---

  private async handleRequest(req: Request, server: Server<WSData>): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // WebSocket upgrade for log streaming
    if (path === "/api/logs" && req.headers.get("upgrade") === "websocket") {
      const upgraded = server.upgrade(req, {
        data: { subscribedService: null, unsubscribe: null },
      });
      if (upgraded) {
        return undefined as unknown as Response;
      }
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // REST API endpoints
    if (path === "/api/config" && method === "GET") {
      return this.handleConfigRead();
    }
    if (path === "/api/config/validate" && method === "POST") {
      return this.handleConfigValidate(req);
    }
    if (path === "/api/config/save" && method === "POST") {
      return this.handleConfigSave(req);
    }
    if (path === "/api/services" && method === "GET") {
      return this.handleServiceList();
    }

    // Service restart: POST /api/services/:name/restart
    const restartMatch = path.match(/^\/api\/services\/([^/]+)\/restart$/);
    if (restartMatch && method === "POST") {
      return this.handleServiceRestart(restartMatch[1]);
    }

    // Service stop: POST /api/services/:name/stop
    const stopMatch = path.match(/^\/api\/services\/([^/]+)\/stop$/);
    if (stopMatch && method === "POST") {
      return this.handleServiceStop(stopMatch[1]);
    }

    // Static file serving
    return this.handleStaticFile(path);
  }

  // --- Config Endpoints ---

  private handleConfigRead(): Response {
    try {
      const content = readFileSync(this.deps.configPath, "utf-8");
      return Response.json({ success: true, content });
    } catch (err) {
      return Response.json(
        {
          success: false,
          error: `Failed to read config: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 500 },
      );
    }
  }

  private async handleConfigValidate(req: Request): Promise<Response> {
    const body = await req.json();
    const yaml = body.content;

    if (typeof yaml !== "string") {
      return Response.json(
        { success: false, errors: ["Request body must include a 'content' string field"] },
        { status: 400 },
      );
    }

    try {
      parseConfig(yaml);
      return Response.json({ success: true, errors: [] });
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        return Response.json({ success: false, errors: err.errors });
      }
      return Response.json(
        { success: false, errors: [err instanceof Error ? err.message : String(err)] },
        { status: 400 },
      );
    }
  }

  private async handleConfigSave(req: Request): Promise<Response> {
    const body = await req.json();
    const yaml = body.content;

    if (typeof yaml !== "string") {
      return Response.json(
        { success: false, errors: ["Request body must include a 'content' string field"] },
        { status: 400 },
      );
    }

    // 1. Validate the proposed config
    let newConfig: FlaregunConfig;
    try {
      newConfig = parseConfig(yaml);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        return Response.json({ success: false, errors: err.errors });
      }
      return Response.json(
        { success: false, errors: [err instanceof Error ? err.message : String(err)] },
        { status: 400 },
      );
    }

    // 2. Read the current config (for diffing)
    let oldConfig: FlaregunConfig;
    try {
      const oldYaml = readFileSync(this.deps.configPath, "utf-8");
      oldConfig = parseConfig(oldYaml);
    } catch {
      // If current config can't be read/parsed, treat it as empty for diffing purposes
      oldConfig = {
        domain: newConfig.domain,
        auth: newConfig.auth,
        services: {},
      };
    }

    // 3. Write the new config to disk
    writeFileSync(this.deps.configPath, yaml, "utf-8");

    // 4. Trigger hot-reload
    try {
      const result = await this.deps.hotReloadEngine.reload(
        oldConfig,
        newConfig,
        this.deps.cloudflareClient,
        this.deps.lockState,
        this.deps.supervisor,
      );
      return Response.json({
        success: true,
        reload: result,
      });
    } catch (err) {
      // Config was saved but hot-reload failed
      return Response.json({
        success: true,
        reload: {
          success: false,
          errors: [err instanceof Error ? err.message : String(err)],
          changes: [],
        },
      });
    }
  }

  // --- Service Endpoints ---

  private handleServiceList(): Response {
    const { supervisor, pagesServices } = this.deps;
    const states = supervisor.getAllServiceStates();

    const services: Array<Record<string, unknown>> = [];

    // Local services from the supervisor
    for (const [name, info] of states) {
      services.push({
        name,
        type: "local",
        state: info.state,
        runningSince: info.runningSince?.toISOString() ?? null,
        restartCount: info.restartCount,
        lastCrashReason: info.lastCrashReason,
      });
    }

    // Pages services from config/lock
    for (const ps of pagesServices) {
      services.push({
        name: ps.name,
        type: "pages",
        subdomain: ps.subdomain,
        deployed: ps.deployed,
      });
    }

    return Response.json({ success: true, services });
  }

  private async handleServiceRestart(name: string): Promise<Response> {
    const { supervisor, pagesServices } = this.deps;

    // Check if it's a Pages service (not restartable)
    if (pagesServices.some((ps) => ps.name === name)) {
      return Response.json(
        { success: false, error: `Service "${name}" is a Pages service and cannot be restarted` },
        { status: 400 },
      );
    }

    // Check if the service exists in the supervisor
    const state = supervisor.getServiceState(name);
    if (!state) {
      return Response.json(
        { success: false, error: `Service "${name}" not found` },
        { status: 404 },
      );
    }

    await supervisor.restartService(name);
    return Response.json({ success: true });
  }

  private async handleServiceStop(name: string): Promise<Response> {
    const { supervisor, pagesServices } = this.deps;

    // Check if it's a Pages service (not stoppable)
    if (pagesServices.some((ps) => ps.name === name)) {
      return Response.json(
        { success: false, error: `Service "${name}" is a Pages service and cannot be stopped` },
        { status: 400 },
      );
    }

    // Check if the service exists in the supervisor
    const state = supervisor.getServiceState(name);
    if (!state) {
      return Response.json(
        { success: false, error: `Service "${name}" not found` },
        { status: 404 },
      );
    }

    await supervisor.stopService(name);
    return Response.json({ success: true });
  }

  // --- Static File Serving ---

  private handleStaticFile(path: string): Response {
    const { spaDir } = this.deps;
    const resolvedSpaDir = resolve(spaDir);

    // Map root to index.html
    let filePath: string;
    if (path === "/") {
      filePath = join(resolvedSpaDir, "index.html");
    } else {
      filePath = resolve(join(resolvedSpaDir, path));
      // Prevent path traversal — resolved path must be within spaDir
      if (!filePath.startsWith(resolvedSpaDir + "/") && filePath !== resolvedSpaDir) {
        filePath = join(resolvedSpaDir, "index.html");
      }
    }

    // Try to serve the file
    try {
      const stat = statSync(filePath);
      if (stat.isFile()) {
        const content = readFileSync(filePath);
        const mimeType = getMimeType(filePath);
        return new Response(content, {
          headers: { "Content-Type": mimeType },
        });
      }
    } catch {
      // File not found — fall through to SPA fallback
    }

    // SPA fallback: return index.html for any unmatched route
    try {
      const indexPath = join(resolvedSpaDir, "index.html");
      const content = readFileSync(indexPath);
      return new Response(content, {
        headers: { "Content-Type": "text/html" },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  // --- WebSocket Handlers ---

  private handleWebSocketMessage(
    ws: ServerWebSocket<WSData>,
    message: string | Buffer,
  ): void {
    const { supervisor } = this.deps;

    let parsed: LogSubscribeMessage;
    try {
      const text = typeof message === "string" ? message : message.toString();
      parsed = JSON.parse(text);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (parsed.type !== "subscribe" || typeof parsed.service !== "string") {
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid subscribe message" }),
      );
      return;
    }

    // Clean up previous subscription if switching
    this.cleanupWebSocket(ws);

    const serviceName = parsed.service;
    const isAll = serviceName === "__all__";

    // Send log history
    const historyEntries: LogStreamMessage[] = [];
    if (isAll) {
      // Get history from all services
      for (const name of supervisor.serviceNames) {
        const buffer = supervisor.getLogBuffer(name);
        for (const entry of buffer) {
          historyEntries.push(logEntryToMessage(entry));
        }
      }
      // Sort by timestamp
      historyEntries.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    } else {
      const buffer = supervisor.getLogBuffer(serviceName);
      for (const entry of buffer) {
        historyEntries.push(logEntryToMessage(entry));
      }
    }

    const historyMsg: LogHistoryMessage = {
      type: "history",
      entries: historyEntries,
    };
    ws.send(JSON.stringify(historyMsg));

    // Subscribe to real-time logs
    const callback: LogSubscriber = (entry: LogEntry) => {
      const msg: LogStreamMessage = logEntryToMessage(entry);
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Client disconnected — will be cleaned up in close handler
      }
    };

    let unsubscribe: () => void;
    if (isAll) {
      unsubscribe = supervisor.subscribeToAllLogs(callback);
    } else {
      unsubscribe = supervisor.subscribeToLogs(serviceName, callback);
    }

    ws.data.subscribedService = serviceName;
    ws.data.unsubscribe = unsubscribe;
  }

  private cleanupWebSocket(ws: ServerWebSocket<WSData>): void {
    if (ws.data.unsubscribe) {
      ws.data.unsubscribe();
      ws.data.unsubscribe = null;
    }
    ws.data.subscribedService = null;
  }
}

// --- Helpers ---

function logEntryToMessage(entry: LogEntry): LogStreamMessage {
  return {
    type: "log",
    timestamp: entry.timestamp.toISOString(),
    service: entry.service,
    source: entry.source,
    line: entry.line,
  };
}
