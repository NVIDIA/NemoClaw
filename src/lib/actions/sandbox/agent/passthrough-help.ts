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
  console.log(`  Usage: ${CLI_NAME} <name> agent [openclaw-agent-flags...]`);
  console.log("");
  console.log(
    "  Pass-through to `openclaw agent ...` inside the sandbox via `openshell sandbox exec`.",
  );
  console.log("  All flags accepted by the in-sandbox OpenClaw CLI are forwarded verbatim.");
  console.log(
    "  Common flags: -m <text>, --session-id <id>, --agent <id>, --json, --thinking <level>.",
  );
  console.log("");
  console.log(
    "  Currently supported on OpenClaw sandboxes only; Hermes sandboxes are rejected with a",
  );
  console.log("  redirect to the OpenAI-compatible API on port 8642 inside the sandbox.");
  console.log("");
}
