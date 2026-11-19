// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import type { DestroySandboxOptions } from "../../domain/lifecycle/options";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { getLatestBackup } from "../../state/sandbox";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
  type SandboxSession,
} from "../../state/sandbox-session";

function findActiveSandboxSessions(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  registeredGatewayName?: string,
): SandboxSession[] {
  const opsBin = resolveOpenshell();
  if (!opsBin) return [];
  try {
    const result = getActiveSandboxSessions(
      sandboxName,
      createSessionDeps(opsBin, runtimeSelection ? { runtimeSelection } : {}),
      registeredGatewayName ?? runtimeSelection?.gatewayName,
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
    `  ${YW}⚠  Active ${plural} detected (${sessions.length} connection${sessions.length > 1 ? "s" : ""}, ${pids})${R}`,
  );
  console.log(
    `  Destroying will terminate ${sessions.length === 1 ? "the" : "all"} active ${plural}; running commands will be interrupted.`,
  );
}

export function assertSandboxDestroyCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "sandbox:destroy");
}

export async function confirmSandboxDestroy(
  sandboxName: string,
  options: DestroySandboxOptions,
  runtimeSelection?: OpenShellRuntimeSelection,
  registeredGatewayName?: string,
): Promise<boolean> {
  const activeSessions = findActiveSandboxSessions(
    sandboxName,
    runtimeSelection,
    registeredGatewayName,
  );
  // #9855: --yes/--force waives the confirmation prompt, not the notice that
  // this destroy is about to interrupt somebody else's live session. Without
  // this the operator sees no warning and the connected terminal is cut off.
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

/** Tell the user where the pre-upgrade or pre-rebuild backup is, without touching it. */
export function printRetainedBackupLocation(sandboxName: string): void {
  let backupPath: string | null = null;
  try {
    backupPath = getLatestBackup(sandboxName)?.backupPath ?? null;
  } catch {
    console.error(
      `  NemoClaw could not read the rebuild-backups directory for '${sandboxName}', so it cannot say whether a backup exists. Check the directory permissions before any manual cleanup.`,
    );
    return;
  }
  if (backupPath) {
    console.error(
      `  Your files are preserved in the backup at: ${backupPath} (native-home.tar holds the agent home and workspace). Copy it somewhere safe before any manual cleanup.`,
    );
  } else {
    console.error(
      `  No complete backup was found for '${sandboxName}' under the NemoClaw rebuild-backups directory.`,
    );
  }
}
