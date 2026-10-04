// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

let stdoutRedirectDepth = 0;
let originalStdoutWrite: typeof process.stdout.write | null = null;

/**
 * Keep child-process output on the human-output channel while stdout is
 * reserved for a machine-readable document or event stream.
 *
 * Replacing `process.stdout.write` does not affect a child that inherits the
 * process' OS-level stdout descriptor. Route that descriptor to stderr so an
 * inherited child cannot corrupt machine output or become coupled to a closed
 * machine-output pipe.
 */
export function redirectInheritedChildStdoutToStderr(
  stdio: StdioOptions | undefined,
): StdioOptions | undefined {
  if (stdoutRedirectDepth === 0 || stdio === undefined) return stdio;
  if (stdio === "inherit") return ["inherit", process.stderr, "inherit"];
  if (!Array.isArray(stdio)) return stdio;

  const inheritedStdout = stdio[1];
  if (
    inheritedStdout !== "inherit" &&
    inheritedStdout !== 1 &&
    inheritedStdout !== process.stdout
  ) {
    return stdio;
  }
  const redirected = [...stdio];
  redirected[1] = process.stderr;
  return redirected;
}

/**
 * Run `fn` with writes to `process.stdout` sent to `process.stderr` instead,
 * restoring the original stdout writer afterwards (even if `fn` throws).
 *
 * Machine-readable command paths (`--json`) emit a structured document on
 * stdout. Some shared code they call prints human-facing progress to stdout
 * via `console.log` (for example, `status` reconciles the gateway and the
 * recovery path streams gateway-start progress). On a `--json` path that
 * progress would interleave with the JSON document and make stdout
 * unparseable, so it is redirected to stderr, where it stays visible to a
 * human without corrupting the machine output.
 */
export async function withStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T> {
  if (stdoutRedirectDepth === 0) {
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  }
  stdoutRedirectDepth += 1;
  try {
    return await fn();
  } finally {
    stdoutRedirectDepth -= 1;
    if (stdoutRedirectDepth === 0 && originalStdoutWrite) {
      process.stdout.write = originalStdoutWrite;
      originalStdoutWrite = null;
    }
  }
}
