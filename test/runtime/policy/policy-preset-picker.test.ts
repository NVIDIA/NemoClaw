// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive preset pickers for `policy-add` and `policy-remove`: selection
 * parsing, stdin event-loop cleanup, and prompt-EOF cancellation (#7418).
 */

import { createRequire } from "node:module";
import path from "node:path";
import type { Interface as ReadlineInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const readline = requireForTest("node:readline") as typeof import("node:readline");
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../../../src/lib/policy");

const SELECT_FROM_LIST_ITEMS = [
  { name: "npm", description: "npm and Yarn registry access", file: "npm.yaml" },
  { name: "pypi", description: "Python Package Index (PyPI) access", file: "pypi.yaml" },
];
type AppliedOptions = {
  applied?: string[];
};

type SelectionFunction = "selectFromList" | "selectForRemoval";

async function runSelectionPrompt(
  functionName: SelectionFunction,
  input: string,
  { applied = [] }: AppliedOptions = {},
) {
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  const stderr: string[] = [];
  const counts = { ref: 0, pause: 0, unref: 0 };
  const stdin = process.stdin as typeof process.stdin & {
    ref: () => typeof process.stdin;
    pause: () => typeof process.stdin;
    unref: () => typeof process.stdin;
  };
  const original = {
    ref: stdin.ref,
    pause: stdin.pause,
    unref: stdin.unref,
  };
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  // Readline emits `close` whenever `rl.close()` runs, including the
  // `rl.close()` the picker performs after an answer. The fake emits it too,
  // so a successful selection exercises the picker's reentrancy guard. Were
  // that guard removed, the post-answer close would settle the promise a
  // second time (#7418).
  const closeListeners: Array<() => void> = [];
  const close = vi.fn(() => closeListeners.forEach((listener) => listener()));
  const createInterface = vi.spyOn(readline, "createInterface").mockImplementation((options) => {
    expect(options).toEqual({ input: process.stdin, output: process.stderr });
    return {
      question: (question: string, callback: (answer: string) => void) => {
        process.stderr.write(question);
        callback(input);
      },
      on: (event: string, listener: () => void) => {
        // No `if`: changed test files may not add one (codebase-growth-guardrails).
        [listener].filter(() => event === "close").forEach((l) => closeListeners.push(l));
      },
      close,
    } as unknown as ReadlineInterface;
  });
  stdin.ref = () => {
    counts.ref += 1;
    return process.stdin;
  };
  stdin.pause = () => {
    counts.pause += 1;
    return process.stdin;
  };
  stdin.unref = () => {
    counts.unref += 1;
    return process.stdin;
  };

  try {
    const selected = await policies[functionName](SELECT_FROM_LIST_ITEMS, { applied });
    return {
      selected,
      stderr: stderr.join(""),
      exitCode: process.exitCode,
      counts,
      close,
    };
  } finally {
    process.exitCode = originalExitCode;
    stdin.ref = original.ref;
    stdin.pause = original.pause;
    stdin.unref = original.unref;
    createInterface.mockRestore();
    stderrWrite.mockRestore();
  }
}

/**
 * Drive a picker against a readline interface that reaches EOF. `question`
 * writes the prompt but its callback never fires, and readline closes
 * instead. A boot unit produces this by running `policy-add < /dev/null`.
 */
async function runSelectionPromptAtEof(
  functionName: SelectionFunction,
  { applied = [] }: AppliedOptions = {},
) {
  const stderr: string[] = [];
  // Stub the same stdin methods `runSelectionPrompt` stubs. The picker calls
  // ref/pause/unref on the real handle otherwise, which leaves this Vitest
  // worker's stdin unreferenced and makes later tests order-dependent.
  const stdin = process.stdin as typeof process.stdin & {
    ref: () => typeof process.stdin;
    pause: () => typeof process.stdin;
    unref: () => typeof process.stdin;
  };
  const original = { ref: stdin.ref, pause: stdin.pause, unref: stdin.unref };
  stdin.ref = () => process.stdin;
  stdin.pause = () => process.stdin;
  stdin.unref = () => process.stdin;
  const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const closeListeners: Array<() => void> = [];
  const createInterface = vi.spyOn(readline, "createInterface").mockImplementation(
    () =>
      ({
        question: (question: string) => {
          process.stderr.write(question);
          // Real readline emits `close` on EOF without answering.
          queueMicrotask(() => closeListeners.forEach((listener) => listener()));
        },
        on: (event: string, listener: () => void) => {
          [listener].filter(() => event === "close").forEach((l) => closeListeners.push(l));
        },
        close: vi.fn(),
      }) as unknown as ReadlineInterface,
  );

  try {
    return await policies[functionName](SELECT_FROM_LIST_ITEMS, { applied }).then(
      (selected) => ({ outcome: "resolved", selected, code: undefined, stderr: stderr.join("") }),
      (error: NodeJS.ErrnoException) => ({
        outcome: "rejected",
        selected: undefined,
        code: error.code,
        stderr: stderr.join(""),
      }),
    );
  } finally {
    stdin.ref = original.ref;
    stdin.pause = original.pause;
    stdin.unref = original.unref;
    createInterface.mockRestore();
    stderrWrite.mockRestore();
  }
}

/**
 * Drive a picker against a readline interface that receives an interrupt.
 * Readline emits `SIGINT` and then `close`, so this proves an interrupt is
 * reported as SIGINT rather than as a closed stdin (#7418).
 */
async function runSelectionPromptAtSigint(
  functionName: SelectionFunction,
  { applied = [] }: AppliedOptions = {},
) {
  const stdin = process.stdin as typeof process.stdin & {
    ref: () => typeof process.stdin;
    pause: () => typeof process.stdin;
    unref: () => typeof process.stdin;
  };
  const original = { ref: stdin.ref, pause: stdin.pause, unref: stdin.unref };
  stdin.ref = () => process.stdin;
  stdin.pause = () => process.stdin;
  stdin.unref = () => process.stdin;
  const stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
  // The picker re-raises SIGINT; capture it instead of killing the worker.
  const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  const listeners = new Map<string, () => void>();
  const createInterface = vi.spyOn(readline, "createInterface").mockImplementation(
    () =>
      ({
        question: () => {
          queueMicrotask(() => {
            listeners.get("SIGINT")?.();
            listeners.get("close")?.();
          });
        },
        on: (event: string, listener: () => void) => {
          listeners.set(event, listener);
        },
        close: vi.fn(),
      }) as unknown as ReadlineInterface,
  );

  try {
    return await policies[functionName](SELECT_FROM_LIST_ITEMS, { applied }).then(
      () => ({
        code: undefined as string | undefined,
        reraised: kill.mock.calls.length,
        signal: kill.mock.calls[0]?.[1],
      }),
      (error: NodeJS.ErrnoException) => ({
        code: error.code,
        reraised: kill.mock.calls.length,
        signal: kill.mock.calls[0]?.[1],
      }),
    );
  } finally {
    stdin.ref = original.ref;
    stdin.pause = original.pause;
    stdin.unref = original.unref;
    createInterface.mockRestore();
    stderrWrite.mockRestore();
    kill.mockRestore();
  }
}

describe("policy preset pickers", () => {
  describe("selectFromList", () => {
    it("returns preset name by number from stdin input", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n");

      expect(result.selected).toBe("npm");
      expect(result.stderr).toContain("Choose preset [1]:");
    });

    it("uses the first preset as the default when input is empty", async () => {
      const result = await runSelectionPrompt("selectFromList", "\n");

      expect(result.stderr).toContain("Choose preset [1]:");
      expect(result.selected).toBe("npm");
    });

    it("defaults to the first not-applied preset", async () => {
      const result = await runSelectionPrompt("selectFromList", "\n", { applied: ["npm"] });

      expect(result.stderr).toContain("Choose preset [2]:");
      expect(result.selected).toBe("pypi");
    });

    it("rejects selecting an already-applied preset", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n", { applied: ["npm"] });

      expect(result.stderr).toMatch(/already applied\.[\s\S]*policy add npm'/);
      expect(result.selected).toBeNull();
    });

    it("rejects out-of-range preset number with a failure status (#9742)", async () => {
      const result = await runSelectionPrompt("selectFromList", "99\n");

      expect(result.stderr).toContain("Invalid preset number.");
      expect(result).toMatchObject({ selected: null, exitCode: 1 });
    });

    it("rejects non-numeric preset input with a failure status (#9742)", async () => {
      const result = await runSelectionPrompt("selectFromList", "npm\n");

      expect(result.stderr).toContain("Invalid preset number.");
      expect(result).toMatchObject({ selected: null, exitCode: 1 });
    });

    it("prints numbered list with applied markers, legend, and default prompt", async () => {
      const result = await runSelectionPrompt("selectFromList", "2\n", { applied: ["npm"] });

      expect(result.stderr).toMatch(/Available presets:/);
      expect(result.stderr).toMatch(/1\) ● npm — npm and Yarn registry access/);
      expect(result.stderr).toMatch(/2\) ○ pypi — Python Package Index \(PyPI\) access/);
      expect(result.stderr).toMatch(/● applied, ○ not applied/);
      expect(result.stderr).toMatch(/Choose preset \[2\]:/);
      expect(result.selected).toBe("pypi");
    });

    it("rejects with code EOF when stdin closes before an answer (#7418)", async () => {
      const result = await runSelectionPromptAtEof("selectFromList");

      expect(result.stderr).toContain("Choose preset [1]:");
      expect(result.outcome).toBe("rejected");
      expect(result.code).toBe("EOF");
    }, 3_000);

    it("reports an interrupt as SIGINT rather than closed stdin (#7418)", async () => {
      const result = await runSelectionPromptAtSigint("selectFromList");

      expect(result.code).toBe("SIGINT");
      expect(result.reraised).toBe(1);
      // The signal itself, not just that kill ran: re-raising SIGTERM would
      // otherwise satisfy this test.
      expect(result.signal).toBe("SIGINT");
    }, 3_000);
  });

  describe("selectForRemoval", () => {
    it("returns null when no presets are applied", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: [] });
      expect(result.stderr).toContain("No presets are currently applied");
      expect(result.selected).toBeNull();
    });

    it("shows only applied presets and returns selected name", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: ["npm"] });
      expect(result.stderr).toContain("Applied presets:");
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).not.toContain("pypi");
      expect(result.selected).toBe("npm");
    });

    it("returns null for empty input", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "\n", { applied: ["npm"] });
      expect(result.selected).toBeNull();
    });

    it("rejects non-numeric input", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "npm\n", {
        applied: ["npm"],
      });
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.selected).toBeNull();
    });

    it("rejects out-of-range number", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "99\n", { applied: ["npm"] });
      expect(result.stderr).toContain("Invalid preset number");
      expect(result.selected).toBeNull();
    });

    it("selects second preset when both are applied", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "2\n", {
        applied: ["npm", "pypi"],
      });
      expect(result.stderr).toContain("1) npm");
      expect(result.stderr).toContain("2) pypi");
      expect(result.selected).toBe("pypi");
    });

    it("rejects with code EOF when stdin closes before an answer (#7418)", async () => {
      const result = await runSelectionPromptAtEof("selectForRemoval", { applied: ["npm"] });

      expect(result.stderr).toContain("Choose preset to remove:");
      expect(result.outcome).toBe("rejected");
      expect(result.code).toBe("EOF");
    }, 3_000);

    it("reports an interrupt as SIGINT rather than closed stdin (#7418)", async () => {
      const result = await runSelectionPromptAtSigint("selectForRemoval", { applied: ["npm"] });

      expect(result.code).toBe("SIGINT");
      expect(result.reraised).toBe(1);
      // The signal itself, not just that kill ran: re-raising SIGTERM would
      // otherwise satisfy this test.
      expect(result.signal).toBe("SIGINT");
    }, 3_000);
  });

  describe("interactive prompt cleanup", () => {
    it("releases and re-refs stdin around policy-add preset prompts", async () => {
      const result = await runSelectionPrompt("selectFromList", "1\n");
      expect(result.selected).toBe("npm");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
      expect(result.close).toHaveBeenCalledOnce();
    });

    it("releases and re-refs stdin around policy-remove preset prompts", async () => {
      const result = await runSelectionPrompt("selectForRemoval", "1\n", { applied: ["npm"] });
      expect(result.selected).toBe("npm");
      expect(result.counts.ref).toBeGreaterThanOrEqual(1);
      expect(result.counts.pause).toBeGreaterThanOrEqual(1);
      expect(result.counts.unref).toBeGreaterThanOrEqual(1);
      expect(result.close).toHaveBeenCalledOnce();
    });
  });
});
