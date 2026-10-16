// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({ digests: [] as string[] }));

vi.mock("../agent/candidate-authority", () => ({
  CANDIDATE_QUALIFICATION_RECEIPT_DIGESTS: { pi: authority.digests },
  acceptedCandidateReceiptDigests: () => authority.digests,
}));

vi.mock("../state/onboard-session", async (original) => ({
  ...(await original<typeof import("../state/onboard-session")>()),
  loadSession: () => ({ sandboxName: "unrelated", endpointUrl: "https://wrong.example/v1" }),
}));

import { HOSTED_NATIVE_PROVIDERS, hostedNativeProvider } from "../inference/native-provider/hosted";
import { getSandboxInferenceConfig, resolveAgentInferenceApi } from "../inference/config";
import { prepareRebuildResumeConfig } from "../actions/sandbox/rebuild-resume-config";
import { prepareManagedRebuildProfileHandoff } from "../actions/sandbox/agents/managed-workload-rebuild-profile";
import type { RebuildTargetConfig } from "../actions/sandbox/rebuild-target-preflight";
import { createManagedWorkloadOnboardRuntime } from "./managed-workload/onboard-orchestration";
import { rebindManagedStartupProfileForClone } from "./managed-startup/clone-rebinder";
import { mapManagedStartupProfileToAgentEnvironment } from "./managed-startup/agent-environment";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  type CandidateQualificationFixture,
  candidateQualificationEnvironment,
} from "../agent/candidate-test-fixture";
import type { SandboxEntry } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
} from "./managed-image/contract";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import {
  ManagedWorkloadRebuildError,
  managedWorkloadRebuildDependencies,
  prepareManagedWorkloadRebuildHandoff,
} from "./workload/rebuild";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const PLATFORM = "linux/amd64" as const;
const ORIGINAL_PREPARE = managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource;

function installedContract(): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES.pi;
  const digest = `sha256:${"1b".repeat(32)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent: "pi",
    platform: PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: "c".repeat(40),
      release: "v0.0.99",
      cohort: "ghrun-7927-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function piEntry(): SandboxEntry {
  const contract = installedContract();
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("pi"));
  return {
    name: "rebuild-pi",
    agent: "pi",
    openshellDriver: "mxc",
    fromDockerfile: null,
    imageTag: contract.reference,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: contract.reference,
      platform: PLATFORM,
      release: contract.source.release,
      sourceRevision: contract.source.revision,
      sourceCohort: contract.source.cohort,
      capabilityContractVersion: contract.capabilityContractVersion,
      startupProfileContractVersion: contract.startupProfileContractVersion,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } as unknown as SandboxEntry;
}

function runtimeCapabilities(providerId = "mxc"): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName: providerId,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [PLATFORM],
      startupProfileContractVersions: [1],
      capabilityContractVersions: [1],
    },
  };
}

function provider(providerId = "mxc"): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: providerId },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: () => true,
    },
    mutationAuthority: { providerId, supported: true, operations: ["rebuild"] },
  } as unknown as RuntimeProviderBundle;
}

describe("Pi candidate managed rebuild", () => {
  let previousEnv: NodeJS.ProcessEnv;
  let fixture: CandidateQualificationFixture | null = null;

  function writeReceipt(): CandidateQualificationFixture {
    fixture = candidateQualificationEnvironment();
    Object.assign(process.env, fixture.env);
    return fixture;
  }

  function publish(receipt: CandidateQualificationFixture): void {
    authority.digests.push(receipt.receiptDigest);
  }

  beforeEach(() => {
    previousEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = previousEnv;
    authority.digests.splice(0, authority.digests.length);
    fixture?.cleanup();
    fixture = null;
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = ORIGINAL_PREPARE;
  });

  it("restores the accepted candidate image without the release catalog (#7927)", async () => {
    publish(writeReceipt());
    const releaseCatalog = vi.fn(ORIGINAL_PREPARE);
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = releaseCatalog;

    const handoff = await prepareManagedWorkloadRebuildHandoff(piEntry(), {
      runtime: runtimeCapabilities(),
      provider: provider(),
      version: "0.0.100",
    });

    expect(handoff).toMatchObject({
      agent: "pi",
      previousReceipt: { kind: "managed-image", release: "v0.0.99" },
      replacement: {
        source: { kind: "managed-image", contract: { agent: "pi", platform: PLATFORM } },
      },
    });
    expect(handoff?.replacement.source.reference).toBe(
      `${MANAGED_IMAGE_REPOSITORIES.pi}@sha256:${"7a".repeat(32)}`,
    );
    // A candidate publishes outside the all-agent cohort, so the release
    // catalog must never be consulted for it.
    expect(releaseCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ...HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.api === "openai-completions"),
    hostedNativeProvider("hermes-provider", "https://authenticated.nous.example/v1")!,
    { logicalProvider: "compatible-endpoint", endpoint: "https://custom.example/v1" },
    { logicalProvider: "ollama-local", endpoint: "http://localhost:11434/v1" },
  ])(
    "preserves Pi $logicalProvider routing through onboarding, rebuild and recovery",
    async (definition) => {
      publish(writeReceipt());
      const native = "profileId" in definition;
      const attachment = native
        ? {
            schemaVersion: 1 as const,
            profileId: definition.profileId,
            providerName: definition.providerName,
            providerId: "owned-provider-id",
            ...("endpointUrl" in definition
              ? { endpointUrl: definition.endpointUrl, allowedIps: ["8.8.8.8"] }
              : {}),
          }
        : undefined;
      const expectedEndpoint = native
        ? definition.endpoint.replace(/\/+$/, "")
        : "https://inference.local/v1";
      const runtime = createManagedWorkloadOnboardRuntime(
        {
          computePlan: { driverName: "docker", gatewayLauncher: "nemoclaw" },
          managedWorkloadRebuild: null,
          tempManagedRuntime: false,
          stockManagedRuntime: true,
          tempManagedRuntimeCatalog: null,
          agentName: "pi",
          legacyDockerfilePath: "agents/pi/Dockerfile",
          customDockerfilePath: null,
          rootDir: process.cwd(),
          model: "supported-model",
          provider: definition.logicalProvider,
          preferredInferenceApi: "openai-completions",
          endpointUrl: definition.endpoint,
          nativeProvider: native,
          startupProfile: {
            chatUiUrl: "",
            effectiveDashboardPort: 0,
            manageDashboard: false,
            dashboardBindAddress: undefined,
            wslExposure: false,
            hermesDashboardState: { config: null, enabled: false },
            webSearch: null,
            toolDisclosure: "progressive",
            hermesToolGateways: [],
            messagingPlan: null,
            dcodeAutoApprovalMode: "disabled",
            observabilityEnabled: false,
            environment: {},
          },
          note: vi.fn(),
          fallbackBuildEstimate: () => null,
        },
        { getSandboxInferenceConfig, resolveAgentInferenceApi },
      );
      const built = runtime.ensurePreparedProfile({ source: { kind: "managed-image" } } as never)!;
      const entry = piEntry();
      Object.assign(entry, {
        provider: definition.logicalProvider,
        model: "supported-model",
        endpointUrl: definition.endpoint,
        preferredInferenceApi: "openai-completions",
        nativeHostedProviderAttachment: attachment,
        credentialEnv: native ? definition.credentialEnv : "COMPATIBLE_API_KEY",
        workload: {
          ...entry.workload,
          encodedProfile: built.encodedProfile,
          startupProfileSha256: built.startupProfileSha256,
        },
      });
      const resume = prepareRebuildResumeConfig(entry.name, entry, "pi", vi.fn(), (message) => {
        throw new Error(message);
      })!;
      expect(resume.nativeHostedProviderAttachment).toEqual(attachment);
      const catalog = (await prepareManagedWorkloadRebuildHandoff(entry, {
        runtime: runtimeCapabilities(),
        provider: provider(),
        version: "0.0.100",
      }))!;
      const rebuilt = prepareManagedRebuildProfileHandoff({
        catalogHandoff: catalog,
        targetConfig: {
          agentDefinition: { runtime: { kind: "terminal" }, forwardPort: 0 },
          resumeConfig: resume,
          durableConfig: { webSearchConfig: null },
          hermesToolGateways: [],
        } as unknown as RebuildTargetConfig,
        recreateOptions: {
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as Parameters<typeof prepareManagedRebuildProfileHandoff>[0]["recreateOptions"],
        messagingPlan: null,
        environment: {},
      });
      const recovered = rebindManagedStartupProfileForClone({
        sourceSandboxName: entry.name,
        destinationSandboxName: "recovered-pi",
        expectedAgent: "pi",
        destinationDashboardPort: null,
        encodedProfile: rebuilt.replacementProfile.encodedProfile,
        startupProfileSha256: rebuilt.replacementProfile.startupProfileSha256,
        currentSource: entry,
      });
      expect(built.profile.inference?.routedBaseUrl.replace(/\/+$/, "")).toBe(expectedEndpoint);
      expect(rebuilt.replacementProfile.profile.inference?.routedBaseUrl.replace(/\/+$/, "")).toBe(
        expectedEndpoint,
      );
      expect(recovered.profile.inference?.routedBaseUrl.replace(/\/+$/, "")).toBe(expectedEndpoint);
      expect(
        mapManagedStartupProfileToAgentEnvironment(
          built.profile,
          {},
        ).configurationEnvironment.NEMOCLAW_INFERENCE_BASE_URL.replace(/\/+$/, ""),
      ).toBe(expectedEndpoint);
      expect(
        mapManagedStartupProfileToAgentEnvironment(
          rebuilt.replacementProfile.profile,
          {},
        ).configurationEnvironment.NEMOCLAW_INFERENCE_BASE_URL.replace(/\/+$/, ""),
      ).toBe(expectedEndpoint);
      expect(
        mapManagedStartupProfileToAgentEnvironment(
          recovered.profile,
          {},
        ).configurationEnvironment.NEMOCLAW_INFERENCE_BASE_URL.replace(/\/+$/, ""),
      ).toBe(expectedEndpoint);
    },
  );

  it("refuses a candidate rebuild without qualification authority (#7927)", async () => {
    delete process.env.NEMOCLAW_CANDIDATE_AGENTS;
    delete process.env.NEMOCLAW_CANDIDATE_QUALIFICATION_RECEIPT;

    await expect(
      prepareManagedWorkloadRebuildHandoff(piEntry(), {
        runtime: runtimeCapabilities(),
        provider: provider(),
        version: "0.0.100",
      }),
    ).rejects.toThrow(ManagedWorkloadRebuildError);
  });

  it("refuses a candidate rebuild from a receipt the repository never published (#7927)", async () => {
    writeReceipt();

    await expect(
      prepareManagedWorkloadRebuildHandoff(piEntry(), {
        runtime: runtimeCapabilities(),
        provider: provider(),
        version: "0.0.100",
      }),
    ).rejects.toThrow("qualification receipt is unavailable or invalid");
  });
});
