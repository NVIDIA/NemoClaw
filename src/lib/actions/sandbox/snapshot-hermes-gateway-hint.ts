// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import type {
  SandboxCommandResult,
  SandboxExecCommandExecutionOptions,
} from "../../adapters/sandbox/command-transport";
import { executeOrdinarySandboxCommand } from "../../adapters/sandbox/ordinary-command";

export const HERMES_DASHBOARD_STATE_MIGRATION_COMMAND =
  "/opt/hermes/.venv/bin/python3 -I /usr/local/lib/nemoclaw/migrate-hermes-dashboard-state.py --hermes-dir /sandbox/.hermes";
export const HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT_MS = 30 * 60_000;

export function hermesDashboardStateMigrationRecoveryGuidance(sandboxName: string): string {
  return `Hermes home /sandbox/.hermes in sandbox '${sandboxName}' may contain a partial legacy dashboard-state migration. Inspect and reconcile that home before retrying restore.`;
}

export function migrateHermesLegacyDashboardState(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  executionOptions: Pick<
    SandboxExecCommandExecutionOptions,
    "commandExecutor" | "gatewayName"
  > = {},
): Promise<SandboxCommandResult | null> {
  return executeOrdinarySandboxCommand(
    sandboxName,
    HERMES_DASHBOARD_STATE_MIGRATION_COMMAND,
    HERMES_DASHBOARD_STATE_MIGRATION_TIMEOUT_MS,
    {
      honorCallerTimeout: true,
      ...executionOptions,
      ...(runtimeSelection ? { runtimeSelection } : {}),
    },
  );
}
