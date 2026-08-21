// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import type { DestroySandboxOptions } from "../../domain/lifecycle/options";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
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

function printActiveSessionWarning(activeSessionCount: number): void {
  if (activeSessionCount < 1) return;
  const plural = activeSessionCount > 1 ? "sessions" : "session";
  console.log(
    `  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`,
  );
  console.log(
    `  Destroying will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
  );
}

export function assertSandboxDestroyCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "sandbox:destroy");
}

export async function confirmSandboxDestroy(
  sandboxName: string,
  options: DestroySandboxOptions,
): Promise<boolean> {
  const activeSessionCount = countActiveSandboxSessions(sandboxName);
  // #9855: --yes/--force waives the confirmation prompt, not the notice that
  // this destroy is about to break somebody else's live SSH session. Without
  // this the operator sees no warning and the connected terminal just gets a
  // Broken pipe.
  if (options.yes === true || options.force === true) {
    printActiveSessionWarning(activeSessionCount);
    return true;
  }

  console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
  printActiveSessionWarning(activeSessionCount);
  console.log("  This will permanently delete the sandbox and all workspace files inside it.");
  console.log("  This cannot be undone.");
  const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
  if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
    return true;
  }
  console.log("  Cancelled.");
  return false;
}
