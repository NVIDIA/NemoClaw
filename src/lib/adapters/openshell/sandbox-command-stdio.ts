// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";

import { isStdinTty } from "../../core/stdin";

export function shouldInheritSandboxCommandStdin(
  requested: boolean | undefined,
  stdinIsTty: boolean | undefined,
): boolean {
  if (typeof requested === "boolean") return requested;
  return stdinIsTty === true;
}

export function buildSandboxCommandStdio(
  options: { stdin?: boolean } = {},
  stdinIsTty: boolean | undefined = isStdinTty(),
): StdioOptions {
  return shouldInheritSandboxCommandStdin(options.stdin, stdinIsTty)
    ? "inherit"
    : ["ignore", "inherit", "inherit"];
}
