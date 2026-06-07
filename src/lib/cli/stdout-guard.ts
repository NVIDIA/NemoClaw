// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
export async function withStdoutRedirectedToStderr<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(
    process.stderr,
  ) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}
