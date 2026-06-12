// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxEntry } from "../state/registry";
import * as registry from "../state/registry";
import { bestEffortForwardStop } from "./forward-cleanup";
import {
  getHermesDashboardRegistryFields,
  type HermesDashboardOnboardState,
} from "./hermes-dashboard";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

export interface SandboxReuseDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  runOpenshell(args: string[], opts?: Record<string, unknown>): unknown;
  getSandboxStateFromOutputs(sandboxName: string, getOutput: string, listOutput: string): string;
  note(message: string): void;
}

export interface SandboxReuseHelpers {
  getSandboxReuseState(sandboxName: string | null): string;
  repairRecordedSandbox(sandboxName: string | null): void;
}

export interface ReusedSandboxDashboardForwarding {
  resolveStateForPort(effectivePort: number): HermesDashboardOnboardState;
  ensureForState(state: HermesDashboardOnboardState, sandboxName: string): void;
}

export interface ReusedSandboxDashboardStateInput {
  sandboxName: string;
  chatUiUrl: string;
  env: NodeJS.ProcessEnv;
  agent: AgentDefinition | null | undefined;
  model: string;
  provider: string;
  selectionVerified: boolean;
  sandboxGpuConfig: SandboxGpuConfig;
  gatewayName: string;
  gatewayPort: number;
  ensureDashboardForward(sandboxName: string, chatUiUrl: string): number;
  hermesDashboardForwarding: ReusedSandboxDashboardForwarding;
  updateSandbox?(sandboxName: string, updates: Partial<SandboxEntry>): unknown;
  updateReusedSandboxMetadata(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
    model: string,
    provider: string,
    dashboardPort: number,
    selectionVerified: boolean,
    sandboxGpuConfig: SandboxGpuConfig,
  ): void;
}

export interface ReusedSandboxDashboardStateResult {
  chatUiUrl: string;
  dashboardPort: number;
  hermesDashboardState: HermesDashboardOnboardState;
}

export function applyReusedSandboxDashboardState(
  input: ReusedSandboxDashboardStateInput,
): ReusedSandboxDashboardStateResult {
  const dashboardPort = input.ensureDashboardForward(input.sandboxName, input.chatUiUrl);
  const chatUiUrl = `http://127.0.0.1:${dashboardPort}`;
  input.env.CHAT_UI_URL = chatUiUrl;
  const hermesDashboardState = input.hermesDashboardForwarding.resolveStateForPort(dashboardPort);
  input.hermesDashboardForwarding.ensureForState(hermesDashboardState, input.sandboxName);
  input.updateReusedSandboxMetadata(
    input.sandboxName,
    input.agent,
    input.model,
    input.provider,
    dashboardPort,
    input.selectionVerified,
    input.sandboxGpuConfig,
  );
  (input.updateSandbox ?? registry.updateSandbox)(input.sandboxName, {
    ...getHermesDashboardRegistryFields(hermesDashboardState),
    gatewayName: input.gatewayName,
    gatewayPort: input.gatewayPort,
  });
  return { chatUiUrl, dashboardPort, hermesDashboardState };
}

export function createSandboxReuseHelpers(deps: SandboxReuseDeps): SandboxReuseHelpers {
  function getSandboxReuseState(sandboxName: string | null): string {
    if (!sandboxName) return "missing";
    const getOutput = deps.runCaptureOpenshell(["sandbox", "get", sandboxName], {
      ignoreError: true,
    });
    const listOutput = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
    return deps.getSandboxStateFromOutputs(sandboxName, getOutput, listOutput);
  }

  function repairRecordedSandbox(sandboxName: string | null): void {
    if (!sandboxName) return;
    deps.note(`  [resume] Cleaning up recorded sandbox '${sandboxName}' before recreating it.`);
    bestEffortForwardStop(deps.runOpenshell, DASHBOARD_PORT);
    deps.runOpenshell(["sandbox", "delete", sandboxName], { ignoreError: true });
    registry.removeSandbox(sandboxName);
  }

  return { getSandboxReuseState, repairRecordedSandbox };
}
