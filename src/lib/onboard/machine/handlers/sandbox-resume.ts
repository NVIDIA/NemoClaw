// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { normalizeToolDisclosure, toolDisclosureOrDefault } from "../../../tool-disclosure";

export interface SandboxResumeSignals {
  readonly resume: boolean;
  readonly resumeAgentChanged: boolean;
  readonly sandboxStepComplete: boolean;
  readonly sandboxReuseState: string;
  readonly inferenceRouteConfigChanged: boolean;
  readonly webSearchConfigChanged: boolean;
  readonly sandboxGpuConfigChanged: boolean;
  readonly messagingChannelConfigChanged: boolean;
  readonly hermesToolGatewayConfigChanged: boolean;
  readonly toolDisclosureMigrationNeeded: boolean;
  readonly toolDisclosureChanged: boolean;
}

interface InferenceRouteResumeInput {
  readonly agentName: string | null | undefined;
  readonly provider: string | null | undefined;
  readonly model: string | null | undefined;
  readonly preferredInferenceApi: string | null;
  readonly registryEntry: SandboxEntry | null;
}

export function hasHermesCompatibleAnthropicInferenceRouteDrift({
  agentName,
  provider,
  model,
  preferredInferenceApi,
  registryEntry,
}: InferenceRouteResumeInput): boolean {
  if (
    agentName !== "hermes" ||
    provider !== "compatible-anthropic-endpoint" ||
    preferredInferenceApi !== "openai-completions" ||
    !model
  ) {
    return false;
  }

  // The registry records what was baked into the existing sandbox. Do not
  // fall back to the session: provider setup repairs that session before the
  // sandbox decision runs, which could make a stale sandbox look migrated.
  // Missing legacy metadata is therefore drift and triggers a one-time rebuild.
  if (!registryEntry) return true;
  return (
    registryEntry.provider !== provider ||
    registryEntry.model !== model ||
    registryEntry.preferredInferenceApi !== preferredInferenceApi
  );
}

export function resolveToolDisclosureResumeSignals(
  registryEntry: SandboxEntry | null,
  session: Session | null,
): Pick<SandboxResumeSignals, "toolDisclosureMigrationNeeded" | "toolDisclosureChanged"> {
  const recorded = normalizeToolDisclosure(registryEntry?.toolDisclosure);
  const migrationNeeded = Boolean(registryEntry && registryEntry.toolDisclosure === undefined);
  return {
    toolDisclosureMigrationNeeded: migrationNeeded,
    toolDisclosureChanged: Boolean(
      registryEntry &&
        !migrationNeeded &&
        recorded !== toolDisclosureOrDefault(session?.toolDisclosure),
    ),
  };
}

export type SandboxResumeDecision =
  | { readonly kind: "create" }
  | { readonly kind: "reuse" }
  | {
      readonly kind: "recreate";
      readonly note: string;
      readonly removeRegistryEntry: boolean;
    }
  | { readonly kind: "repair-and-recreate" };

export interface SandboxResumeDeps {
  note(message: string): void;
  removeSandboxFromRegistry(sandboxName: string): void;
  repairRecordedSandbox(sandboxName: string | null): void;
  recordRepairEvent(
    type: "state.repair.started" | "state.repair.completed" | "state.repair.failed",
    options?: {
      state?: "sandbox";
      error?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<unknown>;
}

function canReuseSandbox(signals: SandboxResumeSignals): boolean {
  return (
    !signals.resumeAgentChanged &&
    !signals.inferenceRouteConfigChanged &&
    !signals.webSearchConfigChanged &&
    !signals.sandboxGpuConfigChanged &&
    !signals.messagingChannelConfigChanged &&
    !signals.hermesToolGatewayConfigChanged &&
    !signals.toolDisclosureMigrationNeeded &&
    !signals.toolDisclosureChanged &&
    signals.sandboxReuseState === "ready"
  );
}

function toolDisclosureResumeDecision(signals: SandboxResumeSignals): SandboxResumeDecision | null {
  if (signals.toolDisclosureMigrationNeeded) {
    return {
      kind: "recreate",
      note: "  [resume] Tool disclosure metadata is missing; recreating sandbox for one-time migration.",
      // Preserve registry-only fidelity until createSandbox captures it.
      removeRegistryEntry: false,
    };
  }
  if (signals.toolDisclosureChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Tool disclosure configuration changed; recreating sandbox.",
      // Keep the row until createSandbox captures registry-only fidelity such
      // as managed MCP bridge state and can route it through transactional rebuild.
      removeRegistryEntry: false,
    };
  }
  return null;
}

function compatibilityResumeDecision(signals: SandboxResumeSignals): SandboxResumeDecision | null {
  if (signals.resumeAgentChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Agent selection changed; revalidating sandbox compatibility.",
      removeRegistryEntry: false,
    };
  }
  if (signals.inferenceRouteConfigChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Hermes inference route configuration changed; recreating sandbox.",
      // Preserve registry-only fidelity until createSandbox captures it for
      // the guarded recreate path.
      removeRegistryEntry: false,
    };
  }
  return null;
}

export function decideSandboxResume(signals: SandboxResumeSignals): SandboxResumeDecision {
  if (!signals.resume || !signals.sandboxStepComplete) return { kind: "create" };
  if (canReuseSandbox(signals)) return { kind: "reuse" };
  const compatibilityDecision = compatibilityResumeDecision(signals);
  if (compatibilityDecision) return compatibilityDecision;
  if (signals.webSearchConfigChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Web Search configuration changed; recreating sandbox.",
      removeRegistryEntry: true,
    };
  }
  if (signals.sandboxGpuConfigChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Sandbox GPU settings changed; recreating sandbox.",
      removeRegistryEntry: true,
    };
  }
  if (signals.messagingChannelConfigChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Messaging channel configuration changed; recreating sandbox.",
      removeRegistryEntry: true,
    };
  }
  if (signals.hermesToolGatewayConfigChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Hermes managed tool gateway selection changed; recreating sandbox.",
      removeRegistryEntry: true,
    };
  }
  const toolDisclosureDecision = toolDisclosureResumeDecision(signals);
  if (toolDisclosureDecision) return toolDisclosureDecision;
  if (signals.sandboxReuseState === "not_ready") return { kind: "repair-and-recreate" };
  return {
    kind: "recreate",
    note: "  [resume] Recorded sandbox state is unavailable; recreating it.",
    removeRegistryEntry: true,
  };
}

async function repairRecordedSandbox(
  sandboxName: string | null,
  deps: SandboxResumeDeps,
): Promise<void> {
  deps.note(`  [resume] Recorded sandbox '${sandboxName}' exists but is not ready; recreating it.`);
  const metadata = { repair: "recorded-sandbox-cleanup", sandboxName };
  await deps.recordRepairEvent("state.repair.started", { state: "sandbox", metadata });
  try {
    deps.repairRecordedSandbox(sandboxName);
  } catch (error) {
    await deps.recordRepairEvent("state.repair.failed", {
      state: "sandbox",
      error: error instanceof Error ? error.message : String(error),
      metadata,
    });
    throw error;
  }
  await deps.recordRepairEvent("state.repair.completed", { state: "sandbox", metadata });
}

export async function applySandboxResumeDecision(
  decision: SandboxResumeDecision,
  sandboxName: string | null,
  deps: SandboxResumeDeps,
): Promise<void> {
  if (decision.kind === "repair-and-recreate") {
    await repairRecordedSandbox(sandboxName, deps);
    return;
  }
  if (decision.kind !== "recreate") return;
  deps.note(decision.note);
  if (decision.removeRegistryEntry && sandboxName) deps.removeSandboxFromRegistry(sandboxName);
}
