// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { decisionSelected } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import type { CheckpointProviderBinding } from "../../../state/onboard-checkpoint-types";
import type { CheckpointSandboxRecreateTransaction } from "../../../state/onboard-checkpoint-types";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import type { SandboxRemovalReceipt } from "../../../state/registry";
import {
  advanceSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  recordSandboxRecreateTargetCreated,
  type SandboxRecreateObservation,
} from "../../sandbox-recreate-transaction";
import type { SandboxStateOptions } from "./sandbox";

export function makeMinimalPlan(
  sandboxName: string,
  agent = "openclaw",
  channelIds: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
  disabledChannels: readonly SandboxMessagingPlan["channels"][number]["channelId"][] = [],
): SandboxMessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: agent as SandboxMessagingPlan["agent"],
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...disabled],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function withTelegramCredentialHash(
  plan: SandboxMessagingPlan,
  credentialHash: string | null,
): SandboxMessagingPlan {
  return {
    ...plan,
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "bot-token",
        sourceInput: "botToken",
        providerName: `${plan.sandboxName}-telegram-bridge`,
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        ...(credentialHash ? { credentialHash } : {}),
      },
    ],
  };
}

export async function withEnv<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

type UpdateSession = (mutator: (value: Session) => Session | void) => Session;

export function bindJournaledRecreate(
  session: Session,
  sandboxName = "saved",
  agent = "openclaw",
  updateSession: UpdateSession = (mutator) => mutator(session) ?? session,
) {
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: sandboxName, agent }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  let observation: SandboxRecreateObservation = {
    state: "ready",
    liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
  };
  return {
    observe: () => observation,
    completeCreate: vi.fn(async (...args: unknown[]) => {
      const transaction = updateSession((current) => current).checkpoint?.sandboxRecreate;
      expect(transaction).toBeDefined();
      const ownedTransaction = transaction as CheckpointSandboxRecreateTransaction;
      const createIntent = args.at(-1) as
        | { recreate?: boolean; recreateTransaction?: { id?: string } }
        | undefined;
      expect(createIntent?.recreate).toBe(true);
      expect(createIntent?.recreateTransaction?.id).toBe(ownedTransaction.id);
      for (const phase of ["deleting", "deleted", "creating"] as const) {
        updateSession((current) => {
          advanceSandboxRecreateTransaction(current, ownedTransaction.id, phase);
          return current;
        });
      }
      observation = {
        state: "ready",
        liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-target-id"),
      };
      updateSession((current) => {
        recordSandboxRecreateTargetCreated(current, ownedTransaction.id, observation);
        return current;
      });
      return sandboxName;
    }),
  };
}

type Gpu = { type: string } | null;
type Agent = { displayName?: string; name?: string } | null;
type WebSearchConfig = { fetchEnabled: true; provider?: "brave" | "tavily" };
type MessagingChannelConfig = Record<string, string>;
type SandboxGpuConfig = { sandboxGpuEnabled: boolean; mode: string };
type ResourceProfile = { cpu: string; memory: string };

export function createDeps(
  overrides: Partial<
    SandboxStateOptions<
      Gpu,
      Agent,
      WebSearchConfig,
      MessagingChannelConfig,
      SandboxGpuConfig,
      ResourceProfile
    >["deps"]
  > = {},
  initialSession: Session = createSession(),
) {
  let session = initialSession;
  const calls = {
    checkGatewayRouteCompatibility: vi.fn(() => ({ ok: true as const })),
    note: vi.fn(),
    loadSession: vi.fn(() => session),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    compareAndSwapSession: vi.fn(
      (matches: (value: Session) => boolean, mutator: (value: Session) => Session | void) =>
        matches(session)
          ? ((session = mutator(session) ?? session), "updated" as const)
          : ("mismatch" as const),
    ),
    persistMessaging: vi.fn(),
    clearPlanEnv: vi.fn(),
    removeSandbox: vi.fn((): SandboxRemovalReceipt | null => null),
    restoreSandboxRegistryEntryIfMissing: vi.fn(() => false),
    validateBrave: vi.fn(async () => "brave-key"),
    isBackToSelection: vi.fn(() => false),
    configureWebSearch: vi.fn(async () => null as WebSearchConfig | null),
    startStep: vi.fn(async () => undefined),
    getRecordedChannels: vi.fn(() => null),
    showMessagingStage: vi.fn(),
    setupMessaging: vi.fn(async () => [] as string[]),
    stageCredentialProviders: vi.fn(async () => [] as CheckpointProviderBinding[]),
    promptName: vi.fn(async () => "my-assistant"),
    selectResourceProfile: vi.fn(async () => null as ResourceProfile | null),
    stopStale: vi.fn(),
    planRegisteredExtraProviders: vi.fn(() => ({
      extraProviders: [] as string[],
      staleExtraProviders: [] as string[],
    })),
    resolveCreateIntent: vi.fn(
      async (input: {
        sandboxName: string;
        inferenceProvider?: string | null;
        extraProviders: readonly string[];
        staleExtraProviders: readonly string[];
      }) => ({
        sandboxName: input.sandboxName,
        inferenceProvider: input.inferenceProvider ?? null,
        activeMessagingChannels: [],
        messagingProviderRequests: [],
        reusableMessagingProviders: [],
        extraProviders: [...input.extraProviders],
        staleExtraProviders: [...input.staleExtraProviders],
        hermesToolGateways: [],
        policy: {
          basePolicyPath: "/repo/policy.yaml",
          activeMessagingChannels: [],
          options: {
            directGpu: false,
            additionalPresets: [],
            policyTier: null,
          },
        },
        gpuCreateArgs: [],
        resourceCreateArgs: [],
        gpuRoutePlan: "none" as const,
        sandboxGpuLogMessage: null,
        disabledChannelNames: [],
        extraPlaceholderKeys: [],
      }),
    ),
    createSandbox: vi.fn(async () => "my-assistant"),
    finalizeRouteReservation: vi.fn(() => true),
    retireReplacedSandboxWorkload: vi.fn(() => ({
      status: "skipped" as const,
      reason: "replacement-unproven" as const,
    })),
    updateSandbox: vi.fn(),
    complete: vi.fn(async (_stepName: string, updates: SessionUpdates) => {
      Object.assign(session, updates);
      return session;
    }),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => session),
    repairEvent: vi.fn(async () => createSession()),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    withGatewayRouteMutationLock: vi.fn(),
    withDashboardPortReservationLock: vi.fn(),
  };
  const runWithDashboardPortReservationLock =
    overrides.withDashboardPortReservationLock ??
    (async <T>(operation: () => Promise<T> | T): Promise<T> => {
      calls.withDashboardPortReservationLock(operation);
      return await operation();
    });
  const runWithGatewayRouteMutationLock = async <T>(
    gatewayName: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    if (overrides.withGatewayRouteMutationLock) {
      return await overrides.withGatewayRouteMutationLock(gatewayName, operation);
    }
    calls.withGatewayRouteMutationLock(gatewayName, operation);
    return await operation();
  };
  return {
    calls,
    deps: {
      resolvePath: (value: string) => `/abs/${value}`,
      agentSupportsWebSearch: () => true,
      note: calls.note,
      cliName: () => "nemoclaw",
      loadSession: calls.loadSession,
      updateSession: calls.updateSession,
      compareAndSwapSession: calls.compareAndSwapSession,
      getStoredMessagingChannelConfig: () => null,
      hydrateMessagingChannelConfig: (config: MessagingChannelConfig | null) => config,
      messagingChannelConfigsEqual: () => true,
      getSandboxReuseState: () => "missing",
      getSandboxRecreateObservation: () =>
        ({ state: "missing", liveIdentityFingerprint: null }) as const,
      getDcodeSelectionDrift: () => ({ changed: false, unknown: false }),
      hasSandboxGpuDrift: () => false,
      getSandboxHermesToolGateways: () => [],
      getSandboxRegistryEntry: (name: string) => ({
        name,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        webSearchEnabled: false,
        toolDisclosure: "progressive" as const,
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
      normalizeHermesToolGatewaySelections: (value: unknown) =>
        Array.isArray(value) ? (value as string[]) : [],
      stringSetsEqual: (left: string[], right: string[]) =>
        left.length === right.length && left.every((value) => right.includes(value)),
      removeSandboxFromRegistry: calls.removeSandbox,
      restoreSandboxRegistryEntryIfMissing: calls.restoreSandboxRegistryEntryIfMissing,
      ensureValidatedWebSearchCredential: calls.validateBrave,
      isBackToSelection: calls.isBackToSelection,
      configureWebSearch: calls.configureWebSearch,
      startRecordedStep: calls.startStep,
      getRecordedMessagingChannelsForResume: calls.getRecordedChannels,
      showMessagingStage: calls.showMessagingStage,
      setupMessagingChannels: calls.setupMessaging,
      readMessagingPlanFromEnv: () => null,
      writePlanToEnv: () => undefined,
      clearPlanEnv: calls.clearPlanEnv,
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: false, plan: null }),
      providerMatchesGatewayCredential: () => true,
      stageSandboxCredentialProviders: calls.stageCredentialProviders,
      promptValidatedSandboxName: calls.promptName,
      selectResourceProfileForSandbox: calls.selectResourceProfile,
      stopStaleDashboardListenersForSandbox: calls.stopStale,
      listRegistrySandboxes: () => ({ sandboxes: [{ name: "old" }] }),
      planRegisteredExtraProviders: calls.planRegisteredExtraProviders,
      resolveSandboxCreateIntent: calls.resolveCreateIntent,
      createSandbox: calls.createSandbox,
      retireReplacedSandboxWorkload: calls.retireReplacedSandboxWorkload,
      finalizeSandboxRouteReservation: calls.finalizeRouteReservation,
      updateSandboxRegistry: calls.updateSandbox,
      getSandboxAgentRegistryFields: () => ({ agent: null }),
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      error: calls.error,
      exitProcess: calls.exit,
      ...overrides,
      inspectGatewayCredential:
        overrides.inspectGatewayCredential ?? (() => ({ kind: "exact" as const })),
      checkGatewayRouteCompatibility:
        overrides.checkGatewayRouteCompatibility ?? calls.checkGatewayRouteCompatibility,
      withDashboardPortReservationLock: runWithDashboardPortReservationLock,
      withGatewayRouteMutationLock: runWithGatewayRouteMutationLock,
    },
    getSession: () => session,
  };
}

export function baseOptions(
  deps: SandboxStateOptions<
    Gpu,
    Agent,
    WebSearchConfig,
    MessagingChannelConfig,
    SandboxGpuConfig,
    ResourceProfile
  >["deps"],
  session: Session | null = createSession(),
): SandboxStateOptions<
  Gpu,
  Agent,
  WebSearchConfig,
  MessagingChannelConfig,
  SandboxGpuConfig,
  ResourceProfile
> {
  return {
    resume: false,
    fresh: false,
    resumeAgentChanged: false,
    recreateSandbox: () => false,
    gatewayName: "nemoclaw",
    session,
    sandboxName: null,
    model: "model",
    provider: "provider",
    endpointUrl: null,
    compatibleEndpointReasoning: null,
    credentialEnv: null,
    nimContainer: null,
    webSearchConfig: null,
    selectedMessagingChannels: [],
    fromDockerfile: null,
    agent: null,
    gpu: { type: "nvidia" },
    preferredInferenceApi: "openai-completions",
    sandboxGpuConfig: { sandboxGpuEnabled: false, mode: "0" },
    hermesToolGateways: [],
    hermesAuthMethod: null,
    controlUiPort: null,
    rootDir: "/repo",
    env: {},
    deps,
  };
}
