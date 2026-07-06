// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
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
}

interface ResumeState {
  readonly session: Session | null;
  readonly sandboxName: string | null;
}

function agentName<Agent>(agent: Agent): string | null | undefined {
  return (agent as { name?: string } | null | undefined)?.name;
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
  deps: Deps,
): { inferenceSelectionChanged: boolean } {
  const sandboxName = state.sandboxName;
  if (
    !options.resume ||
    state.session?.steps?.sandbox?.status !== "complete" ||
    !sandboxName ||
    !usesManagedDcodeIdentity(agentName(options.agent), options.fromDockerfile) ||
    sandboxReuseState !== "ready"
  ) {
    return { inferenceSelectionChanged: false };
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
  return { inferenceSelectionChanged: Boolean(drift.changed || drift.unknown) };
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
