#!/usr/bin/env bun

import { dispatch } from "./commands.js";
import { handleDeploy } from "../deploy/command.js";
import { handleBuild } from "../deploy/build-command.js";
import { handleUp, handleDown } from "../orchestrate/index.js";
import { handleSetup } from "../setup/index.js";

/**
 * CLI entry point. Reads process.argv, dispatches to the appropriate
 * command handler, and exits with the correct code.
 */
async function main(): Promise<void> {
  // Strip the runtime (bun) and script path from argv
  const args = process.argv.slice(2);

  const { result, exitCode } = dispatch(args);

  if (!result) {
    process.exit(exitCode);
  }

  // Command dispatch
  switch (result.command) {
    case "up": {
      const upResult = await handleUp();
      process.exit(upResult.success ? 0 : 1);
      break;
    }

    case "down": {
      const downResult = await handleDown();
      process.exit(downResult.success ? 0 : 1);
      break;
    }

    case "deploy": {
      const deployResult = await handleDeploy(result.filters);
      process.exit(deployResult.success ? 0 : 1);
      break;
    }

    case "build": {
      const buildResult = await handleBuild(result.filters);
      process.exit(buildResult.success ? 0 : 1);
      break;
    }

    case "setup": {
      const setupResult = await handleSetup();
      process.exit(setupResult.success ? 0 : 1);
      break;
    }

    default:
      // Placeholder handlers — actual implementations come in later steps
      if (result.filters.length > 0) {
        console.log(
          `[${result.command}] Not yet implemented (services: ${result.filters.join(", ")})`,
        );
      } else {
        console.log(`[${result.command}] Not yet implemented`);
      }
      process.exit(exitCode);
  }
}

main();
