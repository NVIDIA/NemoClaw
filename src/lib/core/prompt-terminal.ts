// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";

interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

/**
 * Create the readline interface for an interactive stdin prompt.
 *
 * `readline.createInterface()` derives `terminal` from the OUTPUT stream, and
 * every interactive prompt here writes its question to stderr. Whenever stderr
 * is captured — `nemoclaw onboard 2> onboard.log`, a CI job, a QA watchdog
 * driving the CLI on a pty — readline falls back to `terminal: false` and
 * stops interpreting keypresses, so Ctrl-C never becomes the `SIGINT` event
 * the `rl.on("SIGINT")` cancellation contract depends on. If the terminal
 * driving stdin is also in raw mode, the kernel does not deliver SIGINT
 * either, and the prompt waits forever with no output and no exit (#12167).
 *
 * Keying `terminal` off the INPUT stream keeps keypress handling wherever
 * stdin is a TTY, independent of where the question is echoed. A non-TTY
 * stdin (piped input, `< /dev/null`) still gets `terminal: false`, so the
 * EOF-cancellation contract for headless callers is unchanged.
 */
export function createStdinPromptInterface(
  input: PromptInput = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): readline.Interface {
  return readline.createInterface({ input, output, terminal: input.isTTY === true });
}

export type PromptInterruptSignal = "SIGINT" | "SIGTERM";

/** Shell convention for a process terminated by a signal (128 + signal number). */
export const PROMPT_INTERRUPT_EXIT_CODES: Record<PromptInterruptSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

interface InterruptProcessLike {
  exitCode?: number | string | null;
  pid?: number;
  kill?(pid: number, signal: PromptInterruptSignal): unknown;
}

/**
 * Re-raise Ctrl-C after a prompt has rejected with `code: "SIGINT"`.
 *
 * Signal delivery is asynchronous, while the prompt rejection continues
 * synchronously through its caller. A caller that treats the interrupt as a
 * clean cancellation therefore lets the process drain an empty event loop and
 * exit 0 before the re-raised SIGINT — or before the deferred onboarding
 * interrupt handler — ever runs, so the interrupt is reported to the shell as
 * success and the resume guidance (which the onboarding `exit` handler skips
 * on code 0) is never printed. Pinning the exit code before re-raising makes
 * the documented 130 outcome hold whichever of the two paths wins the race.
 */
export function raisePromptInterrupt(
  signal: PromptInterruptSignal = "SIGINT",
  processLike: InterruptProcessLike = process,
): void {
  processLike.exitCode = PROMPT_INTERRUPT_EXIT_CODES[signal];
  if (typeof processLike.kill === "function" && processLike.pid !== undefined) {
    processLike.kill(processLike.pid, signal);
  }
}
