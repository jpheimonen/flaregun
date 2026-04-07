/**
 * Types and interfaces for the admin UI backend.
 *
 * Defines the hot-reload engine contract that step 013 will implement,
 * the admin server configuration, and related types.
 */

import type { FlaregunConfig } from "../config/index.js";
import type { CloudflareClient } from "../cloudflare/index.js";
import type { LockState } from "../lock/index.js";
import type { Supervisor } from "../process/supervisor.js";

// --- Hot-Reload Engine Interface ---

/** Result of a hot-reload operation */
export interface HotReloadResult {
  /** Whether all changes were applied successfully */
  success: boolean;
  /** List of error messages for changes that failed */
  errors: string[];
  /** Summary of changes that were successfully applied */
  changes: string[];
}

/**
 * Interface for the hot-reload engine (step 013).
 *
 * The admin backend calls `reload()` after saving a new config to disk.
 * The hot-reload engine computes the diff between old and new configs,
 * then applies changes (start/stop services, update Access policies,
 * update ingress rules, etc.).
 *
 * Step 013 will provide the concrete implementation of this interface.
 */
export interface IHotReloadEngine {
  reload(
    oldConfig: FlaregunConfig,
    newConfig: FlaregunConfig,
    client: CloudflareClient,
    lockState: LockState,
    supervisor: Supervisor,
  ): Promise<HotReloadResult>;
}

// --- Admin Server Types ---

/**
 * Dependencies injected into the admin server.
 * Follows the dependency injection pattern from the project architecture
 * (modeled after personal-homepage's UpDeps interface).
 */
export interface AdminServerDeps {
  /** Process supervisor for service state queries and management */
  supervisor: Supervisor;
  /** Hot-reload engine triggered after config saves */
  hotReloadEngine: IHotReloadEngine;
  /** Cloudflare SDK client for hot-reload operations */
  cloudflareClient: CloudflareClient;
  /** Lock file state for hot-reload operations */
  lockState: LockState;
  /** Path to the flaregun.yml config file */
  configPath: string;
  /** Path to the pre-built SPA directory */
  spaDir: string;
  /** Config describing Pages services (for the service list endpoint) */
  pagesServices: PagesServiceInfo[];
}

/** Info about a Pages service (not supervised, status from config/lock) */
export interface PagesServiceInfo {
  name: string;
  subdomain: string;
  deployed: boolean;
}

/** Options for starting the admin server */
export interface AdminServerOptions {
  /** Preferred port to attempt binding to. Default: 9100 */
  preferredPort?: number;
  /** Maximum number of port attempts before giving up. Default: 10 */
  maxPortAttempts?: number;
}

// --- WebSocket Message Types ---

/** Message sent by a WebSocket client to subscribe to logs */
export interface LogSubscribeMessage {
  type: "subscribe";
  /** Service name to subscribe to, or "__all__" for combined stream */
  service: string;
}

/** Log entry message sent to WebSocket clients */
export interface LogStreamMessage {
  type: "log";
  timestamp: string;
  service: string;
  source: "stdout" | "stderr";
  line: string;
}

/** History batch message sent upon subscription */
export interface LogHistoryMessage {
  type: "history";
  entries: LogStreamMessage[];
}
