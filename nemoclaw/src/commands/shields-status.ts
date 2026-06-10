// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw shields`.
 *
 * Routes the optional sub-argument:
 *   - empty / `status` — reports the current shields state (read-only).
 *   - `up` / `down`    — returns host-only guidance pointing at the host CLI.
 *   - anything else    — returns an `Unknown argument` message with usage.
 *
 * Shields can only be lowered or raised from the host CLI (security invariant).
 */

import type { PluginCommandResult } from "../index.js";
import { loadState } from "../blueprint/state.js";

const MAX_ARG_DISPLAY_LEN = 32;

function sanitiseArgForDisplay(raw: string): string {
  const stripped = raw.replace(/[\x00-\x1F\x7F`]/g, "?");
  return stripped.length > MAX_ARG_DISPLAY_LEN
    ? `${stripped.slice(0, MAX_ARG_DISPLAY_LEN)}…`
    : stripped;
}

export function slashShieldsStatus(arg?: string): PluginCommandResult {
  const trimmed = (arg ?? "").trim();

  if (trimmed === "up" || trimmed === "down") {
    return {
      text: [
        `**Shields ${trimmed}** is host-only.`,
        "",
        "Sandbox shields can only be raised or lowered from the host CLI:",
        "",
        "```",
        `nemoclaw <name> shields ${trimmed}`,
        "```",
        "",
        "Inside the sandbox, `/nemoclaw shields` is read-only. Use `/nemoclaw shields` or `/nemoclaw shields status` to see the current state.",
      ].join("\n"),
    };
  }

  if (trimmed !== "" && trimmed !== "status") {
    return {
      text: [
        `**Unknown argument:** \`${sanitiseArgForDisplay(trimmed)}\``,
        "",
        "Usage: `/nemoclaw shields [status]`",
        "",
        "Shields can only be raised or lowered from the host CLI: `nemoclaw <name> shields up|down`.",
      ].join("\n"),
    };
  }

  const state = loadState();

  if (!state.shieldsDown) {
    const lines = ["**Shields: UP**", "", "Sandbox policy is at normal security level."];

    if (state.shieldsPolicySnapshotPath) {
      lines.push("", `Last lowered: policy snapshot at ${state.shieldsPolicySnapshotPath}`);
    }

    return { text: lines.join("\n") };
  }

  const downSince = state.shieldsDownAt ? new Date(state.shieldsDownAt) : null;
  const elapsed = downSince ? Math.floor((Date.now() - downSince.getTime()) / 1000) : 0;
  const remaining =
    state.shieldsDownTimeout != null ? Math.max(0, state.shieldsDownTimeout - elapsed) : null;

  const lines = ["**Shields: DOWN**", "", `Since: ${state.shieldsDownAt ?? "unknown"}`];

  if (remaining !== null) {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    lines.push(`Timeout: ${String(mins)}m ${String(secs)}s remaining`);
  }

  lines.push(`Reason: ${state.shieldsDownReason ?? "not specified"}`);
  lines.push(`Policy: ${state.shieldsDownPolicy ?? "permissive"}`);
  lines.push(
    "",
    "**Warning:** Sandbox security is relaxed. Run `nemoclaw shields up` from the host when done.",
  );

  return { text: lines.join("\n") };
}
