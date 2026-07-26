// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import {
  type DcodeAutoApprovalMode,
  hasDcodeAutoApprovalDrift,
  resolveDcodeAutoApprovalRequest,
} from "../../dcode-auto-approval";
import { usesManagedDcodeIdentity } from "../../dcode-selection-drift";
import type { SandboxResumeDecision } from "./sandbox-resume";

export interface Deps {
  getDcodeSelectionDrift(
    sandboxName: string,
    provider: string,
    model: string,
    preferredInferenceApi: string | null,
  ): { changed: boolean; unknown: boolean };
  error(message?: string): void;
  exitProcess(code: number): never;
}

interface SelectionOptions<Agent> {
  readonly agent: Agent;
  readonly fromDockerfile: string | null;
  readonly provider: string;
  readonly model: string;
}

interface ResumeOptions<Agent> extends SelectionOptions<Agent> {
  readonly resume: boolean;
  readonly preferredInferenceApi: string | null;
  readonly requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
}

interface ResumeState {
  readonly session: Session | null;
  readonly sandboxName: string | null;
}

function agentName<Agent>(agent: Agent): string | null | undefined {
  return (agent as { name?: string } | null | undefined)?.name;
}

export function resolveAutoApprovalMode<Agent>(
  options: SelectionOptions<Agent> & {
    readonly requestedDcodeAutoApprovalMode?: DcodeAutoApprovalMode | null;
  },
  sandboxName: string | null,
  deps: Pick<Deps, "error" | "exitProcess"> & {
    getSandboxRegistryEntry(name: string): SandboxEntry | null;
  },
): DcodeAutoApprovalMode {
  const registryEntry = sandboxName ? deps.getSandboxRegistryEntry(sandboxName) : null;
  const resolution = resolveDcodeAutoApprovalRequest({
    agent: usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile)
      ? agentName(options.agent)
      : null,
    requestedMode: options.requestedDcodeAutoApprovalMode,
    recordedMode: registryEntry?.dcodeAutoApprovalMode,
  });
  if (!resolution.error) return resolution.mode;
  deps.error(resolution.error);
  return deps.exitProcess(1);
}

export function preserveManagedDcodeRegistryEntry<Agent>(
  options: SelectionOptions<Agent>,
  decision: SandboxResumeDecision,
): SandboxResumeDecision {
  if (
    decision.kind !== "recreate" ||
    !decision.removeRegistryEntry ||
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile)
  ) {
    return decision;
  }
  return { ...decision, removeRegistryEntry: false };
}

export function resolveSignals<Agent>(
  options: ResumeOptions<Agent>,
  state: ResumeState,
  sandboxReuseState: string,
  registryEntry: SandboxEntry | null,
  dcodeAutoApprovalMode: DcodeAutoApprovalMode,
  deps: Deps,
): { inferenceSelectionChanged: boolean; dcodeAutoApprovalChanged: boolean } {
  const sandboxName = state.sandboxName;
  const dcodeAutoApprovalChanged = hasDcodeAutoApprovalDrift({
    liveExists: sandboxReuseState === "ready",
    managedDcodeAgent: usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile),
    hasRegistryEntry: registryEntry !== null,
    recordedDcodeAutoApprovalMode: registryEntry?.dcodeAutoApprovalMode,
    requestedDcodeAutoApprovalMode: dcodeAutoApprovalMode,
  });
  if (
    !options.resume ||
    state.session?.steps?.sandbox?.status !== "complete" ||
    !sandboxName ||
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile) ||
    sandboxReuseState !== "ready"
  ) {
    return { inferenceSelectionChanged: false, dcodeAutoApprovalChanged };
  }
  if (!registryEntry) {
    deps.error(
      `  Sandbox '${sandboxName}' is live but missing its NemoClaw registry record; refusing unverified DCode reuse.`,
    );
    return deps.exitProcess(1);
  }
  const drift = deps.getDcodeSelectionDrift(
    sandboxName,
    options.provider,
    options.model,
    options.preferredInferenceApi,
  );
  return {
    inferenceSelectionChanged: Boolean(drift.changed || drift.unknown),
    dcodeAutoApprovalChanged,
  };
}

export function selectionFidelity<Agent>(
  options: SelectionOptions<Agent>,
  existing: SandboxEntry | null,
): Partial<Pick<SandboxEntry, "provider" | "model">> {
  if (
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile) ||
    (existing?.provider === options.provider && existing?.model === options.model)
  ) {
    return {};
  }
  return { provider: options.provider, model: options.model };
}
