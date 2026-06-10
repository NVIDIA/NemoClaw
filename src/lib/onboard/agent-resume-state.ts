// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";

export function normalizeAgentNameForResumeState(agentName: string | null | undefined): string {
  const trimmed = typeof agentName === "string" ? agentName.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

export function resetStepForAgentChange(session: Session, stepName: string): void {
  const stepState = session.steps[stepName];
  if (!stepState) return;
  stepState.status = "pending";
  stepState.startedAt = null;
  stepState.completedAt = null;
  stepState.error = null;
}

export function clearAgentScopedResumeState(session: Session, selectedAgentName: string): Session {
  const normalizedAgentName = normalizeAgentNameForResumeState(selectedAgentName);
  session.agent = normalizedAgentName === "openclaw" ? null : normalizedAgentName;
  session.provider = null;
  session.model = null;
  session.endpointUrl = null;
  session.credentialEnv = null;
  session.hermesAuthMethod = null;
  session.hermesToolGateways = null;
  session.preferredInferenceApi = null;
  session.nimContainer = null;
  session.routerPid = null;
  session.routerCredentialHash = null;
  session.policyPresets = null;

  const resetSteps = [
    "provider_selection",
    "inference",
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
  ];
  for (const stepName of resetSteps) resetStepForAgentChange(session, stepName);
  if (session.lastCompletedStep && resetSteps.includes(session.lastCompletedStep)) {
    session.lastCompletedStep =
      session.steps.gateway?.status === "complete"
        ? "gateway"
        : session.steps.preflight?.status === "complete"
          ? "preflight"
          : null;
  }
  if (session.lastStepStarted && resetSteps.includes(session.lastStepStarted)) {
    session.lastStepStarted = null;
  }
  return session;
}
