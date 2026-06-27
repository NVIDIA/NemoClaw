// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxResumeSignals {
  readonly resume: boolean;
  readonly resumeAgentChanged: boolean;
  readonly sandboxStepComplete: boolean;
  readonly sandboxReuseState: string;
  readonly webSearchConfigChanged: boolean;
  readonly sandboxGpuConfigChanged: boolean;
  readonly messagingChannelConfigChanged: boolean;
  readonly hermesToolGatewayConfigChanged: boolean;
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
    !signals.webSearchConfigChanged &&
    !signals.sandboxGpuConfigChanged &&
    !signals.messagingChannelConfigChanged &&
    !signals.hermesToolGatewayConfigChanged &&
    signals.sandboxReuseState === "ready"
  );
}

export function decideSandboxResume(signals: SandboxResumeSignals): SandboxResumeDecision {
  if (!signals.resume || !signals.sandboxStepComplete) return { kind: "create" };
  if (canReuseSandbox(signals)) return { kind: "reuse" };
  if (signals.resumeAgentChanged) {
    return {
      kind: "recreate",
      note: "  [resume] Agent selection changed; revalidating sandbox compatibility.",
      removeRegistryEntry: false,
    };
  }
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
