#!/usr/bin/env bun

import { existsSync } from "fs";
import { resolve } from "path";
import { dispatch } from "./commands.js";
import { handleDeploy } from "../deploy/command.js";
import { handleBuild } from "../deploy/build-command.js";
import { handleUp, handleDown } from "../orchestrate/index.js";
import { handleSetup } from "../setup/index.js";
import { handleDestroy } from "../destroy/index.js";
import { handleExpose, parseExposeArgs } from "../expose/index.js";

/**
 * CLI entry point. Reads process.argv, dispatches to the appropriate
 * command handler, and exits with the correct code.
 */
async function main(): Promise<number> {
  // Strip the runtime (bun) and script path from argv
  const { result, exitCode } = dispatch(process.argv.slice(2));
  if (!result) return exitCode;

  const useBrowser = !result.args.includes("--no-browser");

  switch (result.command) {
    case "setup": {
      const unknown = result.args.filter((a) => a !== "--no-browser");
      if (unknown.length > 0) {
        console.error(`Unknown option for setup: ${unknown[0]}`);
        return 1;
      }
      return (await handleSetup({ useBrowser })).success ? 0 : 1;
    }

    case "expose": {
      const request = parseExposeArgs(result.args);
      if ("error" in request) {
        console.error(request.error);
        return 1;
      }
      return (await handleExpose(request)).success ? 0 : 1;
    }

    case "up": {
      if (!existsSync(resolve(process.cwd(), "flaregun.yml"))) {
        console.log("This folder isn't set up yet, so flaregun runs setup first.");
        if (!(await handleSetup({ useBrowser })).success) return 1;
      }
      return (await handleUp()).success ? 0 : 1;
    }

    case "down":
      return (await handleDown()).success ? 0 : 1;

    case "deploy":
      return (await handleDeploy(result.filters)).success ? 0 : 1;

    case "build":
      return (await handleBuild(result.filters)).success ? 0 : 1;

    case "destroy":
      return (await handleDestroy()).success ? 0 : 1;
  }
  return 1;
}

main().then((code) => process.exit(code));
