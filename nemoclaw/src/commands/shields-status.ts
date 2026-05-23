// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slash command handler for `/nemoclaw shields status`.
 *
 * Read-only — reports the current shields state from inside the sandbox.
 * Shields can only be lowered or raised from the host CLI (security invariant).
 */

import type { PluginCommandResult } from "../index.js";
import { loadState } from "../blueprint/state.js";

export function slashShieldsStatus(): PluginCommandResult {
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
