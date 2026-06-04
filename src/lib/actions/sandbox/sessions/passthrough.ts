// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";

export type SessionsPassthroughVerb = "list";

export interface SessionsPassthroughOptions {
  verb?: SessionsPassthroughVerb;
  extraArgs?: readonly string[];
}

export function hasSessionsPassthroughHelpToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function printSessionsPassthroughHelp(verb?: SessionsPassthroughVerb): void {
  const usageSuffix = verb ? ` ${verb}` : "";
  const flagsToken = verb ? `openclaw-sessions-${verb}-flags` : "openclaw-sessions-flags";
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> sessions${usageSuffix} [${flagsToken}...]`);
  console.log("");
  console.log(
    `  Pass-through to \`openclaw sessions${usageSuffix} ...\` inside the sandbox via \`openshell sandbox exec\`.`,
  );
  console.log("  All flags accepted by the in-sandbox OpenClaw CLI are forwarded verbatim.");
  console.log("");
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
