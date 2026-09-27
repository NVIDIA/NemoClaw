// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isCandidateAgent, readCandidateQualificationReceipt } from "../../agent/candidate";
import type { AgentDefinition } from "../../agent/defs";
import { getVersion } from "../../core/version";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type {
  CreateSandboxBuildContextResult,
  PreparedSandboxBuildContext,
} from "../build-context-stage";
import type { OpenShellComputePlan } from "../compute/plan";
import { resolveCorporateCa } from "../corporate-ca";
import { enforceDockerGpuPatchPreserveNetwork } from "../docker-gpu-local-inference";
import {
  isSandboxBridgeGatewayReachable,
  verifySandboxBridgeGatewayReachableOrExit,
} from "../gateway-sandbox-reachability";
import { initialDockerGpuRoute, type SelectedDockerGpuRoute } from "../docker-gpu-route";
import type { InitialSandboxPolicy } from "../initial-policy";
import { isShippedManagedImageAgent } from "../managed-image/contract";
import {
  type BuiltManagedStartupOnboardProfile,
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "../managed-startup/onboard-profile";
export {
  applyProviderManagedStartupRootRequest,
  finalizeProviderManagedStartupSharedState,
  releaseProviderManagedStartupHold,
  refreshManagedStartupCorporateCaTrust,
  type ProviderManagedStartupTransaction,
} from "../runtime-provider/access";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  managedStartupStateRoots,
  managedStartupWorkspaceRoot,
} from "../managed-startup/state-roots";
import { getChannelsFromPlan, getMessagingChannelConfigFromPlan } from "../messaging-plan-session";
import type { MessagingTokenDef } from "../messaging-prep";
import { resolveSandboxBuildContext, resolveSandboxBuildPatch } from "../prepared-dcode-rebuild";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  normalizeRuntimeProviderIdentity,
  type RuntimeProviderBundle,
  resolveRuntimeProviderBundle,
} from "../runtime-provider/access";
import type {
  MaterializeSandboxCreatePlanInput,
  SandboxCreateIntent,
} from "../sandbox-create-intent-types";
import {
  materializeHermesPortableCreatePlan,
  type PlannedOpenShellSandboxCreateRequest,
  type SandboxCreatePlan,
} from "../sandbox-create-plan-materialization";
import {
  prepareSandboxRuntimeLaunch,
  prebuildSandboxImageIfEligible,
  requiresLocalSandboxBuildKit,
  type SandboxCreateLaunchInput,
  type SandboxRuntimeLaunchWithPrebuild,
} from "../sandbox-create-launch";
import { getSandboxReadyTimeoutSecs } from "../sandbox-gpu-create";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import {
  installedManagedImageCatalogRevision,
  liveE2eManagedImageCatalog,
  liveE2eManagedImageRevision,
  type PreparedSandboxWorkloadSource,
  prepareSandboxWorkloadSource,
} from "../workload/preparation";
import {
  type ManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
} from "../workload/rebuild";
import { resolveSandboxWorkloadRuntimeCapabilities } from "../workload/runtime";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
  type ManagedStateVolumeDeps,
} from "./managed-state-volumes";

export {
  managedStartupStateRoots,
  managedStartupWorkspaceRoot,
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
};

type ManagedProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "corporateCa" | "inference"
>;
type ResolveBuildPatchInput = Parameters<typeof resolveSandboxBuildPatch>[0];
type SandboxInferenceConfig = import("../../inference/config").SandboxInferenceConfig;
export { normalizeRuntimeProviderIdentity };

export type ManagedStateVolumeOnboardLifecycle = {
  readonly roots: readonly import("../managed-startup/state-roots").ManagedStartupStateRoot[];
  materializeSandboxCreatePlan<T extends SandboxCreatePlan>(
    input: MaterializeSandboxCreatePlanInput,
    materialize: (input: MaterializeSandboxCreatePlanInput) => Promise<T>,
  ): Promise<T>;
  commit(): void;
};

export function createManagedStateVolumeOnboardLifecycle(
  input: {
    readonly roots: readonly import("../managed-startup/state-roots").ManagedStartupStateRoot[];
    readonly runtimeProvider: RuntimeProviderBundle | null;
  },
  deps: ManagedStateVolumeDeps = {},
): ManagedStateVolumeOnboardLifecycle {
  const scope = prepareManagedStateVolumes(
    { roots: input.roots },
    {
      ...deps,
      ...(input.runtimeProvider ? { runtimeProvider: input.runtimeProvider } : {}),
    },
  );
  const managedStateMountDriverId = scope
    ? input.runtimeProvider?.workload.managedStateMountDriverId
    : undefined;
  if (scope && !managedStateMountDriverId) {
    throw new Error("Managed state volumes require provider-owned mount projection.");
  }
  return {
    roots: input.roots,
    materializeSandboxCreatePlan(input, materialize) {
      return materialize({
        ...input,
        managedStateMounts: scope?.mounts,
        managedStateMountDriverId,
      });
    },
    commit() {
      scope?.commit();
    },
  };
}

export interface ManagedWorkloadOnboardDependencies {
  readonly resolveAgentInferenceApi: typeof import("../../inference/config").resolveAgentInferenceApi;
  readonly getSandboxInferenceConfig: typeof import("../../inference/config").getSandboxInferenceConfig;
}

export interface CreateManagedWorkloadOnboardRuntimeInput {
  readonly computePlan: OpenShellComputePlan;
  readonly managedWorkloadRebuild: ManagedWorkloadRebuildHandoff | null;
  readonly tempManagedRuntime: boolean;
  readonly stockManagedRuntime: boolean;
  readonly tempManagedRuntimeCatalog: string | null;
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath: string | null;
  readonly rootDir: string;
  readonly model: string | null;
  readonly provider: string | null;
  readonly preferredInferenceApi: string | null;
  readonly endpointUrl: string | null;
  readonly startupProfile: ManagedProfileInput;
  readonly note: (message: string) => void;
  readonly fallbackBuildEstimate: () => string | null;
}

export interface ManagedWorkloadOnboardRuntime {
  readonly runtimeProvider: RuntimeProviderBundle | null;
  ensurePreparedWorkload(): Promise<PreparedSandboxWorkloadSource>;
  ensurePreparedProfile(
    workload: PreparedSandboxWorkloadSource,
  ): BuiltManagedStartupOnboardProfile | null;
}

export function shouldActivateStockManagedRuntime(input: {
  readonly portableLifecycle: boolean;
  readonly hermesPortableLifecycle: boolean;
  readonly agentName: string;
}): boolean {
  return (
    !input.portableLifecycle &&
    !input.hermesPortableLifecycle &&
    isShippedManagedImageAgent(input.agentName)
  );
}

/** Keep published base images on their legacy OpenClaw finalization contract. */
export function shouldUseManagedOpenclawStartup(
  defaultOpenclawSelected: boolean,
  sandbox: Pick<SandboxEntry, "managedStartupProtocol" | "workload"> | null,
): boolean {
  return (
    defaultOpenclawSelected &&
    sandbox?.workload?.kind === "managed-image" &&
    sandbox.managedStartupProtocol !== "legacy-unbound"
  );
}

export function assertPortableManagedBootstrapNotSelected(
  portableLifecycle: boolean,
  managedBootstrapSelected: boolean,
): void {
  if (portableLifecycle && managedBootstrapSelected) {
    throw new Error(
      "Portable OpenClaw onboarding cannot use managed-image bootstrap because that path requires Docker lifecycle operations.",
    );
  }
}

export async function prepareSandboxWorkloadForPortableLifecycle(
  runtime: ManagedWorkloadOnboardRuntime,
  portableLifecycle: boolean,
): Promise<PreparedSandboxWorkloadSource> {
  const workload = await runtime.ensurePreparedWorkload();
  if (workload.source.kind === "portable-image") {
    throw new Error("Portable image workload activation is not enabled.");
  }
  assertPortableManagedBootstrapNotSelected(
    portableLifecycle,
    workload.source.kind === "managed-image",
  );
  runtime.ensurePreparedProfile(workload);
  return workload;
}

/** Select the existing legacy Hermes source without staging, profile, prebuild, or Docker work. */
export async function prepareHermesPortableSandboxWorkloadForLifecycle(
  runtime: ManagedWorkloadOnboardRuntime,
  expectedDockerfilePath: string,
): Promise<PreparedSandboxWorkloadSource> {
  const workload = await runtime.ensurePreparedWorkload();
  if (workload.source.kind === "managed-image") {
    throw new Error(
      "Hermes portable onboarding cannot use managed-image bootstrap because that path requires Docker lifecycle operations.",
    );
  }
  if (workload.source.kind === "portable-image") {
    throw new Error("Portable image workload activation is not enabled.");
  }
  if (
    workload.source.reason !== "runtime-unsupported" ||
    workload.source.dockerfilePath !== expectedDockerfilePath
  ) {
    throw new Error(
      "Hermes portable onboarding requires the shipped Hermes Dockerfile source selected for the current runtime.",
    );
  }
  return workload;
}

function requireManagedRuntimeProvider(
  provider: RuntimeProviderBundle | null,
): RuntimeProviderBundle {
  if (!provider) throw new Error("Managed-image onboarding requires a runtime provider.");
  return provider;
}

/** Memoize the exact workload and profile used before deletion, launch, and registration. */
export function createManagedWorkloadOnboardRuntime(
  input: CreateManagedWorkloadOnboardRuntimeInput,
  dependencies: ManagedWorkloadOnboardDependencies,
): ManagedWorkloadOnboardRuntime {
  const discoveredRuntimeCapabilities = resolveSandboxWorkloadRuntimeCapabilities(
    input.computePlan,
  );
  const strictManagedRuntime =
    input.tempManagedRuntime ||
    input.tempManagedRuntimeCatalog !== null ||
    input.managedWorkloadRebuild !== null;
  const runtimeCapabilities = strictManagedRuntime
    ? discoveredRuntimeCapabilities
    : {
        ...discoveredRuntimeCapabilities,
        managedImageSelectionPolicy: "prefer-managed" as const,
        managedImages: input.stockManagedRuntime
          ? discoveredRuntimeCapabilities.managedImages
          : null,
      };
  const runtimeProvider = resolveRuntimeProviderBundle(
    input.computePlan.driverName,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  let preparedWorkloadPromise: Promise<PreparedSandboxWorkloadSource> | null = null;
  let fallbackReported = false;
  let preparedProfile: BuiltManagedStartupOnboardProfile | null = null;

  const ensurePreparedWorkload = async (): Promise<PreparedSandboxWorkloadSource> => {
    const liveCatalogRevision = input.stockManagedRuntime
      ? liveE2eManagedImageRevision(input.startupProfile.environment)
      : null;
    const liveCatalog = liveE2eManagedImageCatalog(input.startupProfile.environment);
    if (liveCatalogRevision && liveCatalog) {
      throw new Error("live E2E managed-image revision and catalog authority conflict");
    }
    const catalogRevision =
      liveCatalogRevision ??
      (liveCatalog || input.tempManagedRuntimeCatalog || input.managedWorkloadRebuild
        ? null
        : installedManagedImageCatalogRevision(input.startupProfile.environment, input.rootDir));
    preparedWorkloadPromise ??= input.managedWorkloadRebuild
      ? Promise.resolve(
          prepareSandboxWorkloadSourceFromRebuildHandoff(
            input.managedWorkloadRebuild,
            runtimeCapabilities,
            requireManagedRuntimeProvider(runtimeProvider),
          ),
        )
      : prepareSandboxWorkloadSource({
          agentName: input.agentName,
          legacyDockerfilePath: input.legacyDockerfilePath,
          customDockerfilePath: input.customDockerfilePath,
          runtime: runtimeCapabilities,
          version: getVersion({ rootDir: input.rootDir }),
          // Same environment authority the catalog selection above reads, so
          // both onboarding decisions observe one set of values (#11138).
          environment: input.startupProfile.environment,
          ...(!input.tempManagedRuntimeCatalog && liveCatalog?.catalog
            ? { catalog: liveCatalog.catalog }
            : {}),
          catalogPath: input.tempManagedRuntimeCatalog ?? liveCatalog?.path ?? null,
          ...(liveCatalog ? { expectedCatalogRevision: liveCatalog.revision } : {}),
          ...(catalogRevision ? { catalogRevision } : {}),
          acceptedCandidateContract: isCandidateAgent(input.agentName)
            ? readCandidateQualificationReceipt(input.agentName)
            : null,
        });
    const prepared = await preparedWorkloadPromise;
    if (prepared.fallbackDiagnostic && !fallbackReported) {
      fallbackReported = true;
      input.note("  Managed image unavailable; using the trusted Dockerfile recipe.");
      input.note(`  ${prepared.fallbackDiagnostic}`);
      const estimate = input.fallbackBuildEstimate();
      if (estimate) input.note(`  ${estimate}`);
    }
    return prepared;
  };

  const ensurePreparedProfile = (
    workload: PreparedSandboxWorkloadSource,
  ): BuiltManagedStartupOnboardProfile | null => {
    if (workload.source.kind !== "managed-image") return null;
    requireManagedRuntimeProvider(runtimeProvider);
    if (input.managedWorkloadRebuild) {
      if (workload.source.reference !== input.managedWorkloadRebuild.replacement.source.reference) {
        throw new Error("Managed rebuild workload changed before startup profile preparation.");
      }
      return input.managedWorkloadRebuild.replacementProfile;
    }
    if (preparedProfile) return preparedProfile;
    const selectedModel = input.model?.trim() || "";
    const selectedProvider = input.provider?.trim() || null;
    const inferenceApi =
      input.agentName === "langchain-deepagents-code"
        ? "openai-completions"
        : dependencies.resolveAgentInferenceApi(
            input.agentName,
            selectedProvider,
            input.preferredInferenceApi,
          );
    const inference: SandboxInferenceConfig = dependencies.getSandboxInferenceConfig(
      selectedModel,
      selectedProvider,
      inferenceApi,
    );
    preparedProfile = buildManagedStartupOnboardProfile({
      agentName: input.agentName,
      inference:
        !selectedModel && !selectedProvider && !input.preferredInferenceApi && !input.endpointUrl
          ? null
          : {
              routeProvider: inference.providerKey,
              upstreamProvider: selectedProvider ?? inference.providerKey,
              model: selectedModel,
              routedBaseUrl: inference.inferenceBaseUrl,
              upstreamEndpointUrl:
                input.agentName === "langchain-deepagents-code" ? input.endpointUrl : null,
              api: inference.inferenceApi as
                | "openai-completions"
                | "openai-responses"
                | "anthropic-messages",
              primaryModelRef: input.agentName === "openclaw" ? inference.primaryModelRef : null,
              compatibility:
                input.agentName === "openclaw" ? (inference.inferenceCompat ?? {}) : null,
            },
      ...input.startupProfile,
      corporateCa: resolveCorporateCa(input.startupProfile.environment),
    });
    return preparedProfile;
  };

  return { runtimeProvider, ensurePreparedWorkload, ensurePreparedProfile };
}

export interface PrepareOnboardSandboxWorkloadLaunchInput {
  readonly runtime: ManagedWorkloadOnboardRuntime;
  readonly workload: PreparedSandboxWorkloadSource;
  readonly legacy: {
    readonly preparedBuildContext: PreparedSandboxBuildContext | null;
    readonly agent: AgentDefinition | null;
    readonly fromDockerfile: string | null;
    readonly createAgentSandbox: (
      agent: AgentDefinition,
    ) => ReturnType<typeof import("../../agent/onboard").createAgentSandbox>;
    readonly resolvePatchInput: () => Omit<
      ResolveBuildPatchInput,
      "selectedGpuRoute" | "stagedDockerfile"
    >;
  };
  readonly plan: {
    readonly intent: SandboxCreateIntent;
    readonly portableLifecycle?: boolean;
    readonly policylessCreate?: boolean;
    readonly deferSandboxEffectsUntilIdentityVerification?: boolean;
    readonly skipProviderEffects?: boolean;
    readonly rebindMessagingTokenDefs: () => Promise<readonly MessagingTokenDef[]>;
    readonly runProviderPreDeleteCleanup: MaterializeSandboxCreatePlanInput["runProviderPreDeleteCleanup"];
    readonly upsertMessagingProviders: MaterializeSandboxCreatePlanInput["upsertMessagingProviders"];
    readonly getHermesToolGatewayProviderName: (sandboxName: string) => string;
    readonly discloseInitialSandboxPolicy: (policy: InitialSandboxPolicy) => void;
  };
  readonly launchInput: Omit<
    SandboxCreateLaunchInput,
    "createArgs" | "managedStartupRootApplyRequest"
  > & { readonly sandboxName: string };
  readonly plannedMessagingPlan: SandboxMessagingPlan | null;
  readonly messagingConfig?: MaterializeSandboxCreatePlanInput["messagingConfig"];
  readonly gpu: {
    readonly provider: string;
    readonly config: SandboxGpuConfig;
    readonly dockerDriverGateway: boolean;
    readonly gatewayPort: number;
  };
  readonly dependencies: {
    readonly materializeSandboxCreatePlan: (
      input: MaterializeSandboxCreatePlanInput,
    ) => Promise<SandboxCreatePlan>;
    readonly prepareSandboxBuildPatchConfig: typeof import("../sandbox-build-patch-config").prepareSandboxBuildPatchConfig;
    readonly resolveSandboxBuildPatch?: typeof import("../prepared-dcode-rebuild").resolveSandboxBuildPatch;
  };
  readonly log?: (message: string) => void;
  readonly onExit?: (cleanup: () => void) => void;
}

interface PreparedOnboardSandboxWorkloadLaunchBase {
  readonly initialSandboxPolicy: InitialSandboxPolicy;
  readonly messagingProviders: string[];
  readonly gpuRoutePlan: SandboxCreateIntent["gpuRoutePlan"];
  readonly compatibilityPolicyPath: string | null;
  readonly activateDeferredProviderEffects: SandboxCreatePlan["activateDeferredProviderEffects"];
  readonly initialGpuRoute: SelectedDockerGpuRoute;
  readonly sandboxReadyTimeoutSecs: number;
  readonly buildId: string;
  readonly dashboardRemoteBindPrepared: boolean;
  readonly legacyBuildContext: CreateSandboxBuildContextResult | null;
}

export type PreparedOnboardSandboxWorkloadLaunch = PreparedOnboardSandboxWorkloadLaunchBase & {
  readonly createRequestPlan: PlannedOpenShellSandboxCreateRequest;
  readonly launch: SandboxRuntimeLaunchWithPrebuild;
};

function requireLegacyBuildContext(
  buildContext: CreateSandboxBuildContextResult | null,
): CreateSandboxBuildContextResult {
  if (!buildContext)
    throw new Error("Legacy sandbox workload is missing its staged build context.");
  return buildContext;
}

/** Materialize one managed-image or legacy-Dockerfile launch without mixing their build paths. */
export async function prepareOnboardSandboxWorkloadLaunch(
  input: PrepareOnboardSandboxWorkloadLaunchInput,
): Promise<PreparedOnboardSandboxWorkloadLaunch> {
  if (input.workload.source.kind === "portable-image") {
    throw new Error("Portable image workload activation is not enabled.");
  }
  const log = input.log ?? console.log;
  const legacyBuildContext =
    input.workload.source.kind === "legacy-dockerfile"
      ? resolveSandboxBuildContext(
          {
            preparedBuildContext: input.legacy.preparedBuildContext,
            agent: input.legacy.agent,
            fromDockerfile: input.legacy.fromDockerfile,
          },
          { createAgentSandbox: input.legacy.createAgentSandbox },
        )
      : null;
  const fromRef =
    input.workload.source.kind === "managed-image"
      ? input.workload.source.reference
      : `${requireLegacyBuildContext(legacyBuildContext).buildCtx}/Dockerfile`;
  const messagingTokenDefs = await input.plan.rebindMessagingTokenDefs();
  const createPlan = await input.dependencies.materializeSandboxCreatePlan({
    intent: input.plan.intent,
    fromRef,
    portableLifecycle: input.plan.portableLifecycle,
    policylessCreate: input.plan.policylessCreate,
    deferSandboxEffectsUntilIdentityVerification:
      input.plan.deferSandboxEffectsUntilIdentityVerification,
    skipProviderEffects: input.plan.skipProviderEffects,
    messagingTokenDefs: [...messagingTokenDefs],
    messagingConfig:
      input.messagingConfig ?? getMessagingChannelConfigFromPlan(input.plannedMessagingPlan),
    runProviderPreDeleteCleanup: input.plan.runProviderPreDeleteCleanup,
    upsertMessagingProviders: input.plan.upsertMessagingProviders,
    getHermesToolGatewayProviderName: input.plan.getHermesToolGatewayProviderName,
    discloseInitialSandboxPolicy: input.plan.discloseInitialSandboxPolicy,
  });
  if (createPlan.initialSandboxPolicy.cleanup) {
    (input.onExit ?? ((cleanup) => process.on("exit", cleanup)))(
      createPlan.initialSandboxPolicy.cleanup,
    );
  }
  if (input.plan.intent.sandboxGpuLogMessage) log(input.plan.intent.sandboxGpuLogMessage);
  log(
    `  Creating sandbox '${input.launchInput.sandboxName}' (this takes a few minutes on first run)...`,
  );

  const configuredMessagingChannels =
    getChannelsFromPlan(input.plannedMessagingPlan) ?? createPlan.activeMessagingChannels;
  const initialGpuRoute = initialDockerGpuRoute(createPlan.gpuRoutePlan);
  const sandboxReadyTimeoutSecs = getSandboxReadyTimeoutSecs(input.gpu.config);
  const launchInput = input.launchInput;

  let buildId = String(Date.now());
  let dashboardRemoteBindPrepared = false;
  let prepared: {
    readonly createRequest: PlannedOpenShellSandboxCreateRequest;
    readonly launch: SandboxRuntimeLaunchWithPrebuild;
  };
  if (input.workload.source.kind === "managed-image") {
    const runtimeProvider = requireManagedRuntimeProvider(input.runtime.runtimeProvider);
    const gatewayRuntime = runtimeProvider.gateway.prepareHostRuntime({
      environment: process.env,
      platform: process.platform,
    });
    await enforceDockerGpuPatchPreserveNetwork(input.gpu.provider, input.gpu.config, {
      dockerDriverGateway: input.gpu.dockerDriverGateway,
      selectedRoute: initialGpuRoute,
      gatewayPort: input.gpu.gatewayPort,
      log,
      reverifyBridgeReachability: () =>
        verifySandboxBridgeGatewayReachableOrExit(true, {
          skip: false,
          port: input.gpu.gatewayPort,
          reachabilityImpl: (options) =>
            isSandboxBridgeGatewayReachable({ ...options, gatewayRuntime }),
        }),
    });
    const profile = input.runtime.ensurePreparedProfile(input.workload);
    if (!profile) throw new Error("Managed sandbox workload is missing its startup profile.");
    dashboardRemoteBindPrepared =
      profile.profile.dashboard.agent === "openclaw" && profile.profile.dashboard.mode === "remote";
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: profile.profile.agent,
      encodedProfile: profile.encodedProfile,
      ...(profile.corporateCaB64 === undefined ? {} : { corporateCaB64: profile.corporateCaB64 }),
    });
    const managedLaunch = prepareSandboxRuntimeLaunch({
      ...launchInput,
      policyAttached: Boolean(createPlan.createRequest.policyPath),
      managedStartupRootApplyRequest: rootApplyRequest,
    });
    prepared = {
      createRequest: createPlan.createRequest,
      launch: {
        ...managedLaunch,
        prebuild: { imageRef: null, imageId: null },
      },
    };
  } else {
    const buildContext = requireLegacyBuildContext(legacyBuildContext);
    input.dependencies.prepareSandboxBuildPatchConfig({ configuredMessagingChannels });
    const patchInput = input.legacy.resolvePatchInput();
    const patch = await (input.dependencies.resolveSandboxBuildPatch ?? resolveSandboxBuildPatch)({
      // Build-context staging resolves managed-agent base-image provenance.
      // Read the patch input only after that boundary so the final image gets
      // the exact metadata produced by the same staging operation.
      ...patchInput,
      // A prepared rebuild must retain its original target for identity checks.
      // Fresh generated builds use the managed-agent Dockerfile patch policy.
      fromDockerfile:
        !patchInput.preparedBuildContext && buildContext.origin === "generated"
          ? null
          : patchInput.fromDockerfile,
      selectedGpuRoute: initialGpuRoute,
      stagedDockerfile: buildContext.stagedDockerfile,
    });
    buildId = patch.buildId;
    dashboardRemoteBindPrepared = patch.dashboardRemoteBindPrepared;
    const runtimeLaunch = prepareSandboxRuntimeLaunch({
      ...launchInput,
      policyAttached: Boolean(createPlan.createRequest.policyPath),
    });
    const { createArgs: _portableArgs, ...prebuild } = await prebuildSandboxImageIfEligible({
      buildCtx: buildContext.buildCtx,
      buildId,
      dockerDriverGateway: input.gpu.dockerDriverGateway,
      origin: buildContext.origin,
      sourceReference: createPlan.createRequest.source.reference,
      sandboxName: input.launchInput.sandboxName,
      requiresLocalBuildKit: requiresLocalSandboxBuildKit(buildContext.origin, input.legacy.agent),
    });
    prepared = {
      createRequest: createPlan.createRequest,
      launch: { ...runtimeLaunch, prebuild },
    };
  }

  const sharedLaunch = {
    initialSandboxPolicy: createPlan.initialSandboxPolicy,
    messagingProviders: createPlan.messagingProviders,
    gpuRoutePlan: createPlan.gpuRoutePlan,
    compatibilityPolicyPath: createPlan.compatibilityPolicyPath,
    activateDeferredProviderEffects: createPlan.activateDeferredProviderEffects,
    initialGpuRoute,
    sandboxReadyTimeoutSecs,
    buildId,
    dashboardRemoteBindPrepared,
    legacyBuildContext,
  };
  return {
    ...sharedLaunch,
    createRequestPlan: Object.freeze({
      ...prepared.createRequest,
      source: Object.freeze({
        reference:
          prepared.launch.prebuild.sourceReference ?? prepared.createRequest.source.reference,
      }),
    }),
    launch: prepared.launch,
  };
}

/** Build the complete schema-5 launch descriptor before any shared onboarding effect. */
export function prepareHermesPortableOnboardSandboxLaunch(input: {
  readonly intent: SandboxCreateIntent;
  readonly fromRef: string;
  readonly launchInput: Omit<SandboxCreateLaunchInput, "createArgs">;
  readonly gpuConfig: SandboxGpuConfig;
}): PreparedOnboardSandboxWorkloadLaunch {
  const createPlan = materializeHermesPortableCreatePlan({
    intent: input.intent,
    fromRef: input.fromRef,
  });
  const launch = prepareSandboxRuntimeLaunch({
    ...input.launchInput,
    policyAttached: Boolean(createPlan.createRequest.policyPath),
  });
  return {
    ...createPlan,
    initialGpuRoute: initialDockerGpuRoute(createPlan.gpuRoutePlan),
    sandboxReadyTimeoutSecs: getSandboxReadyTimeoutSecs(input.gpuConfig),
    buildId: "hermes-portable",
    dashboardRemoteBindPrepared: false,
    legacyBuildContext: null,
    createRequestPlan: createPlan.createRequest,
    launch: {
      ...launch,
      prebuild: {
        sourceReference: createPlan.createRequest.source.reference,
        imageRef: null,
        imageId: null,
      },
    },
  };
}

export async function prepareSelectedOnboardSandboxWorkloadLaunch(
  hermesPortable: boolean,
  prepareHermes: () => PreparedOnboardSandboxWorkloadLaunch,
  prepareOrdinary: () => Promise<PreparedOnboardSandboxWorkloadLaunch>,
): Promise<PreparedOnboardSandboxWorkloadLaunch> {
  return hermesPortable ? prepareHermes() : await prepareOrdinary();
}

export function resolveOnboardSandboxWorkloadReceipt(input: {
  readonly runtime: ManagedWorkloadOnboardRuntime;
  readonly workload: PreparedSandboxWorkloadSource;
  readonly registryImageRef: string | null;
  readonly prebuildImageRef: string | null;
  readonly firstCreateOutput: string;
  readonly createOutput: string;
  readonly buildId: string;
  readonly extractBuiltImageRef: typeof import("../../build-context").extractBuiltImageRef;
  readonly resolveSandboxImageTagFromCreateOutput: typeof import("../../domain/sandbox/image-tag").resolveSandboxImageTagFromCreateOutput;
}): { readonly resolvedImageTag: string; readonly workloadReceipt: SandboxWorkloadReceipt } {
  const output = `${input.firstCreateOutput}\n${input.createOutput}`;
  const resolvedImageTag =
    (input.workload.source.kind === "managed-image" ? input.workload.source.reference : null) ??
    input.registryImageRef ??
    input.prebuildImageRef ??
    input.extractBuiltImageRef(output) ??
    input.resolveSandboxImageTagFromCreateOutput(output, input.buildId);
  if (input.workload.source.kind === "legacy-dockerfile") {
    return {
      resolvedImageTag,
      workloadReceipt: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: resolvedImageTag,
        shared: false,
      },
    };
  }
  if (input.workload.source.kind === "portable-image") {
    throw new Error("Portable image workload activation is not enabled.");
  }
  const profile = input.runtime.ensurePreparedProfile(input.workload);
  if (!profile) throw new Error("Managed sandbox workload is missing its startup profile.");
  return {
    resolvedImageTag,
    workloadReceipt: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: input.workload.source.reference,
      platform: input.workload.source.contract.platform,
      release: input.workload.source.contract.source.release,
      sourceRevision: input.workload.source.contract.source.revision,
      sourceCohort: input.workload.source.contract.source.cohort,
      capabilityContractVersion: input.workload.source.contract.capabilityContractVersion,
      startupProfileContractVersion: input.workload.source.contract.startupProfileContractVersion,
      encodedProfile: profile.encodedProfile,
      startupProfileSha256: profile.startupProfileSha256,
      credentialProxyReplayRequired: profile.credentialProxyReplayRequired,
      ...(profile.corporateCaB64 === undefined ? {} : { corporateCaB64: profile.corporateCaB64 }),
      shared: true,
    },
  };
}
