// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../../agent/defs";
import { getVersion } from "../../core/version";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxWorkloadReceipt } from "../../state/registry/types";
import type {
  CreateSandboxBuildContextResult,
  PreparedSandboxBuildContext,
} from "../build-context-stage";
import type { OpenShellComputePlan } from "../compute/plan";
import { resolveCorporateCa } from "../corporate-ca";
import { enforceDockerGpuPatchPreserveNetwork } from "../docker-gpu-local-inference";
import {
  initialDockerGpuRoute,
  renderSandboxCreateArgsForGpuRoute,
  type SelectedDockerGpuRoute,
} from "../docker-gpu-route";
import type { HermesDashboardOnboardState } from "../hermes-dashboard";
import type { InitialSandboxPolicy } from "../initial-policy";
import {
  type BuiltManagedStartupOnboardProfile,
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "../managed-startup/onboard-profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { getChannelsFromPlan } from "../messaging-plan-session";
import type { MessagingTokenDef } from "../messaging-prep";
import { resolveSandboxBuildContext, resolveSandboxBuildPatch } from "../prepared-dcode-rebuild";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundle,
  resolveRuntimeProviderBundle,
} from "../runtime-provider/access";
import type { RuntimeProviderBootstrapSurface } from "../runtime-provider/contract";
import type {
  MaterializeSandboxCreatePlanInput,
  SandboxCreateIntent,
} from "../sandbox-create-intent-types";
import {
  prepareSandboxCreateLaunch,
  prepareSandboxCreateLaunchWithPrebuild,
  type SandboxCreateLaunchInput,
  type SandboxCreateLaunchWithPrebuild,
} from "../sandbox-create-launch";
import { getSandboxReadyTimeoutSecs } from "../sandbox-gpu-create";
import type { SandboxGpuConfig } from "../sandbox-gpu-mode";
import {
  type PreparedSandboxWorkloadSource,
  prepareSandboxWorkloadSource,
} from "../workload/preparation";
import {
  type ManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
} from "../workload/rebuild";
import { resolveSandboxWorkloadRuntimeCapabilities } from "../workload/runtime";

type ManagedProfileInput = Omit<
  ManagedStartupOnboardProfileInput,
  "agentName" | "corporateCa" | "inference"
>;
type ResolveBuildPatchInput = Parameters<typeof resolveSandboxBuildPatch>[0];
type SandboxInferenceConfig = import("../../inference/config").SandboxInferenceConfig;
type SupportedBootstrap = Extract<RuntimeProviderBootstrapSurface, { readonly supported: true }>;
type BootstrapProvider = RuntimeProviderBundle & { readonly bootstrap: SupportedBootstrap };

export interface ManagedWorkloadOnboardDependencies {
  readonly resolveAgentInferenceApi: typeof import("../../inference/config").resolveAgentInferenceApi;
  readonly getSandboxInferenceConfig: typeof import("../../inference/config").getSandboxInferenceConfig;
}

export interface CreateManagedWorkloadOnboardRuntimeInput {
  readonly computePlan: OpenShellComputePlan;
  readonly managedWorkloadRebuild: ManagedWorkloadRebuildHandoff | null;
  readonly tempManagedRuntime: boolean;
  readonly tempManagedRuntimeCatalog: string | null;
  readonly agentName: string;
  readonly legacyDockerfilePath: string;
  readonly customDockerfilePath: string | null;
  readonly rootDir: string;
  readonly model: string;
  readonly provider: string;
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

function requireBootstrapProvider(provider: RuntimeProviderBundle | null): BootstrapProvider {
  if (!provider || !provider.bootstrap.supported) {
    throw new Error("Selected runtime provider does not support managed bootstrap onboarding.");
  }
  return provider as BootstrapProvider;
}

/** Memoize the exact workload and profile used before deletion, launch, and registration. */
export function createManagedWorkloadOnboardRuntime(
  input: CreateManagedWorkloadOnboardRuntimeInput,
  dependencies: ManagedWorkloadOnboardDependencies,
): ManagedWorkloadOnboardRuntime {
  const discoveredRuntimeCapabilities = resolveSandboxWorkloadRuntimeCapabilities(
    input.computePlan,
  );
  const runtimeCapabilities =
    input.tempManagedRuntime || input.managedWorkloadRebuild !== null
      ? discoveredRuntimeCapabilities
      : {
          ...discoveredRuntimeCapabilities,
          managedImageSelectionPolicy: "prefer-managed" as const,
          managedImages: null,
        };
  const runtimeProvider = resolveRuntimeProviderBundle(
    input.computePlan.driverName,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  let preparedWorkloadPromise: Promise<PreparedSandboxWorkloadSource> | null = null;
  let fallbackReported = false;
  let preparedProfile: BuiltManagedStartupOnboardProfile | null = null;

  const ensurePreparedWorkload = async (): Promise<PreparedSandboxWorkloadSource> => {
    preparedWorkloadPromise ??= input.managedWorkloadRebuild
      ? Promise.resolve(
          prepareSandboxWorkloadSourceFromRebuildHandoff(
            input.managedWorkloadRebuild,
            runtimeCapabilities,
            requireBootstrapProvider(runtimeProvider),
          ),
        )
      : prepareSandboxWorkloadSource({
          agentName: input.agentName,
          legacyDockerfilePath: input.legacyDockerfilePath,
          customDockerfilePath: input.customDockerfilePath,
          runtime: runtimeCapabilities,
          version: getVersion({ rootDir: input.rootDir }),
          catalogPath: input.tempManagedRuntimeCatalog,
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
    requireBootstrapProvider(runtimeProvider);
    if (input.managedWorkloadRebuild) {
      if (workload.source.reference !== input.managedWorkloadRebuild.replacement.source.reference) {
        throw new Error("Managed rebuild workload changed before startup profile preparation.");
      }
      return input.managedWorkloadRebuild.replacementProfile;
    }
    if (preparedProfile) return preparedProfile;
    const inferenceApi =
      input.agentName === "langchain-deepagents-code"
        ? "openai-completions"
        : dependencies.resolveAgentInferenceApi(
            input.agentName,
            input.provider,
            input.preferredInferenceApi,
          );
    const inference: SandboxInferenceConfig = dependencies.getSandboxInferenceConfig(
      input.model,
      input.provider,
      inferenceApi,
    );
    preparedProfile = buildManagedStartupOnboardProfile({
      agentName: input.agentName,
      inference: {
        routeProvider: inference.providerKey,
        upstreamProvider: input.provider.trim() ? input.provider : inference.providerKey,
        model: input.model,
        routedBaseUrl: inference.inferenceBaseUrl,
        upstreamEndpointUrl:
          input.agentName === "langchain-deepagents-code" ? input.endpointUrl : null,
        api: inference.inferenceApi as
          | "openai-completions"
          | "openai-responses"
          | "anthropic-messages",
        primaryModelRef: input.agentName === "openclaw" ? inference.primaryModelRef : null,
        compatibility: input.agentName === "openclaw" ? (inference.inferenceCompat ?? {}) : null,
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
    readonly patchInput: Omit<ResolveBuildPatchInput, "selectedGpuRoute" | "stagedDockerfile">;
  };
  readonly plan: {
    readonly intent: SandboxCreateIntent;
    readonly rebindMessagingTokenDefs: () => Promise<readonly MessagingTokenDef[]>;
    readonly runProviderPreDeleteCleanup: () => void;
    readonly upsertMessagingProviders: MaterializeSandboxCreatePlanInput["upsertMessagingProviders"];
    readonly getHermesToolGatewayProviderName: (sandboxName: string) => string;
    readonly discloseInitialSandboxPolicy: (policy: InitialSandboxPolicy) => void;
  };
  readonly launchInput: Omit<
    SandboxCreateLaunchInput,
    "createArgs" | "managedStartupRootApplyRequest"
  > & { readonly sandboxName: string };
  readonly plannedMessagingPlan: SandboxMessagingPlan | null;
  readonly gpu: {
    readonly provider: string;
    readonly config: SandboxGpuConfig;
    readonly dockerDriverGateway: boolean;
    readonly gatewayPort: number;
  };
  readonly dependencies: {
    readonly materializeSandboxCreatePlan: typeof import("../sandbox-create-plan-materialization").materializeSandboxCreatePlan;
    readonly prepareSandboxBuildPatchConfig: typeof import("../sandbox-build-patch-config").prepareSandboxBuildPatchConfig;
  };
  readonly log?: (message: string) => void;
  readonly onExit?: (cleanup: () => void) => void;
}

export interface PreparedOnboardSandboxWorkloadLaunch {
  readonly initialSandboxPolicy: InitialSandboxPolicy;
  readonly policyTier: string | null;
  readonly messagingProviders: string[];
  readonly gpuRoutePlan: SandboxCreateIntent["gpuRoutePlan"];
  readonly compatibilityPolicyPath: string | null;
  readonly initialGpuRoute: SelectedDockerGpuRoute;
  readonly sandboxReadyTimeoutSecs: number;
  readonly buildId: string;
  readonly dashboardRemoteBindPrepared: boolean;
  readonly legacyBuildContext: CreateSandboxBuildContextResult | null;
  readonly launch: SandboxCreateLaunchWithPrebuild;
}

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
  const createPlan = input.dependencies.materializeSandboxCreatePlan({
    intent: input.plan.intent,
    fromRef,
    messagingTokenDefs: [...messagingTokenDefs],
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
  const launchInput: SandboxCreateLaunchInput & { sandboxName: string } = {
    ...input.launchInput,
    createArgs: renderSandboxCreateArgsForGpuRoute(createPlan.createArgs, initialGpuRoute, {
      compatibilityPolicyPath: createPlan.compatibilityPolicyPath,
    }),
  };

  let buildId = String(Date.now());
  let dashboardRemoteBindPrepared = false;
  let launch: SandboxCreateLaunchWithPrebuild;
  if (input.workload.source.kind === "managed-image") {
    await enforceDockerGpuPatchPreserveNetwork(input.gpu.provider, input.gpu.config, {
      dockerDriverGateway: input.gpu.dockerDriverGateway,
      selectedRoute: initialGpuRoute,
      gatewayPort: input.gpu.gatewayPort,
      log,
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
    const managedLaunch = prepareSandboxCreateLaunch({
      ...launchInput,
      managedStartupRootApplyRequest: rootApplyRequest,
    });
    launch = {
      ...managedLaunch,
      prebuild: { createArgs: [...launchInput.createArgs], imageRef: null, imageId: null },
    };
  } else {
    const buildContext = requireLegacyBuildContext(legacyBuildContext);
    input.dependencies.prepareSandboxBuildPatchConfig({ configuredMessagingChannels });
    const patch = await resolveSandboxBuildPatch({
      ...input.legacy.patchInput,
      selectedGpuRoute: initialGpuRoute,
      stagedDockerfile: buildContext.stagedDockerfile,
    });
    buildId = patch.buildId;
    dashboardRemoteBindPrepared = patch.dashboardRemoteBindPrepared;
    launch = await prepareSandboxCreateLaunchWithPrebuild({
      ...launchInput,
      prebuild: {
        buildCtx: buildContext.buildCtx,
        buildId,
        dockerDriverGateway: input.gpu.dockerDriverGateway,
        origin: buildContext.origin,
      },
    });
  }

  return {
    initialSandboxPolicy: createPlan.initialSandboxPolicy,
    policyTier: createPlan.policyTier,
    messagingProviders: createPlan.messagingProviders,
    gpuRoutePlan: createPlan.gpuRoutePlan,
    compatibilityPolicyPath: createPlan.compatibilityPolicyPath,
    initialGpuRoute,
    sandboxReadyTimeoutSecs,
    buildId,
    dashboardRemoteBindPrepared,
    legacyBuildContext,
    launch,
  };
}

export function resolveOnboardManagedBootstrapLaunch(input: {
  readonly runtime: ManagedWorkloadOnboardRuntime;
  readonly workload: PreparedSandboxWorkloadSource;
  readonly stateRoot: string;
  readonly bootstrapIdentity: string | null;
  readonly request: import("../managed-startup/root-apply").ManagedStartupRootApplyRequest | null;
  readonly intendedWorkloadArgv: readonly string[] | null | undefined;
}) {
  if (input.workload.source.kind !== "managed-image") return null;
  const runtimeProvider = requireBootstrapProvider(input.runtime.runtimeProvider);
  if (!input.bootstrapIdentity || !input.request || !input.intendedWorkloadArgv) {
    throw new Error(
      "Managed image onboarding is missing its identity-bound bootstrap launch contract.",
    );
  }
  return {
    bootstrapIdentity: input.bootstrapIdentity,
    stateRoot: input.stateRoot,
    runtimeProvider,
    authorityStore: runtimeProvider.bootstrap.createAuthorityStore({ stateRoot: input.stateRoot }),
    request: input.request,
    image: {
      repository: input.workload.source.contract.image,
      manifestDigest: input.workload.source.contract.digest,
    },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    intendedWorkloadArgv: input.intendedWorkloadArgv,
    expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox"],
  } as const;
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
