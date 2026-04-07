/**
 * Frontend type definitions for the admin UI.
 *
 * These mirror the backend API response shapes from the admin server (step 012).
 */

/** Lifecycle states for a local supervised service */
export type ServiceState =
  | "starting"
  | "running"
  | "crashed"
  | "restarting"
  | "stopped";

/** A local service managed by the process supervisor */
export interface LocalServiceInfo {
  name: string;
  type: "local";
  state: ServiceState;
  /** ISO-8601 timestamp of when the service entered the "running" state, or null */
  runningSince: string | null;
  /** Number of restarts since the supervisor started managing the service */
  restartCount: number;
  /** Exit code or error message from the most recent crash, or null */
  lastCrashReason: string | null;
}

/** A Cloudflare Pages service (not supervised) */
export interface PagesServiceInfo {
  name: string;
  type: "pages";
  subdomain: string;
  deployed: boolean;
}

/** Union type for any service */
export type ServiceInfo = LocalServiceInfo | PagesServiceInfo;

/** Response from GET /api/services */
export interface ServiceListResponse {
  success: boolean;
  services: ServiceInfo[];
}

/** Response from POST /api/services/:name/restart or stop */
export interface ServiceActionResponse {
  success: boolean;
  error?: string;
}

/** Response from GET /api/config */
export interface ConfigReadResponse {
  success: boolean;
  content?: string;
  error?: string;
}
