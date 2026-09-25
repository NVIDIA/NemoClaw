// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import type { SandboxCommandResult } from "../../adapters/sandbox/command-transport";
import { executeOrdinarySandboxCommand } from "../../adapters/sandbox/ordinary-command";

export const HERMES_DASHBOARD_STATE_MIGRATION_COMMAND =
  "/opt/hermes/.venv/bin/python3 -I /usr/local/lib/nemoclaw/migrate-hermes-dashboard-state.py --hermes-dir /sandbox/.hermes";

export function migrateHermesLegacyDashboardState(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<SandboxCommandResult | null> {
  return executeOrdinarySandboxCommand(
    sandboxName,
    HERMES_DASHBOARD_STATE_MIGRATION_COMMAND,
    30_000,
    {
      ...(runtimeSelection ? { runtimeSelection } : {}),
    },
  );
}

interface SnapshotStateFile {
  path: string;
  strategy: "copy" | "sqlite_backup";
}

/**
 * Recommend a gateway restart after restoring a Hermes SQLite state file.
 *
 * The restored SQLite databases replace files the running Hermes gateway
 * still holds open, so it serves pre-restore state until it reopens them
 * (#7312).
 */
export function printHermesGatewayRestoreHint(
  sandboxName: string,
  agentName: string | null | undefined,
  restoredFiles: readonly string[],
  snapshotStateFiles: readonly SnapshotStateFile[],
  cliName: string,
  writeLine: (message: string) => void = console.log,
): void {
  if (agentName !== "hermes") return;
  const restoredFileSet = new Set(restoredFiles);
  const restoredSqliteDatabase = snapshotStateFiles.some(
    (stateFile) => stateFile.strategy === "sqlite_backup" && restoredFileSet.has(stateFile.path),
  );
  if (!restoredSqliteDatabase) return;
  writeLine(
    `  Restart the gateway to open the restored state databases: run \`${cliName} ${sandboxName} gateway restart\``,
  );
}
