/**
 * Deploy pipeline utilities.
 *
 * Re-exports the functions scaffolder, wrangler config generator,
 * temporary directory management utilities, build-scaffold-copy sequence,
 * functions copy utility, deploy pipeline orchestrator, and deploy
 * command handler.
 */

export { scaffoldFunctions, type ScaffoldResult } from "./scaffold.js";
export {
  generatePagesConfig,
  generateFallbackWorkerConfig,
  MissingResourceError,
  type PagesConfigResult,
  type FallbackConfigResult,
} from "./wrangler.js";
export { createTmpDir, cleanupTmpDir } from "./tmp.js";
export { copyFunctionsToDistDir } from "./copy-functions.js";
export { buildScaffoldCopy, type BuildResult } from "./build.js";
export {
  deployService,
  deployFallbackWorker,
  deployPipeline,
  formatDeploySummary,
  type ServiceDeployResult,
  type WorkerDeployResult,
  type DeploySummaryEntry,
  type DeployPipelineResult,
} from "./pipeline.js";
export {
  handleDeploy,
  type DeployCommandDeps,
  type DeployCommandResult,
} from "./command.js";
