// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { SandboxEntry } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
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
let installedRoot: string;

function contract(
  agent: ManagedImageAgent,
  digestByte: string,
  release: string,
  revision: string,
  cohort: `ghrun-${number}-${number}`,
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${digestByte.repeat(32)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: { repository: MANAGED_IMAGE_SOURCE_REPOSITORY, revision, release, cohort },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

const INSTALLED = contract("pi", "1b", "v0.0.99", "c".repeat(40), "ghrun-7927-2");
const RELEASE_CATALOG = Object.fromEntries(
  SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [
    agent,
    contract(agent, String(index + 2).repeat(2), "v0.0.100", "e".repeat(40), "ghrun-8818-1"),
  ]),
);

function piEntry(): SandboxEntry {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("pi"));
  return {
    name: "rebuild-pi",
    agent: "pi",
    openshellDriver: "docker",
    fromDockerfile: null,
    imageTag: INSTALLED.reference,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: INSTALLED.reference,
      platform: PLATFORM,
      release: INSTALLED.source.release,
      sourceRevision: INSTALLED.source.revision,
      sourceCohort: INSTALLED.source.cohort,
      capabilityContractVersion: INSTALLED.capabilityContractVersion,
      startupProfileContractVersion: INSTALLED.startupProfileContractVersion,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } as unknown as SandboxEntry;
}

function runtime(
  providerId: string,
  agents: readonly ManagedImageAgent[],
): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName: providerId,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: false,
    managedImages: {
      exactDigestReferences: true,
      platforms: [PLATFORM],
      agents,
      startupProfileContractVersions: [1],
      capabilityContractVersions: [1],
    },
  };
}

function provider(providerId: string, agents: readonly ManagedImageAgent[]): RuntimeProviderBundle {
  return {
    identity: { contractVersion: 1, id: providerId, displayName: providerId },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          agents,
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

describe("Pi managed rebuild", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_INSTALL_REF", "");
    installedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pi-rebuild-installed-"));
    fs.mkdirSync(path.join(installedRoot, "dist"));
    fs.writeFileSync(
      path.join(installedRoot, "dist", "build-identity.json"),
      JSON.stringify({ nemoclawVersion: "0.0.100", sourceRevision: "e".repeat(40) }),
    );
    fs.writeFileSync(path.join(installedRoot, ".version"), "0.0.100\n");
  });

  afterEach(() => {
    fs.rmSync(installedRoot, { force: true, recursive: true });
    vi.unstubAllEnvs();
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = ORIGINAL_PREPARE;
  });

  it("rebuilds Pi from the complete all-agent release catalog", async () => {
    const resolveCatalog = vi.fn(async () => RELEASE_CATALOG);
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = (input) =>
      ORIGINAL_PREPARE(input, { resolveCatalog });

    const handoff = await prepareManagedWorkloadRebuildHandoff(piEntry(), {
      runtime: runtime("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
      provider: provider("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
      rootDir: installedRoot,
      version: "0.0.100",
    });

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
      release: "v0.0.100",
      platform: PLATFORM,
    });
    expect(handoff).toMatchObject({
      agent: "pi",
      previousReceipt: { kind: "managed-image", release: "v0.0.99" },
      replacement: {
        release: "v0.0.100",
        source: { kind: "managed-image", reference: RELEASE_CATALOG.pi?.reference },
      },
    });
  });

  it("refuses a Pi rebuild before catalog resolution when the runtime does not qualify Pi", async () => {
    const qualified: readonly ManagedImageAgent[] = [
      "openclaw",
      "hermes",
      "langchain-deepagents-code",
    ];
    const resolveCatalog = vi.fn(async () => RELEASE_CATALOG);
    managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = (input) =>
      ORIGINAL_PREPARE(input, { resolveCatalog });

    await expect(
      prepareManagedWorkloadRebuildHandoff(piEntry(), {
        runtime: runtime("podman", qualified),
        provider: provider("podman", qualified),
        version: "0.0.100",
      }),
    ).rejects.toThrow(
      new ManagedWorkloadRebuildError(
        "Managed image workload is required for 'pi', but driver 'podman' is not qualified for that agent.",
      ),
    );
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ...HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.api === "openai-completions"),
    hostedNativeProvider("hermes-provider", "https://authenticated.nous.example/v1")!,
    { logicalProvider: "compatible-endpoint", endpoint: "https://custom.example/v1" },
    { logicalProvider: "ollama-local", endpoint: "http://localhost:11434/v1" },
  ])(
    "preserves Pi $logicalProvider routing through onboarding, rebuild and recovery",
    async (definition) => {
      const resolveCatalog = vi.fn(async () => RELEASE_CATALOG);
      managedWorkloadRebuildDependencies.prepareSandboxWorkloadSource = (input) =>
        ORIGINAL_PREPARE(input, { resolveCatalog });
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
      const onboardRuntime = createManagedWorkloadOnboardRuntime(
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
      const built = onboardRuntime.ensurePreparedProfile({
        source: { kind: "managed-image" },
      } as never)!;
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
          ...(built.corporateCaB64 === undefined ? {} : { corporateCaB64: built.corporateCaB64 }),
        },
      });
      const resume = prepareRebuildResumeConfig(entry.name, entry, "pi", vi.fn(), (message) => {
        throw new Error(message);
      })!;
      expect(resume.nativeHostedProviderAttachment).toEqual(attachment);
      const catalog = (await prepareManagedWorkloadRebuildHandoff(entry, {
        runtime: runtime("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
        provider: provider("docker", SHIPPED_MANAGED_IMAGE_AGENTS),
        rootDir: installedRoot,
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
        ...(rebuilt.replacementProfile.corporateCaB64 === undefined
          ? {}
          : { corporateCaB64: rebuilt.replacementProfile.corporateCaB64 }),
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
});
