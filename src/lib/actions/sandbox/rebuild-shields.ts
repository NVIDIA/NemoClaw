// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type BackupShieldsWindow,
  openBackupShieldsWindow,
  relockBackupShieldsWindow,
} from "./backup-shields-window";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime";

export type RebuildShieldsWindow = BackupShieldsWindow;

function rebuildShieldsWindowOptions(
  sandboxName: string,
  cliName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
) {
  return {
    operation: "rebuild backup",
    reason: "auto-unlock for rebuild",
    retryCommand: `${cliName} ${sandboxName} rebuild`,
    shieldsUpCommand: `${cliName} ${sandboxName} shields up`,
    // The timer's deadline remains authoritative if rebuild dies, but it
    // must not lock a replacement halfway through an active recreate. The
    // exact rebuild PID/start identity acts as a renewable liveness lease;
    // after owner death the timer retries until restoration can complete.
    deferAutoRestoreWhileOwnerAlive: true,
    // Existing Hermes sandboxes may predate the sealed root-guard protocol.
    // Only the replacement flow may use this descriptor-safe compatibility
    // transition; ordinary backup-all keeps the strict current protocol.
    allowLegacyHermesProtocol: true,
    ...(runtimeSelection ? { runtimeSelection } : {}),
  };
}

export function openRebuildShieldsWindow(
  sandboxName: string,
  cliName: string,
): RebuildShieldsWindow | null {
  return openBackupShieldsWindow(sandboxName, rebuildShieldsWindowOptions(sandboxName, cliName));
}

export function relockRebuildShieldsWindow(
  sandboxName: string,
  window: RebuildShieldsWindow,
  sandboxStillExists: boolean,
  cliName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): boolean {
  return relockBackupShieldsWindow(
    sandboxName,
    window,
    sandboxStillExists,
    rebuildShieldsWindowOptions(sandboxName, cliName, runtimeSelection),
  );
}
