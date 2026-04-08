/**
 * Admin UI backend module.
 *
 * Re-exports the server class, types, and interfaces needed by consumers
 * (the orchestrator in step 016, and step 013 for the hot-reload engine interface).
 */

export { AdminServer } from "./server.js";
export type {
  AdminServerDeps,
  AdminServerOptions,
  IHotReloadEngine,
  HotReloadResult,
  PagesServiceInfo,
  LogSubscribeMessage,
  LogStreamMessage,
  LogHistoryMessage,
} from "./types.js";
