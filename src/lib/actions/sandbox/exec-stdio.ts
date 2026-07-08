// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StdioOptions } from "node:child_process";
import { isStdinTty } from "../../core/stdin";
import type { SandboxExecOptions } from "./exec";

export function shouldInheritSandboxExecStdin(
  requested: boolean | undefined,
  stdinIsTty: boolean | undefined,
): boolean {
  if (typeof requested === "boolean") return requested;
  return stdinIsTty === true;
}

export function buildSandboxExecStdio(
  options: SandboxExecOptions = {},
  stdinIsTty: boolean | undefined = isStdinTty(),
): StdioOptions {
  return shouldInheritSandboxExecStdin(options.stdin, stdinIsTty)
    ? "inherit"
    : ["ignore", "inherit", "inherit"];
}
