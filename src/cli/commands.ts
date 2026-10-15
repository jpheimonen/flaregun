/** Definitions and handlers for all CLI commands. */

export interface CommandDef {
  name: string;
  description: string;
  /** Whether this command accepts trailing service name filters. */
  acceptsFilters: boolean;
  /** Help section the command is listed under. */
  group: "tunnels" | "sites";
}

/** All recognized commands in display order. */
export const COMMANDS: CommandDef[] = [
  { name: "setup", description: "Connect flaregun to Cloudflare (clicks through the dashboard in your browser)", acceptsFilters: false, group: "tunnels" },
  { name: "expose", description: "Put a local port online: expose <port> [subdomain] [--public]", acceptsFilters: false, group: "tunnels" },
  { name: "up", description: "Start the tunnel, your services and the admin UI from flaregun.yml", acceptsFilters: false, group: "tunnels" },
  { name: "down", description: "Stop a running flaregun up", acceptsFilters: false, group: "tunnels" },
  { name: "deploy", description: "Build and deploy Pages sites and the fallback Worker", acceptsFilters: true, group: "sites" },
  { name: "build", description: "Build services locally", acceptsFilters: true, group: "sites" },
  { name: "destroy", description: "Delete everything flaregun created in Cloudflare", acceptsFilters: false, group: "sites" },
];

/** Map of command name → definition for fast lookup. */
export const COMMAND_MAP = new Map<string, CommandDef>(
  COMMANDS.map((cmd) => [cmd.name, cmd]),
);

/** Result from dispatching a command. */
export interface DispatchResult {
  command: string;
  filters: string[];
  /** Everything after the command name, for commands with their own arguments. */
  args: string[];
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
    result: { command: def.name, filters, args: args.slice(1) },
    exitCode: 0,
  };
}

/** Prints the help text listing all available commands. */
export function printHelp(out: (msg: string) => void): void {
  out("flaregun — Cloudflare Tunnels for your local ports, with Zero Trust login in front\n");
  out("Quick start:");
  out("  flaregun expose 3000                 https://3000.<your-domain>, login required");
  out("  flaregun expose 8080 grafana         https://grafana.<your-domain>, login required");
  out("  flaregun expose 5173 demo --public   https://demo.<your-domain>, open to anyone\n");
  out("Tunnels:");
  for (const cmd of COMMANDS.filter((c) => c.group === "tunnels")) {
    out(`  ${cmd.name.padEnd(10)} ${cmd.description}`);
  }
  out("\nSites and cleanup:");
  for (const cmd of COMMANDS.filter((c) => c.group === "sites")) {
    out(`  ${cmd.name.padEnd(10)} ${cmd.description}`);
  }
  out("");
  out("Options:");
  out("  --no-browser   setup, expose: do the Cloudflare dashboard clicks yourself");
  out("  --help, -h     Show this help text");
}
