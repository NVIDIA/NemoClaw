// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synchronous stdin primitives for interactive CLI prompts.
 *
 * `process.stdin` is hazardous in synchronous CLIs: the getter instantiates
 * the stdin stream, and libuv flips fd 0 into non-blocking mode as a
 * process-wide side effect. Any later raw `fs.readSync(0)` then throws
 * `EAGAIN` instead of blocking for input (#5188, regressed by #5020). The
 * helpers here avoid creating that state and tolerate it when other code in
 * the same process has already created it.
 *
 * Why the `EAGAIN` retry stays even though `isStdinTty()` fixed the local
 * source: other CLI paths still instantiate `process.stdin` in this process
 * — the onboard TTY probe in `onboard.ts`, and the readline prompts in
 * `policy/index.ts` and `onboard/messaging-selector.ts` — so any flow that
 * runs one of them before prompting here inherits a non-blocking fd 0. The
 * retry keeps this module correct regardless of what ran first.
 *
 * Removal condition: once every synchronous prompt reads stdin through this
 * module and a repo-wide lint guard bans direct `process.stdin` access in
 * sync CLI paths, the `EAGAIN`/`EWOULDBLOCK` retry can collapse back to the
 * plain EOF-on-error behavior.
 */

import fs from "node:fs";
import tty from "node:tty";

import { isErrnoException } from "./errno";
import { sleepMs } from "./wait";

/**
 * True when fd 0 is an interactive terminal. Asks the kernel directly —
 * never use `process.stdin.isTTY` for this (see module comment).
 */
export function isStdinTty(): boolean {
  return tty.isatty(0);
}

/**
 * Pause between retries while fd 0 reports `EAGAIN` (non-blocking stdin with
 * no input yet). Short enough to be imperceptible at an interactive prompt;
 * long enough to avoid a hot loop while waiting for keystrokes.
 */
const READ_LINE_RETRY_DELAY_MS = 25;

/**
 * How long a non-TTY stdin may stay in the `EAGAIN` "no input yet" state
 * before the read gives up and reports no input. On a TTY the prompt waits
 * indefinitely — a human may answer at any time and Ctrl-C always escapes —
 * but a non-interactive stdin left non-blocking (e.g. a never-written pipe)
 * may never become ready, and a confirm prompt hanging forever in
 * automation is an operator hazard.
 */
const NON_TTY_EAGAIN_DEADLINE_MS = 10_000;

export interface ReadLineDeps {
  isTty?: () => boolean;
  readSync?: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  sleep?: (ms: number) => void;
}

/**
 * Read one line from fd 0 directly rather than via `process.stdin` (see
 * module comment). A non-blocking fd must be tolerated here: `EAGAIN` means
 * "no input yet", not end-of-input — wait briefly and retry. Treating
 * `EAGAIN` as EOF (#5020) made every confirm prompt auto-abort on Linux
 * TTYs before the user could type. On a TTY the wait is unbounded; on a
 * non-TTY stdin it is capped at `NON_TTY_EAGAIN_DEADLINE_MS` so automation
 * never hangs on a permanently non-ready fd.
 */
export function readLineFromStdin(deps: ReadLineDeps = {}): string | null {
  const readSync = deps.readSync ?? fs.readSync;
  const sleep = deps.sleep ?? sleepMs;
  const stdinIsTerminal = (deps.isTty ?? isStdinTty)();
  const chunks: Buffer[] = [];
  const byte = Buffer.alloc(1);
  // Virtual elapsed time: advanced by the nominal retry delay rather than a
  // wall clock so the deadline stays deterministic under an injected sleep.
  let eagainWaitMs = 0;
  while (true) {
    let bytesRead = 0;
    try {
      bytesRead = readSync(0, byte, 0, 1, null);
    } catch (err) {
      const code = isErrnoException(err) ? err.code : undefined;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") {
        if (!stdinIsTerminal && eagainWaitMs >= NON_TTY_EAGAIN_DEADLINE_MS) {
          return chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null;
        }
        sleep(READ_LINE_RETRY_DELAY_MS);
        eagainWaitMs += READ_LINE_RETRY_DELAY_MS;
        continue;
      }
      if (code === "EINTR") continue;
      return chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : null;
    }
    if (bytesRead === 0 || byte[0] === 10) break;
    chunks.push(Buffer.from(byte));
  }
  if (chunks.length === 0) return null;
  return Buffer.concat(chunks).toString("utf-8").replace(/\r$/, "");
}
