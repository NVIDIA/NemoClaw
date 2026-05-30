// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";

export type SessionsPassthroughVerb = "list" | "cleanup" | "export-trajectory";

export interface SessionsPassthroughOptions {
  verb?: SessionsPassthroughVerb;
  extraArgs?: readonly string[];
}

export async function runSessionsPassthrough(
  sandboxName: string,
  { verb, extraArgs = [] }: SessionsPassthroughOptions = {},
): Promise<void> {
  await ensureLiveSandboxOrExit(sandboxName, { allowNonReadyPhase: true });
  const command = ["openclaw", "sessions"];
  if (verb) command.push(verb);
  for (const arg of extraArgs) command.push(arg);
  await execSandbox(sandboxName, command);
}
