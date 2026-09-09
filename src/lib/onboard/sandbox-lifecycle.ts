// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "../state/onboard-session";
import type { SandboxEntry, SandboxMcpState } from "../state/registry";
import * as registry from "../state/registry";
import type { SelectionDrift } from "./selection-drift";

export function removeSandboxUnlessSessionReservation(
  entry: SandboxEntry | null,
  sandboxName: string,
): void {
  const session = onboardSession.loadSession();
  const recreate = session?.checkpoint?.sandboxRecreate;
  if (registry.isPendingReservationForSession(entry, session?.sessionId)) return;
  if (entry?.pendingRouteReservation === true) {
    if (!session || !onboardSession.isOnboardLockHeldByCurrentProcess()) return;
    if (!registry.removeSandboxRouteReservationIfCurrent(entry)) {
      throw new Error(
        `Cannot recreate sandbox '${sandboxName}' because its pending create recovery state is protected or changed. Run the same onboarding command with \`--resume\` to continue the saved onboarding session. NemoClaw removes the reservation only when that session retains authority.`,
      );
    }
    return;
  }
  if (recreate?.sandboxName === sandboxName && recreate.phase !== "completed") {
    return;
  }
  registry.removeSandbox(sandboxName);
}

export interface SandboxLifecycleDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  getGatewayName(): string;
  fetchGatewayAuthTokenFromSandbox(sandboxName: string): string | null;
  agentProductName(): string;
  prompt(question: string): Promise<string>;
  isAffirmativeAnswer(value: string | null | undefined): boolean;
}

export interface SandboxLifecycleHelpers {
  inspectSandboxForCreate(sandboxName: string): {
    existingEntry: SandboxEntry | null;
    preservedMcpState: SandboxMcpState | undefined;
    liveExists: boolean;
  };
  shouldRestoreLatestBackupOnRecreate(): boolean;
  confirmRecreateForSelectionDrift(
    sandboxName: string,
    drift: SelectionDrift,
    requestedProvider: string | null,
    requestedModel: string | null,
  ): Promise<boolean>;
  isOpenclawReady(sandboxName: string): boolean;
}

export function createSandboxLifecycleHelpers(deps: SandboxLifecycleDeps): SandboxLifecycleHelpers {
  function sandboxExistsInGateway(sandboxName: string): boolean {
    const output = deps.runCaptureOpenshell(
      ["sandbox", "get", "--gateway", deps.getGatewayName(), sandboxName],
      { ignoreError: true },
    );
    return Boolean(output);
  }

  function inspectSandboxForCreate(sandboxName: string) {
    const existingEntry = registry.getSandbox(sandboxName);
    if (existingEntry?.mcp?.destroyPreparedAt || existingEntry?.mcp?.destroyPendingAt) {
      throw new Error(
        `Sandbox '${sandboxName}' has an incomplete MCP destroy transaction. Re-run the sandbox destroy command to finish cleanup before recreating it.`,
      );
    }
    const preservedMcpState =
      existingEntry?.mcp && Object.keys(existingEntry.mcp.bridges).length > 0
        ? existingEntry.mcp
        : undefined;
    // MCP state is the rebuild transaction manifest. Preserve it while the
    // sandbox is absent; registration carries the validated state forward.
    const liveExists = sandboxExistsInGateway(sandboxName);
    return { existingEntry, preservedMcpState, liveExists };
  }

  function shouldRestoreLatestBackupOnRecreate(): boolean {
    return process.env.NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE === "1";
  }

  async function confirmRecreateForSelectionDrift(
    sandboxName: string,
    drift: SelectionDrift,
    requestedProvider: string | null,
    requestedModel: string | null,
  ): Promise<boolean> {
    const currentProvider = drift.existingProvider || "unknown";
    const currentModel = drift.existingModel || "unknown";
    const nextProvider = requestedProvider || "unknown";
    const nextModel = requestedModel || "unknown";

    console.log(`  Sandbox '${sandboxName}' exists but requested inference selection changed.`);
    console.log(`  Current:   provider=${currentProvider}  model=${currentModel}`);
    console.log(`  Requested: provider=${nextProvider}  model=${nextModel}`);
    console.log(
      `  Recreating the sandbox is required to apply this change to the running ${deps.agentProductName()} UI.`,
    );

    const answer = await deps.prompt(`  Recreate sandbox '${sandboxName}' now? [y/N]: `);
    return deps.isAffirmativeAnswer(answer);
  }

  function isOpenclawReady(sandboxName: string): boolean {
    return Boolean(deps.fetchGatewayAuthTokenFromSandbox(sandboxName));
  }

  return {
    inspectSandboxForCreate,
    shouldRestoreLatestBackupOnRecreate,
    confirmRecreateForSelectionDrift,
    isOpenclawReady,
  };
}
