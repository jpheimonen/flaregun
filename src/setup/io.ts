/**
 * Terminal input and output for interactive commands.
 *
 * Everything the person sees or answers goes through SetupIO, so tests can
 * script the answers.
 */

import { createInterface, type Interface } from "readline";

export interface SetupIO {
  print(msg: string): void;
  /** Asks for a line of text. An empty answer returns the default when one is given. */
  prompt(question: string, defaultValue?: string): Promise<string>;
  /** Asks a yes/no question. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Shows a numbered list and returns the index of the chosen option. */
  choose(question: string, options: string[]): Promise<number>;
  /**
   * Runs `check` every couple of seconds until it returns a value. Returns null
   * when the time runs out or the person presses Enter to stop waiting.
   */
  waitUntil<T>(
    message: string,
    check: () => Promise<T | null>,
    timeoutMs: number,
  ): Promise<T | null>;
  /** Releases the terminal so the process can exit. */
  close(): void;
}

const WAIT_INTERVAL_MS = 2000;

/** Creates SetupIO on the real terminal. */
export function createConsoleIO(): SetupIO {
  let rl: Interface | null = null;
  let ended = false;
  // Resolves with the next line, or null once input has ended.
  const waiting: Array<(line: string | null) => void> = [];

  const terminal = (): Interface => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
      rl.on("line", (line) => waiting.shift()?.(line));
      rl.on("close", () => {
        // Ctrl+D or a closed pipe: nobody can answer any more.
        ended = true;
        while (waiting.length) waiting.shift()?.(null);
      });
    }
    return rl;
  };

  const nextLine = (): { line: Promise<string | null>; cancel: () => void } => {
    terminal();
    if (ended) return { line: Promise.resolve(null), cancel: () => {} };
    let resolver!: (line: string | null) => void;
    const line = new Promise<string | null>((r) => (resolver = r));
    waiting.push(resolver);
    return {
      line,
      cancel: () => {
        const i = waiting.indexOf(resolver);
        if (i >= 0) waiting.splice(i, 1);
      },
    };
  };

  const ask = async (question: string): Promise<string> => {
    process.stdout.write(`${question} `);
    const line = await nextLine().line;
    if (line === null) throw new Error("Input ended before flaregun got an answer.");
    return line.trim();
  };

  return {
    print(msg) {
      console.log(msg);
    },

    async prompt(question, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = await ask(`${question}${suffix}`);
      return answer || defaultValue || "";
    },

    async confirm(question, defaultYes = false) {
      const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`)).toLowerCase();
      if (!answer) return defaultYes;
      return answer.startsWith("y");
    },

    async choose(question, options) {
      console.log(question);
      options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`));
      while (true) {
        const answer = await ask(`Pick 1-${options.length}:`);
        const n = parseInt(answer, 10);
        if (n >= 1 && n <= options.length) return n - 1;
        console.log(`Type a number from 1 to ${options.length}.`);
      }
    },

    async waitUntil(message, check, timeoutMs) {
      console.log(message);
      const enter = nextLine();
      let skipped = false;
      enter.line.then(() => (skipped = true));
      const deadline = Date.now() + timeoutMs;
      try {
        while (!skipped && Date.now() < deadline) {
          const value = await check();
          if (value) return value;
          await Promise.race([Bun.sleep(WAIT_INTERVAL_MS), enter.line]);
        }
        return null;
      } finally {
        enter.cancel();
      }
    },

    close() {
      rl?.close();
      rl = null;
    },
  };
}
