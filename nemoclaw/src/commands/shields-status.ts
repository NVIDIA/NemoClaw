// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw shields`.
 *
 * Routes the optional sub-argument:
 *   - empty / `status` — points to authoritative host-side status.
 *   - `up` / `down`    — returns host-only guidance pointing at the host CLI.
 *   - anything else    — returns an `Unknown argument` message with usage.
 *
 * Shields state is owned by the host CLI and is not projected into the plugin.
 */

import type { PluginCommandResult } from "../index.js";

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
        "Inside the sandbox, `/nemoclaw shields` is read-only and cannot verify shields status.",
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

  return {
    text: [
      "**Shields status unavailable inside the sandbox**",
      "",
      "This command cannot verify the host-side shields posture. Run `nemoclaw <name> shields status` from the host for authoritative status.",
    ].join("\n"),
  };
}
