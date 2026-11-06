// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { initializeExternalHermesInferenceRoute } from "./initial-hermes-inference-route";
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
  initializeExternalHermesInference?: boolean;
  settleOpenclawStartupBeforeConfiguration?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
  deps: {
    initializeExternalHermesInferenceRoute?: typeof initializeExternalHermesInferenceRoute;
    handleAgentSetup(
      sandboxName: string,
      model: string,
      provider: string,
      agent: Agent,
      resume: boolean,
      session: Session | null,
      context: unknown,
    ): Promise<void>;
    agentSetupContext(): {
      gatewayName: string;
      getSandbox: Parameters<typeof initializeExternalHermesInferenceRoute>[0]["getSandbox"];
    };
    ensureAgentDashboardForward(
      sandboxName: string,
      agent: Agent | null,
      revalidateSandboxIdentity?: (operation: string) => void,
    ): Promise<number> | number;
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
  initializeExternalHermesInference = false,
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
    if (initializeExternalHermesInference && !revalidateSandboxIdentity) {
      throw new Error("Initial Hermes inference route requires verified sandbox identity.");
    }
    let forwardHandoff: Promise<number> | undefined;
    const ensureForward = (): Promise<number> =>
      (forwardHandoff ??= (async () => {
        revalidateSandboxIdentity?.(`establish agent forwards for sandbox '${sandboxName}'`);
        const dashboardPort = await deps.ensureAgentDashboardForward(
          sandboxName,
          agent,
          revalidateSandboxIdentity,
        );
        revalidateSandboxIdentity?.(`publish agent forward for sandbox '${sandboxName}'`);
        // Persist the returned primary port so guarded restart recovery and
        // dashboard-url select the actual forward, including a bumped UI port.
        if (dashboardPort > 0) deps.persistDashboardPort(sandboxName, dashboardPort);
        return dashboardPort;
      })());
    await deps.handleAgentSetup(sandboxName, model, provider, agent, resume, session, {
      ...agentSetupContext,
      ...(revalidateSandboxIdentity ? { revalidateSandboxIdentity } : {}),
      prepareHermesInferenceForward: async () => {
        if ((await ensureForward()) <= 0) {
          throw new Error("Hermes inference activation requires an owned API forward handoff.");
        }
      },
    });
    if (initializeExternalHermesInference) {
      await (deps.initializeExternalHermesInferenceRoute ?? initializeExternalHermesInferenceRoute)(
        {
          sandboxName,
          gatewayName: agentSetupContext.gatewayName,
          getSandbox: agentSetupContext.getSandbox,
          model,
          provider,
          preferredInferenceApi,
          revalidateSandboxIdentity: revalidateSandboxIdentity!,
        },
      );
    }
    await ensureForward();
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
        `OpenClaw startup did not settle before configuration for sandbox '${sandboxName}'.`,
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
