#!/usr/bin/env bun

import { dispatch } from "./commands.js";

/**
 * CLI entry point. Reads process.argv, dispatches to the appropriate
 * command handler, and exits with the correct code.
 */
function main(): void {
  // Strip the runtime (bun) and script path from argv
  const args = process.argv.slice(2);

  const { result, exitCode } = dispatch(args);

  if (!result) {
    process.exit(exitCode);
  }

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

main();
