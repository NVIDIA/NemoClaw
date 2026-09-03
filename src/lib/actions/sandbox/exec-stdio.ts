// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxExecOptions } from "./exec";
import {
  buildSandboxCommandStdio,
  shouldInheritSandboxCommandStdin,
} from "../../adapters/openshell/sandbox-command-stdio";

export const shouldInheritSandboxExecStdin = shouldInheritSandboxCommandStdin;

export function buildSandboxExecStdio(options: SandboxExecOptions = {}, stdinIsTty?: boolean) {
  return buildSandboxCommandStdio(options, stdinIsTty);
}
