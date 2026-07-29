// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Linux rejects any single execve(2) argument at MAX_ARG_STRLEN (128 KiB on
 * the minimum supported 4 KiB page size), independently of aggregate ARG_MAX.
 * Keep an explicit 8 KiB reserve for wrappers and the terminating NUL.
 */
export const SANDBOX_CREATE_MAX_ARGUMENT_BYTES = 120 * 1024;

export function assertSandboxCreateArgvWithinTransportLimit(createArgv: readonly string[]): void {
  for (const argument of createArgv) {
    if (Buffer.byteLength(argument, "utf8") + 1 > SANDBOX_CREATE_MAX_ARGUMENT_BYTES) {
      throw new Error(
        "Sandbox create launch exceeds the safe per-argument transport limit; reduce the managed startup profile or corporate CA bundle.",
      );
    }
  }
}
