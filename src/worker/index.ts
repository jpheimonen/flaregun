/**
 * Fallback Worker module.
 *
 * Re-exports the routing logic handler, source generator, default down page,
 * and related types.
 */

export { handleRequest, type FetchFn } from "./handler.js";
export { defaultDownPageHtml } from "./down-page.js";
export {
  generateWorkerSource,
  writeWorkerSource,
  resolveDownPageHtml,
  DownPageNotFoundError,
  WORKER_SOURCE_FILENAME,
  type GenerateWorkerOptions,
  type GenerateWorkerResult,
} from "./generate.js";
