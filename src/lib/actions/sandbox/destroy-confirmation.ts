// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import type { DestroySandboxOptions } from "../../domain/lifecycle/options";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
  type SandboxSession,
} from "../../state/sandbox-session";

function findActiveSandboxSessions(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): SandboxSession[] {
  const opsBin = resolveOpenshell();
  if (!opsBin) return [];
  try {
    const result = getActiveSandboxSessions(
      sandboxName,
      createSessionDeps(opsBin, runtimeSelection ? { runtimeSelection } : {}),
    );
    return result.detected ? result.sessions : [];
  } catch {
    return [];
  }
}

function printActiveSessionWarning(sessions: SandboxSession[]): void {
  if (sessions.length < 1) return;
  const plural = sessions.length > 1 ? "sessions" : "session";
  // #9855 asked for the detected PIDs, not just a count, so the operator can
  // identify whose session is about to break before they confirm the destroy.
  const pids =
    sessions.length === 1
      ? `PID ${sessions[0]?.pid}`
      : `PIDs ${sessions.map((session) => session.pid).join(", ")}`;
  console.log(
    `  ${YW}⚠  Active SSH ${plural} detected (${sessions.length} connection${sessions.length > 1 ? "s" : ""}, ${pids})${R}`,
  );
  console.log(
    `  Destroying will terminate ${sessions.length === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
  );
}

export function assertSandboxDestroyCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "sandbox:destroy");
}

export async function confirmSandboxDestroy(
  sandboxName: string,
  options: DestroySandboxOptions,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean> {
  const activeSessions = findActiveSandboxSessions(sandboxName, runtimeSelection);
  // #9855: --yes/--force waives the confirmation prompt, not the notice that
  // this destroy is about to break somebody else's live SSH session. Without
  // this the operator sees no warning and the connected terminal just gets a
  // Broken pipe.
  if (options.yes === true || options.force === true) {
    printActiveSessionWarning(activeSessions);
    return true;
  }

  console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
  printActiveSessionWarning(activeSessions);
  console.log("  This will permanently delete the sandbox and all workspace files inside it.");
  console.log("  This cannot be undone.");
  const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
  if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
    return true;
  }
  console.log("  Cancelled.");
  return false;
}
