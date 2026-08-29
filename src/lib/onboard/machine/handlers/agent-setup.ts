// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

type WebSearchSelection = { fetchEnabled?: boolean } | null;

export interface AgentSetupStateOptions<Agent> {
  agent: Agent | null;
  sandboxName: string;
  model: string;
  provider: string;
  webSearchConfig: WebSearchSelection;
  resume: boolean;
  session: Session | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  revalidatePolicyRequirements?: (operation: string) => void;
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
    agentSetupContext(revalidatePolicyRequirements?: (operation: string) => void): unknown;
    ensureAgentDashboardForward(
      sandboxName: string,
      agent: Agent,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<number> | number;
    persistDashboardPort(sandboxName: string, dashboardPort: number): void;
    recordStepSkipped(stepName: string): Promise<Session>;
    isOpenclawReady(sandboxName: string): boolean;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(
      state: "openclaw",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName: string; provider: string; model: string },
    ): Promise<void>;
    setupOpenclaw(
      sandboxName: string,
      model: string,
      provider: string,
      webSearchConfig: WebSearchSelection,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<void>;
    configureOpenclawSandbox(
      sandboxName: string,
      model: string,
      provider: string,
      webSearchConfig: WebSearchSelection,
      revalidatePolicyRequirements?: (operation: string) => void,
    ): Promise<void>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  };
}

export interface AgentSetupStateResult {
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
}

export async function handleAgentSetupState<Agent>({
  agent,
  sandboxName,
  model,
  provider,
  webSearchConfig,
  resume,
  session,
  hermesAuthMethod,
  hermesToolGateways,
  revalidatePolicyRequirements,
  deps,
}: AgentSetupStateOptions<Agent>): Promise<AgentSetupStateResult> {
  if (agent) {
    revalidatePolicyRequirements?.(`configure the selected agent in sandbox '${sandboxName}'`);
    await deps.handleAgentSetup(
      sandboxName,
      model,
      provider,
      agent,
      resume,
      session,
      deps.agentSetupContext(revalidatePolicyRequirements),
    );
    // ensureAgentDashboardForward returns the port the dashboard forward was
    // actually established on, which may be bumped when the default is already
    // taken by another sandbox. Persist it to the registry so `dashboard-url`
    // reports the live port instead of the default. Discarding the return here
    // regressed multi-sandbox onboarding in the machine handler path (#8214).
    revalidatePolicyRequirements?.(`configure the agent dashboard for sandbox '${sandboxName}'`);
    const dashboardPort = await deps.ensureAgentDashboardForward(
      sandboxName,
      agent,
      revalidatePolicyRequirements,
    );
    if (dashboardPort > 0) {
      revalidatePolicyRequirements?.(
        `record the agent dashboard port for sandbox '${sandboxName}'`,
      );
      deps.persistDashboardPort(sandboxName, dashboardPort);
    }
    revalidatePolicyRequirements?.(`record agent setup for sandbox '${sandboxName}'`);
    session = await deps.recordStepSkipped("openclaw");
    return { session, stateResult: advanceTo("policies", { metadata: { state: "agent_setup" } }) };
  }

  const resumeOpenclaw = resume && sandboxName && deps.isOpenclawReady(sandboxName);
  if (resumeOpenclaw) {
    deps.skippedStepMessage("openclaw", sandboxName);
    revalidatePolicyRequirements?.(`synchronize OpenClaw in sandbox '${sandboxName}'`);
    await deps.configureOpenclawSandbox(
      sandboxName,
      model,
      provider,
      webSearchConfig,
      revalidatePolicyRequirements,
    );
    revalidatePolicyRequirements?.(`record resumed OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStateSkipped("openclaw", { reason: "resume", sandboxName });
    revalidatePolicyRequirements?.(`complete resumed OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  } else {
    revalidatePolicyRequirements?.(`start OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.startRecordedStep("openclaw", { sandboxName, provider, model });
    revalidatePolicyRequirements?.(`configure OpenClaw in sandbox '${sandboxName}'`);
    await deps.setupOpenclaw(
      sandboxName,
      model,
      provider,
      webSearchConfig,
      revalidatePolicyRequirements,
    );
    revalidatePolicyRequirements?.(`complete OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  }
  revalidatePolicyRequirements?.(`record agent setup for sandbox '${sandboxName}'`);
  session = await deps.recordStepSkipped("agent_setup");
  return { session, stateResult: advanceTo("policies", { metadata: { state: "openclaw" } }) };
}
