import { spawn } from "bun";

// Re-export supervisor module
export {
  Supervisor,
  RollingLogBuffer,
  type ServiceState,
  type LogEntry,
  type LogSubscriber,
  type ServiceInfo,
  type SupervisedServiceConfig,
  type SupervisorTimingConfig,
} from "./supervisor.js";

/**
 * Checks that a binary is available on PATH by attempting to run `which`.
 * Returns true if found, false otherwise.
 */
export async function binaryExists(name: string): Promise<boolean> {
  try {
    const proc = spawn(["which", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Result of running a shell command. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Function signature for running shell commands — injectable for testing. */
export type CommandRunner = (
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

/**
 * Runs a shell command and returns the exit code plus stdout/stderr.
 */
export async function runCommand(
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
