// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { loadAgent } from "../agent/defs";
import type { SandboxMessagingPlan } from "../messaging";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import { encodeManagedStartupProfile, type ManagedStartupProfile } from "./managed-startup/profile";
import {
  createManagedWorkloadOnboardRuntime,
  prepareOnboardSandboxWorkloadLaunch,
  resolveOnboardSandboxWorkloadReceipt,
} from "./managed-workload/onboard-orchestration";
import * as preparedDcodeRebuild from "./prepared-dcode-rebuild";
import type { MaterializeSandboxCreatePlanInput } from "./sandbox-create-intent-types";
import * as sandboxCreateLaunch from "./sandbox-create-launch";
import type { SandboxCreatePlan } from "./sandbox-create-plan-materialization";
import * as workloadPreparation from "./workload/preparation";
import {
  managedWorkloadRebuildDependencies,
  managedWorkloadRebuildHandoffMatchesEntry,
  managedWorkloadRebuildProfileEnvironment,
  prepareManagedWorkloadRebuildHandoff,
  prepareSandboxWorkloadSourceFromRebuildHandoff,
  stageManagedWorkloadRebuildProfile,
} from "./workload/rebuild";
import * as workloadRuntime from "./workload/runtime";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const MANAGED_IMAGE_PLATFORM = MANAGED_IMAGE_PLATFORMS[0];
const RUNTIME = {
  driverName: "docker",
  managedImageSelectionPolicy: "prefer-managed",
  legacyDockerfileBuilds: true,
  managedImages: {
    exactDigestReferences: true,
    platforms: [MANAGED_IMAGE_PLATFORM],
    startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
    capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
  },
} as const satisfies SandboxWorkloadRuntimeCapabilities;
const ARM64_RUNTIME = {
  ...RUNTIME,
  managedImages: {
    ...RUNTIME.managedImages,
    platforms: [MANAGED_IMAGE_PLATFORMS[1]],
  },
} as const satisfies SandboxWorkloadRuntimeCapabilities;

const OLD_RELEASE = "v0.0.97";
const NEW_RELEASE = "v0.0.98";
const OLD_REVISION = "1".repeat(40);
const NEW_REVISION = "2".repeat(40);
const OLD_COHORT = "ghrun-123-1";
const NEW_COHORT = "ghrun-456-2";

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

function contract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest: `sha256:${string}` = `sha256:${(generation === "old" ? "a" : "b").repeat(64)}`;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest: digest as `sha256:${string}`,
    reference: `${image}@${digest}` as ManagedImageContractV1["reference"],
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: generation === "old" ? OLD_REVISION : NEW_REVISION,
      release: generation === "old" ? OLD_RELEASE : NEW_RELEASE,
      cohort: generation === "old" ? OLD_COHORT : NEW_COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function entry(
  agent: ShippedManagedImageAgent,
  options: {
    corporateCa?: boolean;
    credentialProxyReplayRequired?: boolean;
    profile?: ManagedStartupProfile;
  } = {},
): SandboxEntry {
  const profile =
    options.profile ??
    managedStartupE2eProfile(
      agent,
      false,
      options.corporateCa === true,
      options.credentialProxyReplayRequired === true,
    );
  const encodedProfile = encodeManagedStartupProfile(profile);
  const old = contract(agent, "old");
  const workload: SandboxWorkloadReceipt = {
    schemaVersion: 1,
    kind: "managed-image",
    reference: old.reference,
    release: old.source.release,
    sourceRevision: old.source.revision,
    sourceCohort: old.source.cohort,
    capabilityContractVersion: old.capabilityContractVersion,
    startupProfileContractVersion: old.startupProfileContractVersion,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: options.credentialProxyReplayRequired === true,
    ...(options.corporateCa
      ? {
          corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString(
            "base64",
          ),
        }
      : {}),
    shared: true,
  };
  return {
    name: "alpha",
    agent: agent === "openclaw" ? null : agent,
    fromDockerfile: null,
    imageTag: old.reference,
    workload,
  };
}

function installReplacement(agent: ShippedManagedImageAgent) {
  const replacement = contract(agent, "new");
  const spy = vi
    .spyOn(managedWorkloadRebuildDependencies, "prepareSandboxWorkloadSource")
    .mockResolvedValue({
      source: { kind: "managed-image", reference: replacement.reference, contract: replacement },
      release: NEW_RELEASE,
      fallbackDiagnostic: null,
    });
  return { replacement, spy };
}

function messagingPlan(agent: "openclaw" | "hermes"): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent,
    workflow: "rebuild",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function profileInput(
  agent: ShippedManagedImageAgent,
): Parameters<typeof stageManagedWorkloadRebuildProfile>[1] {
  const dashboardEnabled = agent !== "langchain-deepagents-code";
  return {
    inference: {
      routeProvider: "inference",
      upstreamProvider: "nvidia-prod",
      model: "nvidia/new-model",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl:
        agent === "langchain-deepagents-code" ? "https://integrate.api.nvidia.com/v1" : null,
      api: "openai-completions",
      primaryModelRef: agent === "openclaw" ? "inference/nvidia/new-model" : null,
      compatibility: agent === "openclaw" ? {} : null,
    },
    chatUiUrl: dashboardEnabled ? "http://127.0.0.1:18789" : "",
    effectiveDashboardPort: dashboardEnabled ? 18_789 : 0,
    manageDashboard: dashboardEnabled,
    dashboardBindAddress: undefined,
    wslExposure: false,
    hermesDashboardState: { config: null, enabled: false },
    webSearch:
      agent === "langchain-deepagents-code"
        ? null
        : { fetchEnabled: true, provider: agent === "hermes" ? "tavily" : "brave" },
    toolDisclosure: "direct",
    hermesToolGateways: agent === "hermes" ? ["nous-image"] : [],
    messagingPlan: agent === "langchain-deepagents-code" ? null : messagingPlan(agent),
    dcodeAutoApprovalMode: agent === "langchain-deepagents-code" ? "thread-opt-in" : "disabled",
    observabilityEnabled: agent === "langchain-deepagents-code",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("managed workload rebuild handoff", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("validates old %s authority and pins the current all-agent release image", async (agent) => {
    const oldEntry = entry(agent);
    const { replacement, spy } = installReplacement(agent);

    const handoff = await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.previousReceipt.reference).toBe(oldEntry.imageTag);
    expect(handoff?.replacement.source.reference).toBe(replacement.reference);
    expect(handoff?.replacement.source.reference).not.toBe(oldEntry.imageTag);
    expect(handoff?.replacement.source.contract.source).toEqual({
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: NEW_REVISION,
      release: NEW_RELEASE,
      cohort: NEW_COHORT,
    });
    expect(handoff?.previousProfile.agent).toBe(agent);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: agent,
        runtime: RUNTIME,
        version: NEW_RELEASE,
        policy: "require-managed",
      }),
    );
    expect(prepareSandboxWorkloadSourceFromRebuildHandoff(handoff!, RUNTIME).source).toEqual(
      handoff?.replacement.source,
    );
    expect(managedWorkloadRebuildHandoffMatchesEntry(handoff!, oldEntry)).toBe(true);
  });

  it("interprets a pre-platform receipt as amd64 and rejects it on an arm64-only runtime", async () => {
    const oldEntry = entry("openclaw");
    installReplacement("openclaw");
    const handoff = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;

    expect(handoff.previousReceipt.platform).toBeUndefined();
    expect(handoff.previousContract.platform).toBe(MANAGED_IMAGE_PLATFORMS[0]);
    expect(() => prepareSandboxWorkloadSourceFromRebuildHandoff(handoff, ARM64_RUNTIME)).toThrow(
      "recorded managed workload is not supported by the selected runtime",
    );
  });

  it.each(
    SHIPPED_MANAGED_IMAGE_AGENTS,
  )("carries the exact staged %s rebuild through managed launch and durable receipt", async (agent) => {
    const oldEntry = entry(agent, { corporateCa: agent === "openclaw" });
    const { replacement, spy: catalogSelection } = installReplacement(agent);
    const catalogHandoff = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;
    const handoff = stageManagedWorkloadRebuildProfile(catalogHandoff, profileInput(agent), {});
    const innerPreparation = vi
      .spyOn(workloadPreparation, "prepareSandboxWorkloadSource")
      .mockRejectedValue(new Error("inner onboarding attempted catalog or fallback preparation"));
    vi.spyOn(workloadRuntime, "resolveSandboxWorkloadRuntimeCapabilities").mockReturnValue(RUNTIME);
    const legacyBuildContext = vi
      .spyOn(preparedDcodeRebuild, "resolveSandboxBuildContext")
      .mockImplementation(() => {
        throw new Error("managed rebuild entered legacy build-context preparation");
      });
    const legacyBuildPatch = vi
      .spyOn(preparedDcodeRebuild, "resolveSandboxBuildPatch")
      .mockImplementation(() => {
        throw new Error("managed rebuild entered legacy Dockerfile patching");
      });
    const legacyPrebuild = vi
      .spyOn(sandboxCreateLaunch, "prepareSandboxCreateLaunchWithPrebuild")
      .mockImplementation(() => {
        throw new Error("managed rebuild entered legacy image prebuild");
      });
    const resolveAgentInferenceApi = vi.fn(() => {
      throw new Error("managed rebuild regenerated its inference API");
    });
    const getSandboxInferenceConfig = vi.fn(() => {
      throw new Error("managed rebuild regenerated its inference profile");
    });
    const note = vi.fn();
    const fallbackBuildEstimate = vi.fn(() => "legacy build estimate");
    const dashboardEnabled = agent !== "langchain-deepagents-code";
    const selectedAgent = agent === "openclaw" ? null : loadAgent(agent);
    const runtime = createManagedWorkloadOnboardRuntime(
      {
        computePlan: { driverName: "docker", gatewayLauncher: "nemoclaw" },
        managedWorkloadRebuild: handoff,
        agentName: agent,
        legacyDockerfilePath: "/repo/agents/forbidden/Dockerfile",
        customDockerfilePath: null,
        rootDir: "/repo",
        model: "must-not-regenerate",
        provider: "nvidia-prod",
        preferredInferenceApi: null,
        endpointUrl: "https://must-not-regenerate.example.test/v1",
        startupProfile: { ...profileInput(agent), environment: {} },
        note,
        fallbackBuildEstimate,
      },
      { resolveAgentInferenceApi, getSandboxInferenceConfig },
    );

    const workload = await runtime.ensurePreparedWorkload();
    expect(await runtime.ensurePreparedWorkload()).toBe(workload);
    expect(workload.source).toEqual(handoff.replacement.source);
    expect(runtime.ensurePreparedProfile(workload)).toBe(handoff.replacementProfile);

    const intent = {
      sandboxName: "alpha",
      inferenceProvider: "inference",
      activeMessagingChannels: [],
      messagingProviderRequests: [],
      reusableMessagingProviders: [],
      extraProviders: [],
      staleExtraProviders: [],
      hermesToolGateways: [],
      policy: {
        basePolicyPath: "/repo/policy.yaml",
        activeMessagingChannels: [],
        options: {
          directGpu: false,
          additionalPresets: [],
          policyTier: null,
          baselineExclusions: [],
        },
      },
      gpuCreateArgs: [],
      resourceCreateArgs: [],
      gpuRoutePlan: "none",
      sandboxGpuLogMessage: null,
      disabledChannelNames: [],
      extraPlaceholderKeys: [],
    } as const;
    const materializeSandboxCreatePlan = vi.fn(
      (input: MaterializeSandboxCreatePlanInput): SandboxCreatePlan => ({
        activeMessagingChannels: [],
        initialSandboxPolicy: { policyPath: "/tmp/managed-policy.yaml", appliedPresets: [] },
        policyTier: null,
        createArgs: [
          "--from",
          input.fromRef,
          "--name",
          input.intent.sandboxName,
          "--policy",
          "/tmp/managed-policy.yaml",
        ],
        messagingProviders: [],
        gpuRoutePlan: "none",
        compatibilityPolicyPath: null,
        sandboxGpuLogMessage: null,
      }),
    );
    const createAgentSandbox = vi.fn(() => {
      throw new Error("managed rebuild staged an agent Dockerfile");
    });
    const prepareSandboxBuildPatchConfig = vi.fn(() => {
      throw new Error("managed rebuild prepared Dockerfile patch configuration");
    });
    const launch = await prepareOnboardSandboxWorkloadLaunch({
      runtime,
      workload,
      legacy: {
        preparedBuildContext: null,
        agent: selectedAgent,
        fromDockerfile: null,
        createAgentSandbox,
        patchInput: {} as never,
      },
      plan: {
        intent,
        rebindMessagingTokenDefs: async () => [],
        runProviderPreDeleteCleanup: vi.fn(),
        upsertMessagingProviders: vi.fn(() => []),
        getHermesToolGatewayProviderName: vi.fn(() => "hermes-tools"),
        discloseInitialSandboxPolicy: vi.fn(),
      },
      launchInput: {
        agent: selectedAgent,
        observabilityEnabled: agent === "langchain-deepagents-code",
        chatUiUrl: dashboardEnabled ? "http://127.0.0.1:18789" : "",
        sandboxName: "alpha",
        env: {},
        extraPlaceholderKeys: [],
        getDashboardForwardPort: () => (dashboardEnabled ? "18789" : "0"),
        hermesDashboardState: { config: null, enabled: false },
        manageDashboard: dashboardEnabled,
        openshellShellCommand: (args) => args.join(" "),
        openshellArgv: (args) => [...args],
        buildEnv: () => ({}),
      },
      plannedMessagingPlan: null,
      gpu: {
        provider: "nvidia-prod",
        config: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        dockerDriverGateway: true,
        gatewayPort: 8_080,
      },
      dependencies: {
        materializeSandboxCreatePlan,
        prepareSandboxBuildPatchConfig,
      },
      log: vi.fn(),
    });

    const replacementReference = handoff.replacement.source.reference;
    const encodedProfile = handoff.replacementProfile.encodedProfile;
    const fromIndexes = launch.launch.createArgv.flatMap((argument, index) =>
      argument === "--from" ? [index] : [],
    );
    expect(fromIndexes).toHaveLength(1);
    expect(launch.launch.createArgv[fromIndexes[0]! + 1]).toBe(replacementReference);
    expect(replacementReference).toBe(`${replacement.image}@${replacement.digest}`);
    expect(launch.launch.managedStartupRootApplyRequest?.encodedProfile).toBe(encodedProfile);
    expect(launch.launch.sandboxStartupCommand).toContain(
      "/usr/local/bin/nemoclaw-managed-startup-hold",
    );
    expect(launch.launch.createArgv.join("\n")).not.toContain(encodedProfile);
    expect(launch.launch.sandboxStartupCommand.join("\n")).not.toContain(encodedProfile);
    expect(launch.launch.startupRequirement).toBe("trusted-image-init");
    expect(launch.launch.createArgv.join("\n")).not.toContain("Dockerfile");
    expect(launch.legacyBuildContext).toBeNull();
    expect(launch.launch.prebuild).toEqual({
      createArgs: expect.arrayContaining(["--from", replacementReference]),
      imageRef: null,
      imageId: null,
    });
    expect(materializeSandboxCreatePlan).toHaveBeenCalledWith(
      expect.objectContaining({ fromRef: replacementReference }),
    );

    const extractBuiltImageRef = vi.fn(() => "legacy-built-image");
    const resolveSandboxImageTagFromCreateOutput = vi.fn(() => "legacy-output-image");
    const resolved = resolveOnboardSandboxWorkloadReceipt({
      runtime,
      workload,
      registryImageRef: "legacy-registry-image",
      prebuildImageRef: "legacy-prebuild-image",
      firstCreateOutput: "legacy first output",
      createOutput: "legacy create output",
      buildId: "legacy-build-id",
      extractBuiltImageRef,
      resolveSandboxImageTagFromCreateOutput,
    });

    expect(resolved.resolvedImageTag).toBe(replacementReference);
    expect(resolved.workloadReceipt).toEqual({
      schemaVersion: 1,
      kind: "managed-image",
      reference: replacementReference,
      platform: handoff.replacement.source.contract.platform,
      release: handoff.replacement.source.contract.source.release,
      sourceRevision: handoff.replacement.source.contract.source.revision,
      sourceCohort: handoff.replacement.source.contract.source.cohort,
      capabilityContractVersion: handoff.replacement.source.contract.capabilityContractVersion,
      startupProfileContractVersion:
        handoff.replacement.source.contract.startupProfileContractVersion,
      encodedProfile,
      startupProfileSha256: handoff.replacementProfile.startupProfileSha256,
      credentialProxyReplayRequired: handoff.replacementProfile.credentialProxyReplayRequired,
      ...(handoff.replacementProfile.corporateCaB64 === undefined
        ? {}
        : { corporateCaB64: handoff.replacementProfile.corporateCaB64 }),
      shared: true,
    });
    expect(catalogSelection).toHaveBeenCalledOnce();
    expect(innerPreparation).not.toHaveBeenCalled();
    expect(legacyBuildContext).not.toHaveBeenCalled();
    expect(legacyBuildPatch).not.toHaveBeenCalled();
    expect(legacyPrebuild).not.toHaveBeenCalled();
    expect(createAgentSandbox).not.toHaveBeenCalled();
    expect(prepareSandboxBuildPatchConfig).not.toHaveBeenCalled();
    expect(resolveAgentInferenceApi).not.toHaveBeenCalled();
    expect(getSandboxInferenceConfig).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(fallbackBuildEstimate).not.toHaveBeenCalled();
    expect(extractBuiltImageRef).not.toHaveBeenCalled();
    expect(resolveSandboxImageTagFromCreateOutput).not.toHaveBeenCalled();
  });

  it("retains validated corporate CA bytes while selecting a new OpenClaw image", async () => {
    const oldEntry = entry("openclaw", { corporateCa: true });
    installReplacement("openclaw");

    const handoff = await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    });

    expect(handoff?.corporateCa?.pem).toBe(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM);
  });

  it("preserves credential-proxy replay while allowing other profile env to change", async () => {
    const oldEntry = entry("hermes", { credentialProxyReplayRequired: true });
    installReplacement("hermes");
    const handoff = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;

    expect(
      managedWorkloadRebuildProfileEnvironment(handoff, {
        HTTPS_PROXY: "http://user:password@proxy.example.test:8443",
        NEMOCLAW_CONTEXT_WINDOW: "196608",
      }),
    ).toEqual({
      HTTPS_PROXY: "http://user:password@proxy.example.test:8443",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
    });
  });

  it("renders a complete OpenClaw replacement profile before mutation while preserving receipt-only tuning", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("openclaw"),
    ) as DeepMutable<ManagedStartupProfile>;
    assert(previous.agentConfig.agent === "openclaw", "fixture drift");
    previous.proxy.managedHost = "10.44.0.9";
    previous.proxy.managedPort = 4312;
    previous.tuning.contextWindow = 196_608;
    previous.tuning.maxTokens = 16_384;
    previous.tuning.reasoning = true;
    previous.tuning.reasoningEffort = "high";
    previous.inference.inputModalities = ["text", "image"];
    previous.agentConfig.agentTimeoutSeconds = 777;
    previous.agentConfig.heartbeatEvery = "45s";
    previous.agentConfig.extraAgents = {
      agents: [{ id: "reviewer" }],
      defaults: { subagents: {} },
      main: { model: "primary" },
    };
    previous.agentConfig.otel = {
      enabled: true,
      endpointUrl: "http://otel.example.test:4318",
      serviceName: "custom-openclaw",
      sampleRate: 0.25,
    };
    previous.agentConfig.minimalBootstrap = false;

    installReplacement("openclaw");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("openclaw", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(catalog, profileInput("openclaw"), {});

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: {
        model: "nvidia/new-model",
        upstreamProvider: "nvidia-prod",
        inputModalities: ["image", "text"],
      },
      tools: { disclosure: "direct" },
      proxy: { managedHost: "10.44.0.9", managedPort: 4312 },
      tuning: {
        contextWindow: 196_608,
        maxTokens: 16_384,
        reasoning: true,
        reasoningEffort: "high",
      },
      agentConfig: {
        agent: "openclaw",
        agentTimeoutSeconds: 777,
        heartbeatEvery: "45s",
        minimalBootstrap: false,
        otel: {
          enabled: true,
          endpointUrl: "http://otel.example.test:4318",
          serviceName: "custom-openclaw",
          sampleRate: 0.25,
        },
        webSearch: { enabled: true, provider: "brave" },
      },
    });
    expect(handoff.replacementProfile.profile.messaging.plan).not.toBeNull();
    expect(handoff.replacementProfile.encodedProfile).not.toBe(
      catalog.previousReceipt.encodedProfile,
    );
  });

  it("preserves Hermes receipt-only context and proxy while applying current tools and messaging", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("hermes"),
    ) as DeepMutable<ManagedStartupProfile>;
    previous.proxy.managedHost = "10.55.0.7";
    previous.proxy.managedPort = 5312;
    previous.tuning.contextWindow = 262_144;

    installReplacement("hermes");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("hermes", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(catalog, profileInput("hermes"), {});

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: { model: "nvidia/new-model" },
      tools: { disclosure: "direct", enabledGateways: ["nous-image"] },
      proxy: { managedHost: "10.55.0.7", managedPort: 5312 },
      tuning: {
        contextWindow: 262_144,
        maxTokens: null,
        reasoning: null,
        reasoningEffort: null,
      },
      agentConfig: {
        agent: "hermes",
        webSearch: { enabled: true, provider: "tavily" },
      },
    });
    expect(handoff.replacementProfile.profile.messaging.plan).not.toBeNull();
  });

  it("preserves DCode receipt-only proxy while applying current disclosure, approval, and observability", async () => {
    const previous = structuredClone(
      managedStartupE2eProfile("langchain-deepagents-code"),
    ) as DeepMutable<ManagedStartupProfile>;
    previous.proxy.managedHost = "10.66.0.5";
    previous.proxy.managedPort = 6312;

    installReplacement("langchain-deepagents-code");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(
      entry("langchain-deepagents-code", { profile: previous }),
      { runtime: RUNTIME, version: NEW_RELEASE },
    ))!;
    const handoff = stageManagedWorkloadRebuildProfile(
      catalog,
      profileInput("langchain-deepagents-code"),
      {},
    );

    expect(handoff.replacementProfile.profile).toMatchObject({
      inference: {
        model: "nvidia/new-model",
        upstreamEndpointUrl: "https://integrate.api.nvidia.com/v1",
      },
      tools: { disclosure: "direct" },
      proxy: { managedHost: "10.66.0.5", managedPort: 6312 },
      agentConfig: {
        agent: "langchain-deepagents-code",
        autoApprovalMode: "thread-opt-in",
        observabilityEnabled: true,
      },
    });
  });

  it("fails profile rendering before a managed credential proxy can be silently dropped", async () => {
    const oldEntry = entry("openclaw", { credentialProxyReplayRequired: true });
    installReplacement("openclaw");
    const catalog = (await prepareManagedWorkloadRebuildHandoff(oldEntry, {
      runtime: RUNTIME,
      version: NEW_RELEASE,
    }))!;

    expect(() => stageManagedWorkloadRebuildProfile(catalog, profileInput("openclaw"), {})).toThrow(
      "changed the durable credential-proxy requirement",
    );
  });

  it("fails closed instead of resolving a catalog for a managed image with no receipt", async () => {
    const oldEntry = entry("openclaw");
    delete oldEntry.workload;
    const { spy } = installReplacement("openclaw");

    await expect(
      prepareManagedWorkloadRebuildHandoff(oldEntry, {
        runtime: RUNTIME,
        version: NEW_RELEASE,
      }),
    ).rejects.toThrow("no valid durable workload receipt");
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed before mutation when the current complete catalog is unavailable", async () => {
    vi.spyOn(managedWorkloadRebuildDependencies, "prepareSandboxWorkloadSource").mockRejectedValue(
      new Error("cohort is torn"),
    );

    await expect(
      prepareManagedWorkloadRebuildHandoff(entry("langchain-deepagents-code"), {
        runtime: RUNTIME,
        version: NEW_RELEASE,
      }),
    ).rejects.toThrow("complete managed-image catalog is unavailable or invalid");
  });
});
