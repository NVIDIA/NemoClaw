// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";

export interface AgentSetupStateOptions<Agent> {
  agent: Agent | null;
  sandboxName: string;
  model: string;
  provider: string;
  resume: boolean;
  session: Session | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  deps: {
    handleAgentSetup(
      sandboxName: string,
      model: string,
      provider: string,
      agent: Agent,
      resume: boolean,
      session: Session | null,
      context: unknown,
    ): Promise<void>;
    agentSetupContext(): unknown;
    ensureAgentDashboardForward(sandboxName: string, agent: Agent): number;
    recordStepSkipped(stepName: string): Promise<Session>;
    isOpenclawReady(sandboxName: string): boolean;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName: string; provider: string; model: string },
    ): Promise<void>;
    setupOpenclaw(sandboxName: string, model: string, provider: string): Promise<void>;
    syncNemoClawConfigInSandbox(sandboxName: string, provider: string, model: string): void;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  };
}

export interface AgentSetupStateResult {
  session: Session | null;
}

export async function handleAgentSetupState<Agent>({
  agent,
  sandboxName,
  model,
  provider,
  resume,
  session,
  hermesAuthMethod,
  hermesToolGateways,
  deps,
}: AgentSetupStateOptions<Agent>): Promise<AgentSetupStateResult> {
  if (agent) {
    await deps.handleAgentSetup(
      sandboxName,
      model,
      provider,
      agent,
      resume,
      session,
      deps.agentSetupContext(),
    );
    deps.ensureAgentDashboardForward(sandboxName, agent);
    session = await deps.recordStepSkipped("openclaw");
    return { session };
  }

  const resumeOpenclaw = resume && sandboxName && deps.isOpenclawReady(sandboxName);
  if (resumeOpenclaw) {
    deps.skippedStepMessage("openclaw", sandboxName);
    deps.syncNemoClawConfigInSandbox(sandboxName, provider, model);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  } else {
    await deps.startRecordedStep("openclaw", { sandboxName, provider, model });
    await deps.setupOpenclaw(sandboxName, model, provider);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  }
  session = await deps.recordStepSkipped("agent_setup");
  return { session };
}
