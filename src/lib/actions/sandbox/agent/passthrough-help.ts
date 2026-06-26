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
    "  Every invocation must include at least one target selector — --agent, --session-id,",
  );
  console.log(
    "  --session-key, or --to. On Ready/Running sandboxes, invocations without a selector",
  );
  console.log(
    "  exit 2 with `No target session selected` before any in-sandbox dispatch runs; on a",
  );
  console.log(
    "  non-Ready sandbox the phase guard fires first and exits 1 with recovery commands.",
  );
  console.log("");
  console.log(
    "  Currently supported on OpenClaw sandboxes only; Hermes sandboxes are rejected with a",
  );
  console.log("  redirect to the OpenAI-compatible API on port 8642 inside the sandbox.");
  console.log("");
}
