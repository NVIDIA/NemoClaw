// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging";
import { MACHINE_SNAPSHOT_VERSION, type Session } from "../../state/onboard-session";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

export interface RebuildResumeSessionOptions {
  sandboxName: string;
  rebuildAgent: string | null;
  rebuildMessagingPlan: SandboxMessagingPlan | null;
  rebuildsHermesSandbox: boolean;
  rebuildHermesToolGateways: string[];
  resumeConfig: RebuildResumeConfig;
}

export function rewindSessionForRebuildResume(
  s: Session,
  options: RebuildResumeSessionOptions,
): Session {
  const {
    sandboxName,
    rebuildAgent,
    rebuildMessagingPlan,
    rebuildsHermesSandbox,
    rebuildHermesToolGateways,
    resumeConfig,
  } = options;
  const now = new Date().toISOString();
  const machine = s.machine;
  const rewindStepNames = [
    "provider_selection",
    "inference",
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
  ];

  // Invalid legacy shape: rebuild can inherit an onboard session whose durable
  // machine snapshot is still inside a recreate step such as `sandbox` or
  // `openclaw`, even though the registry is the only trustworthy target state.
  // Producer boundary: those stale snapshots were persisted by earlier
  // onboard-resume flows before rebuild owned this normalization point. Rebuild
  // cannot fix already-written sessions at the producer after it has decided to
  // delete and recreate the sandbox, so normalize the loaded session here.
  // Removal condition: drop this legacy repair once a session-version migration
  // or producer-level test proves recreate sessions are always persisted at a
  // resumable pre-sandbox boundary. Tracking: #4533 owns the broader onboard
  // FSM/resume compatibility boundary that should retire this shim.
  s.sandboxName = sandboxName;
  s.resumable = true;
  s.status = "in_progress";
  s.failure = null;
  s.lastCompletedStep = "gateway";
  s.lastStepStarted = "gateway";
  if (s.steps) {
    for (const stepName of rewindStepNames) {
      const step = s.steps[stepName];
      if (!step) continue;
      step.status = "pending";
      step.startedAt = null;
      step.completedAt = null;
      step.error = null;
    }
  }
  if (machine?.state !== "complete") {
    s.machine = {
      version: MACHINE_SNAPSHOT_VERSION,
      state: "complete",
      stateEnteredAt: now,
      revision: (machine?.revision ?? 0) + 1,
    };
  }
  s.agent = rebuildAgent;
  s.messagingPlan = rebuildMessagingPlan;
  s.hermesToolGateways = rebuildsHermesSandbox ? rebuildHermesToolGateways : [];
  s.provider = resumeConfig.provider;
  s.model = resumeConfig.model;
  s.nimContainer = resumeConfig.nimContainer;
  s.credentialEnv = resumeConfig.credentialEnv;
  s.preferredInferenceApi = resumeConfig.preferredInferenceApi;
  s.compatibleEndpointReasoning = resumeConfig.compatibleEndpointReasoning;
  // `onboard --resume` uses the session as the recreate contract. Always
  // overwrite the endpoint from the preflighted registry-derived config, even
  // when the previous session matched this sandbox name: a stale retry session
  // can otherwise leak an old provider URL into recreate. The resume config was
  // resolved and validated before destructive work (#4497/#5869).
  s.endpointUrl = resumeConfig.endpointUrl;
  return s;
}
