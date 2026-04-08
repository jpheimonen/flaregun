import { describe, expect, test } from "bun:test";
import { dispatch, COMMANDS } from "../src/cli/commands.js";

/** Captures output from dispatch calls. */
function captureDispatch(args: string[]) {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const { result, exitCode } = dispatch(
    args,
    (msg) => stdoutLines.push(msg),
    (msg) => stderrLines.push(msg),
  );
  return { result, exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}

describe("CLI dispatcher", () => {
  describe("help text", () => {
    test("--help displays help text listing all six commands", () => {
      const { result, exitCode, stdout } = captureDispatch(["--help"]);
      expect(result).toBeNull();
      expect(exitCode).toBe(0);
      expect(stdout).toContain("up");
      expect(stdout).toContain("down");
      expect(stdout).toContain("deploy");
      expect(stdout).toContain("build");
      expect(stdout).toContain("setup");
      expect(stdout).toContain("destroy");
    });

    test("-h displays help text", () => {
      const { result, exitCode, stdout } = captureDispatch(["-h"]);
      expect(result).toBeNull();
      expect(exitCode).toBe(0);
      expect(stdout).toContain("flaregun");
    });

    test("no arguments displays help text", () => {
      const { result, exitCode, stdout } = captureDispatch([]);
      expect(result).toBeNull();
      expect(exitCode).toBe(0);
      expect(stdout).toContain("up");
      expect(stdout).toContain("down");
      expect(stdout).toContain("deploy");
      expect(stdout).toContain("build");
      expect(stdout).toContain("setup");
      expect(stdout).toContain("destroy");
    });
  });

  describe("command dispatching", () => {
    test("dispatches 'up' command", () => {
      const { result, exitCode } = captureDispatch(["up"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("up");
      expect(result!.filters).toEqual([]);
    });

    test("dispatches 'down' command", () => {
      const { result, exitCode } = captureDispatch(["down"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("down");
      expect(result!.filters).toEqual([]);
    });

    test("dispatches 'deploy' command", () => {
      const { result, exitCode } = captureDispatch(["deploy"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("deploy");
      expect(result!.filters).toEqual([]);
    });

    test("dispatches 'build' command", () => {
      const { result, exitCode } = captureDispatch(["build"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("build");
      expect(result!.filters).toEqual([]);
    });

    test("dispatches 'setup' command", () => {
      const { result, exitCode } = captureDispatch(["setup"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("setup");
      expect(result!.filters).toEqual([]);
    });

    test("dispatches 'destroy' command", () => {
      const { result, exitCode } = captureDispatch(["destroy"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("destroy");
      expect(result!.filters).toEqual([]);
    });
  });

  describe("service name filters", () => {
    test("build command passes trailing args as service name filters", () => {
      const { result, exitCode } = captureDispatch(["build", "homepage", "blog"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("build");
      expect(result!.filters).toEqual(["homepage", "blog"]);
    });

    test("deploy command passes trailing args as service name filters", () => {
      const { result, exitCode } = captureDispatch(["deploy", "photos"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("deploy");
      expect(result!.filters).toEqual(["photos"]);
    });

    test("non-filter commands ignore trailing args", () => {
      const { result, exitCode } = captureDispatch(["up", "extra-arg"]);
      expect(exitCode).toBe(0);
      expect(result).not.toBeNull();
      expect(result!.command).toBe("up");
      expect(result!.filters).toEqual([]);
    });
  });

  describe("unknown commands", () => {
    test("unknown command displays error and help text, exits with non-zero code", () => {
      const { result, exitCode, stderr } = captureDispatch(["notacommand"]);
      expect(result).toBeNull();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Error");
      expect(stderr).toContain("notacommand");
      // Help text should also appear in stderr
      expect(stderr).toContain("up");
      expect(stderr).toContain("down");
    });
  });
});
