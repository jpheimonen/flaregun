/** Definitions and handlers for all CLI commands. */

export interface CommandDef {
  name: string;
  description: string;
  /** Whether this command accepts trailing service name filters. */
  acceptsFilters: boolean;
}

/** All recognized commands in display order. */
export const COMMANDS: CommandDef[] = [
  { name: "up", description: "Start tunnels, services, and admin UI", acceptsFilters: false },
  { name: "down", description: "Stop all running services and tunnels", acceptsFilters: false },
  { name: "deploy", description: "Sync config and deploy services to Cloudflare", acceptsFilters: true },
  { name: "build", description: "Build services locally", acceptsFilters: true },
  { name: "setup", description: "Interactive guided setup wizard", acceptsFilters: false },
  { name: "destroy", description: "Tear down all Cloudflare resources", acceptsFilters: false },
];

/** Map of command name → definition for fast lookup. */
export const COMMAND_MAP = new Map<string, CommandDef>(
  COMMANDS.map((cmd) => [cmd.name, cmd]),
);

/** Result from dispatching a command. */
export interface DispatchResult {
  command: string;
  filters: string[];
}

/**
 * Dispatches CLI arguments to the appropriate command handler.
 *
 * Returns a DispatchResult if a valid command was found, or null if
 * help was shown or an error was printed.
 *
 * @param args - The CLI arguments (without the runtime and script path)
 * @param stdout - Write function for normal output (default: console.log)
 * @param stderr - Write function for error output (default: console.error)
 * @returns DispatchResult or null, plus the exit code
 */
export function dispatch(
  args: string[],
  stdout: (msg: string) => void = console.log,
  stderr: (msg: string) => void = console.error,
): { result: DispatchResult | null; exitCode: number } {
  // No arguments or help flag → show help
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp(stdout);
    return { result: null, exitCode: 0 };
  }

  const commandName = args[0];
  const def = COMMAND_MAP.get(commandName);

  if (!def) {
    stderr(`Error: Unknown command "${commandName}"\n`);
    printHelp(stderr);
    return { result: null, exitCode: 1 };
  }

  const filters = def.acceptsFilters ? args.slice(1) : [];

  return {
    result: { command: def.name, filters },
    exitCode: 0,
  };
}

/** Prints the help text listing all available commands. */
export function printHelp(out: (msg: string) => void): void {
  out("flaregun — Manage your Cloudflare stack from a single config file\n");
  out("Usage: flaregun <command> [options]\n");
  out("Commands:");
  for (const cmd of COMMANDS) {
    out(`  ${cmd.name.padEnd(10)} ${cmd.description}`);
  }
  out("");
  out("Options:");
  out("  --help, -h   Show this help text");
}
