// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";

export function hasAgentPassthroughHelpToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

export function printAgentPassthroughHelp(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <name> agent [agent-flags...]`);
  console.log("");
  console.log(
    "  Pass-through to the sandbox's registered agent command via `openshell sandbox exec`.",
  );
  console.log("  OpenClaw sandboxes run `openclaw agent ...`; terminal-runtime sandboxes run");
  console.log(
    "  their manifest-declared interactive command, such as `dcode ...` for Deep Agents Code.",
  );
  console.log("  All flags accepted by the selected in-sandbox agent CLI are forwarded verbatim.");
  console.log(
    "  Common OpenClaw flags: -m <text>, --session-id <id>, --agent <id>, --json, --thinking <level>.",
  );
  console.log("");
  console.log(`  For terminal-runtime help, run \`${CLI_NAME} <name> agent --help\` to view the`);
  console.log("  upstream command help from inside the sandbox.");
  console.log("");
  console.log("  Hermes sandboxes are rejected with a");
  console.log("  redirect to the OpenAI-compatible API on port 8642 inside the sandbox.");
  console.log("");
}
