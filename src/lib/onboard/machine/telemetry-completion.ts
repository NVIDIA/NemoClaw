// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { projectCommittedTelemetryConfiguration } from "../../actions/telemetry/configuration";
import {
  sendConfigurationSnapshotTelemetry,
  sendConfigurationTelemetry,
} from "../../actions/telemetry/send";
import { projectPublishedTelemetrySnapshot } from "../../actions/telemetry/snapshot";
import type { TelemetryEvent } from "../../domain/telemetry/event";
import type { TelemetryConfiguration } from "../../domain/telemetry/dimensions";
import type { AppliedPolicySelection } from "../../domain/telemetry/provenance";
import type { SandboxEntry } from "../../state/registry/types";
import { loadCompleteRegistrySnapshot } from "../../state/registry/persistence";
import { hasParentConfigurationCompletion } from "../../actions/telemetry/completion";

export interface CompletedOnboardTelemetry {
  completed: boolean;
  sandboxName: string | null | undefined;
  finalizedAgent: string | null | undefined;
  sessionAgent?: string | null;
  contextSandboxName?: string | null;
  appliedPolicySelection?: AppliedPolicySelection | null;
  expectedSelection: {
    model: string | null | undefined;
    provider: string | null | undefined;
    preferredInferenceApi: string | null | undefined;
  };
  assertRegistration: ((operation: string, sandboxName: string) => void) | undefined;
  getSandbox: (name: string) => SandboxEntry | null;
  loadRegistrySnapshot?: () => unknown;
  withSnapshotLock?: (
    name: string,
    collect: () => readonly TelemetryEvent[] | null,
    options: { timeoutMs: number; pollIntervalMs: number },
  ) => readonly TelemetryEvent[] | null;
  withTargetLock: (
    name: string,
    collect: () => TelemetryConfiguration | null,
    options: { timeoutMs: number; pollIntervalMs: number },
  ) => TelemetryConfiguration | null;
}

/** Collect only after supersession, under a bounded lock and the operation's identity proof. */
export async function sendCompletedOnboardConfigurationTelemetry(
  completion: CompletedOnboardTelemetry,
  send: typeof sendConfigurationTelemetry = sendConfigurationTelemetry,
  sendSnapshot: typeof sendConfigurationSnapshotTelemetry = sendConfigurationSnapshotTelemetry,
): Promise<void> {
  const { completed, sandboxName, finalizedAgent, sessionAgent, contextSandboxName, getSandbox } =
    completion;
  if (!completed || !sandboxName || hasParentConfigurationCompletion()) return;
  if (contextSandboxName != null && contextSandboxName !== sandboxName) return;
  if (finalizedAgent != null && sessionAgent != null && finalizedAgent !== sessionAgent) return;
  try {
    const loadRegistrySnapshot =
      completion.loadRegistrySnapshot ??
      (completion.withSnapshotLock ? loadCompleteRegistrySnapshot : undefined);
    if (loadRegistrySnapshot) {
      await sendSnapshot("onboard", () => {
        const assertRegistration = completion.assertRegistration;
        const lock = completion.withSnapshotLock;
        if (!assertRegistration || !lock) return null;
        return lock(
          sandboxName,
          () => {
            assertRegistration("collect completed onboarding configuration", sandboxName);
            const registry = loadRegistrySnapshot();
            if (typeof registry !== "object" || registry === null || !("sandboxes" in registry))
              return null;
            const entry = (registry as { sandboxes: Record<string, SandboxEntry> }).sandboxes[
              sandboxName
            ];
            const selection = completion.expectedSelection;
            if (
              !entry ||
              (entry.model ?? "") !== (selection.model ?? "") ||
              (entry.provider ?? "") !== (selection.provider ?? "") ||
              (entry.preferredInferenceApi ?? "") !== (selection.preferredInferenceApi ?? "")
            )
              return null;
            return projectPublishedTelemetrySnapshot("onboard", registry, {
              name: sandboxName,
              agent: finalizedAgent,
              appliedPolicySelection: completion.appliedPolicySelection,
            });
          },
          { timeoutMs: 100, pollIntervalMs: 20 },
        );
      });
      return;
    }
    await send("onboard", () => {
      // Both identity and lock reads stay behind sender opt-out and activation gates.
      const assertRegistration = completion.assertRegistration;
      if (!assertRegistration) return null;
      return completion.withTargetLock(
        sandboxName,
        () => {
          assertRegistration("collect completed onboarding configuration", sandboxName);
          const entry = getSandbox(sandboxName);
          const selection = completion.expectedSelection;
          if (
            !entry ||
            (entry.model ?? "") !== (selection.model ?? "") ||
            (entry.provider ?? "") !== (selection.provider ?? "") ||
            (entry.preferredInferenceApi ?? "") !== (selection.preferredInferenceApi ?? "")
          ) {
            return null;
          }
          const snapshot = projectCommittedTelemetryConfiguration(
            sandboxName,
            entry,
            finalizedAgent,
            completion.appliedPolicySelection,
          );
          if (!snapshot) return null;
          Object.freeze(snapshot.configuredMessagingChannels);
          return Object.freeze(snapshot);
        },
        { timeoutMs: 100, pollIntervalMs: 20 },
      );
    });
  } catch {
    // Telemetry must not turn a completed onboarding operation into a failure.
  }
}
