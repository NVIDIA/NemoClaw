// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";
import { initializeOpenclawInferenceRoute as initializeDefaultOpenclawInferenceRoute } from "../../openclaw/initial-inference-route";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

export interface AgentSetupStateOptions<Agent> {
  agent: Agent | null;
  sandboxName: string;
  model: string;
  provider: string;
  preferredInferenceApi: string | null;
  resume: boolean;
  session: Session | null;
  hermesAuthMethod: string | null;
  hermesToolGateways: string[];
  managedOpenclawStartup?: boolean;
  initializeNativeInferenceRoute?: boolean;
  settleOpenclawStartupBeforeConfiguration?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
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
    agentSetupContext(): { gatewayName: string };
    ensureAgentDashboardForward(sandboxName: string, agent: Agent | null): Promise<number> | number;
    persistDashboardPort(sandboxName: string, dashboardPort: number): void;
    recordStepSkipped(stepName: string): Promise<Session>;
    isOpenclawReady(sandboxName: string): Promise<boolean>;
    waitForSandboxControlPlaneReady(sandboxName: string): Promise<boolean>;
    waitForStartedOpenclawGatewayProcess(
      sandboxName: string,
      gatewayName: string,
    ): Promise<boolean | null>;
    settleStartedOpenclawGatewayForConfiguration(sandboxName: string): Promise<boolean>;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(
      state: "openclaw",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName: string; provider: string; model: string },
    ): Promise<void>;
    announceOpenclawSetup?(): void;
    setupOpenclaw(
      sandboxName: string,
      model: string,
      provider: string,
      revalidateSandboxIdentity?: (operation: string) => void,
      preferredInferenceApi?: string | null,
      initializeNativeInferenceRoute?: boolean,
      gatewayName?: string,
      settleOpenclawPairingBeforeRestart?: () => Promise<boolean>,
    ): Promise<void>;
    configureOpenclawSandbox(
      sandboxName: string,
      model: string,
      provider: string,
      revalidateSandboxIdentity?: (operation: string) => void,
      managedProfileApplied?: boolean,
    ): Promise<void>;
    initializeOpenclawInferenceRoute?(
      sandboxName: string,
      model: string,
      provider: string,
      preferredInferenceApi: string | null,
      gatewayName: string,
      revalidateSandboxIdentity?: (operation: string) => void,
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
  preferredInferenceApi,
  resume,
  session,
  hermesAuthMethod,
  hermesToolGateways,
  managedOpenclawStartup = false,
  initializeNativeInferenceRoute = false,
  settleOpenclawStartupBeforeConfiguration = false,
  revalidateSandboxIdentity,
  deps,
}: AgentSetupStateOptions<Agent>): Promise<AgentSetupStateResult> {
  const agentSetupContext = deps.agentSetupContext();
  const initializeOpenclawInferenceRoute = async (): Promise<void> => {
    if (!initializeNativeInferenceRoute) return;
    if (
      settleOpenclawStartupBeforeConfiguration &&
      !(await deps.settleStartedOpenclawGatewayForConfiguration(sandboxName))
    ) {
      throw new Error(
        `External-image OpenClaw pairing did not settle after configuration for sandbox '${sandboxName}'.`,
      );
    }
    await (deps.initializeOpenclawInferenceRoute ?? initializeDefaultOpenclawInferenceRoute)(
      sandboxName,
      model,
      provider,
      preferredInferenceApi,
      agentSetupContext.gatewayName,
      revalidateSandboxIdentity,
    );
  };

  if (agent) {
    await deps.handleAgentSetup(
      sandboxName,
      model,
      provider,
      agent,
      resume,
      session,
      agentSetupContext,
    );
    // ensureAgentDashboardForward returns the port the dashboard forward was
    // actually established on, which may be bumped when the default is already
    // taken by another sandbox. Persist it to the registry so `dashboard-url`
    // reports the live port instead of the default. Discarding the return here
    // regressed multi-sandbox onboarding in the machine handler path (#8214).
    const dashboardPort = await deps.ensureAgentDashboardForward(sandboxName, agent);
    if (dashboardPort > 0) {
      deps.persistDashboardPort(sandboxName, dashboardPort);
    }
    session = await deps.recordStepSkipped("openclaw");
    return { session, stateResult: advanceTo("policies", { metadata: { state: "agent_setup" } }) };
  }

  const resumeOpenclaw = resume && sandboxName && (await deps.isOpenclawReady(sandboxName));
  if (resumeOpenclaw) {
    if (!(await deps.waitForSandboxControlPlaneReady(sandboxName))) {
      throw new Error(
        `Sandbox '${sandboxName}' did not re-register with OpenShell before OpenClaw resume configuration.`,
      );
    }
    deps.skippedStepMessage("openclaw", sandboxName);
    revalidateSandboxIdentity?.(`synchronize OpenClaw in sandbox '${sandboxName}'`);
    await deps.configureOpenclawSandbox(
      sandboxName,
      model,
      provider,
      revalidateSandboxIdentity,
      managedOpenclawStartup === true,
    );
    await initializeOpenclawInferenceRoute();
    revalidateSandboxIdentity?.(`record resumed OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStateSkipped("openclaw", { reason: "resume", sandboxName });
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  } else if (managedOpenclawStartup) {
    deps.announceOpenclawSetup?.();
    await deps.startRecordedStep("openclaw", { sandboxName, provider, model });
    if (!(await deps.waitForSandboxControlPlaneReady(sandboxName))) {
      throw new Error(
        `Managed OpenClaw startup did not re-register with OpenShell for sandbox '${sandboxName}'.`,
      );
    }
    revalidateSandboxIdentity?.(`synchronize managed OpenClaw in sandbox '${sandboxName}'`);
    await deps.configureOpenclawSandbox(
      sandboxName,
      model,
      provider,
      revalidateSandboxIdentity,
      true,
    );
    await initializeOpenclawInferenceRoute();
    revalidateSandboxIdentity?.(`complete managed OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  } else {
    await deps.startRecordedStep("openclaw", { sandboxName, provider, model });
    if (
      settleOpenclawStartupBeforeConfiguration &&
      (await deps.waitForStartedOpenclawGatewayProcess(
        sandboxName,
        agentSetupContext.gatewayName,
      )) !== true
    ) {
      throw new Error(
        `External-image OpenClaw startup did not settle before configuration for sandbox '${sandboxName}'.`,
      );
    }
    revalidateSandboxIdentity?.(`configure OpenClaw in sandbox '${sandboxName}'`);
    await deps.setupOpenclaw(
      sandboxName,
      model,
      provider,
      revalidateSandboxIdentity,
      preferredInferenceApi,
      initializeNativeInferenceRoute,
      agentSetupContext.gatewayName,
      settleOpenclawStartupBeforeConfiguration
        ? () => deps.settleStartedOpenclawGatewayForConfiguration(sandboxName)
        : undefined,
    );
    revalidateSandboxIdentity?.(`complete OpenClaw setup for sandbox '${sandboxName}'`);
    await deps.recordStepComplete(
      "openclaw",
      deps.toSessionUpdates({ sandboxName, provider, model, hermesAuthMethod, hermesToolGateways }),
    );
  }
  const dashboardPort = await deps.ensureAgentDashboardForward(sandboxName, null);
  if (dashboardPort > 0) {
    deps.persistDashboardPort(sandboxName, dashboardPort);
  }
  session = await deps.recordStepSkipped("agent_setup");
  return { session, stateResult: advanceTo("policies", { metadata: { state: "openclaw" } }) };
}
