// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import type { DestroySandboxOptions } from "../../domain/lifecycle/options";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";

function countActiveSandboxSessions(sandboxName: string): number {
  const opsBin = resolveOpenshell();
  if (!opsBin) return 0;
  try {
    const result = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBin));
    return result.detected ? result.sessions.length : 0;
  } catch {
    return 0;
  }
}

export async function confirmSandboxDestroy(
  sandboxName: string,
  options: DestroySandboxOptions,
): Promise<boolean> {
  // Preserve the existing best-effort session probe even for pre-confirmed
  // destroys; callers historically performed it before checking --yes/--force.
  const activeSessionCount = countActiveSandboxSessions(sandboxName);
  if (options.yes === true || options.force === true) return true;

  console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
  if (activeSessionCount > 0) {
    const plural = activeSessionCount > 1 ? "sessions" : "session";
    console.log(
      `  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`,
    );
    console.log(
      `  Destroying will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
    );
  }
  console.log("  This will permanently delete the sandbox and all workspace files inside it.");
  console.log("  This cannot be undone.");
  const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
  if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
    return true;
  }
  console.log("  Cancelled.");
  return false;
}
