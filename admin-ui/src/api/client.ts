/**
 * API client for communicating with the admin backend.
 *
 * All endpoints are same-origin (no CORS), served from the same admin backend
 * that hosts the SPA.
 */

import type {
  ServiceListResponse,
  ServiceActionResponse,
  ConfigReadResponse,
  ConfigValidateResponse,
  ConfigSaveResponse,
} from "../types";

/** Fetch the list of all services (local + Pages) */
export async function fetchServices(): Promise<ServiceListResponse> {
  const res = await fetch("/api/services");
  if (!res.ok) {
    throw new Error(`Failed to fetch services: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Restart a local service by name */
export async function restartService(name: string): Promise<ServiceActionResponse> {
  const res = await fetch(`/api/services/${encodeURIComponent(name)}/restart`, {
    method: "POST",
  });
  return res.json();
}

/** Stop a local service by name */
export async function stopService(name: string): Promise<ServiceActionResponse> {
  const res = await fetch(`/api/services/${encodeURIComponent(name)}/stop`, {
    method: "POST",
  });
  return res.json();
}

/** Read the raw YAML config content */
export async function fetchConfig(): Promise<ConfigReadResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    throw new Error(`Failed to fetch config: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Validate YAML config content without saving */
export async function validateConfig(content: string): Promise<ConfigValidateResponse> {
  const res = await fetch("/api/config/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

/** Save YAML config content (validates, writes, triggers hot-reload) */
export async function saveConfig(content: string): Promise<ConfigSaveResponse> {
  const res = await fetch("/api/config/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

/** Build the WebSocket URL for log streaming */
export function getLogWebSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/logs`;
}
