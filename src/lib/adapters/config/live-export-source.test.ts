// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";
import { runConfigExport } from "../../actions/config/export";
import {
  EXPORTED_OLLAMA_MODEL,
  parseNemoClawConfigDocumentName,
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_RECIPE_ID,
  type ImmutableImageReference,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { validateNemoClawConfig } from "../../config/schema";

vi.mock("../../inference/serving/vllm-export-runtime", () => ({
  observeManagedVllmForExport: vi.fn(),
}));
vi.mock("../../inference/ollama/proxy", () => ({ createOllamaExportProbe: vi.fn() }));
vi.mock("../../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform")>()),
  isWsl: vi.fn(() => false),
}));
vi.mock("../../state/registry/persistence", () => ({ load: vi.fn() }));
vi.mock("../../state/registry-entry-view", () => ({ getSandboxEntryInference: vi.fn() }));
vi.mock("../../inference/live", () => ({ getLiveGatewayInference: vi.fn() }));
vi.mock("../openshell/sdk", () => ({ connectManagedOpenShellSdk: vi.fn() }));
vi.mock("../openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshell: vi.fn(),
}));
vi.mock("../openshell/sandbox-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openshell/sandbox-config")>();
  return {
    ...actual,
    createSandboxConfig: () =>
      actual.createSandboxConfig(undefined, async (policy) => YAML.stringify(policy)),
  };
});
vi.mock("../../onboard/gateway/state-dir", () => ({
  managedGatewayStateRootOwnershipFailure: vi.fn(() => null),
  resolveGatewayStateDirForPort: vi.fn(() => "/managed/gateway"),
}));

import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import type { ObservedOllamaProxy } from "../../inference/ollama/proxy-observation";
import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../../inference/serving/profile-provenance";
import { applyVllmRuntimeContextWindow } from "../../inference/vllm-runtime-context";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import type { ObservedManagedVllmRuntime } from "../../domain/config/export-evidence";
import { getLiveGatewayInference } from "../../inference/live";
import { resolveGatewayStateDirForPort } from "../../onboard/gateway/state-dir";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import { connectManagedOpenShellSdk } from "../openshell/sdk";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { createLiveExportSnapshotReader } from "./live-export-source";
import {
  endpoint,
  readFailureCanary,
  imageRef,
  startupInput,
  entry,
  inventory,
  provider,
  configuration,
  openAiProviderProfile,
  nativeNvidiaProvider,
  ollamaSource,
  telemetryEntry,
  dashboardSource,
} from "./live-export-source-test-fixture";

const raw = {
  getProvider: vi.fn(),
  getProviderProfile: vi.fn(),
  getSandbox: vi.fn(),
  getSandboxConfig: vi.fn(),
};
function mockSupportedLiveSource(
  policyVersion = 3,
  appliedRevision = 3,
  sourceEntry: SandboxEntry = entry,
): void {
  vi.mocked(loadRegistry).mockReturnValue({
    sandboxes: { alpha: sourceEntry },
    defaultSandbox: null,
  });
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "nvidia-prod",
    model: "model-a",
  });
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "nvidia-prod", model: "model-a" },
    output: "",
    status: 0,
  });
  vi.mocked(connectManagedOpenShellSdk).mockResolvedValue({ raw });
  raw.getProvider.mockResolvedValue(provider());
  raw.getSandbox.mockResolvedValue(inventory(7, policyVersion));
  raw.getSandboxConfig.mockResolvedValue(configuration(appliedRevision));
}

function braveProvider() {
  const readCredential = vi.fn(() => {
    throw new Error(readFailureCanary);
  });
  const credentials = Object.defineProperty({}, "BRAVE_API_KEY", {
    enumerable: true,
    get: readCredential,
  });
  return {
    readCredential,
    provider: {
      metadata: {
        id: "brave-id",
        name: "alpha-brave-search",
        workspace: "default",
        resourceVersion: 9n,
      },
      type: "brave",
      profileWorkspace: "default",
      credentials,
      config: {},
    },
  };
}

function mockBraveLiveSource() {
  const built = buildManagedStartupProfile({
    ...startupInput,
    webSearch: { fetchEnabled: true, provider: "brave" },
  });
  mockSupportedLiveSource(3, 3, {
    ...entry,
    webSearchEnabled: true,
    webSearchProvider: "brave",
    workload: {
      ...(entry.workload as Extract<
        NonNullable<SandboxEntry["workload"]>,
        { kind: "managed-image" }
      >),
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    },
  });
  const search = braveProvider();
  raw.getProviderProfile.mockResolvedValue({ profile: managedBraveProfile() });
  raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
    name === "alpha-brave-search" ? { provider: search.provider } : provider(),
  );
  raw.getSandbox.mockResolvedValue({
    sandbox: {
      ...inventory().sandbox,
      spec: { template: { image: imageRef }, providers: ["alpha-brave-search"] },
    },
  });
  return search;
}

async function exportLiveSource() {
  const writeStdout = vi.fn(async (_yaml: string) => {});
  const publish = vi.fn();
  const result = await runConfigExport(
    {
      sandboxName: "alpha",
      documentName: parseNemoClawConfigDocumentName("alpha"),
      target: { kind: "stdout" },
    },
    {
      observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
      createDocumentUid: () =>
        parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
      writeStdout,
      publish,
    },
  );
  return { result, writeStdout, publish };
}

function expectExportRefusal(
  exported: Awaited<ReturnType<typeof exportLiveSource>>,
  finding: Readonly<{ field?: string; category: string }>,
) {
  expect(exported.result).toMatchObject({
    ok: false,
    failure: {
      kind: "observation",
      findings: expect.arrayContaining([expect.objectContaining(finding)]),
    },
  });
  expect(exported.writeStdout).not.toHaveBeenCalled();
  expect(exported.publish).not.toHaveBeenCalled();
}
function mockNativeNvidiaSource() {
  mockSupportedLiveSource();
  raw.getProvider.mockResolvedValue({ provider: nativeNvidiaProvider() });
  raw.getProviderProfile.mockResolvedValue({
    profile: {
      id: "nvidia",
      source: "builtin",
      scope: "",
      resourceVersion: 0n,
      inferenceCapable: true,
      endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }],
    },
  });
}

describe("live export snapshot reader", () => {
  it("exports Brave through SDK metadata without reading its credential value (#10904)", async () => {
    const search = mockBraveLiveSource();
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]!.integrations?.webSearch).toEqual({
      provider: "brave",
      agentRefs: ["primary"],
      credential: { env: "BRAVE_API_KEY" },
    });
    expect(document.spec.inferenceProviders).toHaveLength(1);
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(yaml).not.toContain(readFailureCanary);
    expect(raw.getProvider.mock.calls.map(([request]) => request.name)).toEqual([
      "nvidia-prod",
      "alpha-brave-search",
      "nvidia-prod",
      "alpha-brave-search",
    ]);
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(2);
    expect(raw.getProviderProfile).toHaveBeenCalledWith(
      { id: "brave", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { type: "generic" },
    { profileWorkspace: undefined },
    { profileWorkspace: "foreign" },
    { credentials: { OTHER_API_KEY: readFailureCanary } },
    { config: { BASE_URL: readFailureCanary } },
  ])("rejects unsupported Brave provider metadata without output %j (#10904)", async (change) => {
    const search = mockBraveLiveSource();
    raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
      name === "alpha-brave-search" ? { provider: { ...search.provider, ...change } } : provider(),
    );
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("sanitizes a failed Brave metadata read before publication (#10904)", async () => {
    mockBraveLiveSource();
    raw.getProvider
      .mockResolvedValueOnce(provider())
      .mockRejectedValueOnce(new Error(readFailureCanary));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { source: "interceptor/foreign" },
    { source: "user", scope: "platform" },
    { resourceVersion: 0n },
    { endpoints: [] },
    { binaries: [] },
    { credentials: [] },
  ])("rejects a shadowed or changed Brave profile %# (#10904)", async (change) => {
    const search = mockBraveLiveSource();
    raw.getProviderProfile.mockResolvedValue({ profile: { ...managedBraveProfile(), ...change } });
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it("sanitizes a failed Brave profile read before publication (#10904)", async () => {
    const search = mockBraveLiveSource();
    raw.getProviderProfile.mockRejectedValue(new Error(readFailureCanary));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it("rejects a changing managed Brave profile revision without output (#10904)", async () => {
    const search = mockBraveLiveSource();
    let revision = 10n;
    raw.getProviderProfile.mockImplementation(async () => ({
      profile: { ...managedBraveProfile(), resourceVersion: revision++ },
    }));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
    });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it.each(["id", "resourceVersion"])(
    "rejects changing Brave provider %s without output (#10904)",
    async (field) => {
      const search = mockBraveLiveSource();
      let revision = 10;
      raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
        name === "alpha-brave-search"
          ? {
              provider: {
                ...search.provider,
                metadata: {
                  ...search.provider.metadata,
                  [field]: field === "id" ? `provider-${revision++}` : BigInt(revision++),
                },
              },
            }
          : provider(),
      );
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toMatchObject({
        ok: false,
        failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
      });
      expect(writeStdout).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(search.readCredential).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      stage: "registry",
      fail: () =>
        vi.mocked(loadRegistry).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "gateway-binding",
      fail: () =>
        vi.mocked(resolveGatewayStateDirForPort).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "sandbox-inventory",
      fail: () =>
        raw.getSandbox.mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "sandbox-identity",
      fail: () =>
        raw.getSandbox.mockResolvedValueOnce({
          sandbox: {
            ...inventory().sandbox,
            metadata: { ...inventory().sandbox.metadata, id: "invalid id" },
          },
        }),
    },
    {
      stage: "inference-route",
      fail: () =>
        vi.mocked(getLiveGatewayInference).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "provider-metadata",
      fail: () =>
        raw.getProvider.mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "effective-policy",
      fail: () =>
        raw.getSandboxConfig.mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
  ] as const)("tags a sanitized $stage read failure", async ({ stage, fail }) => {
    mockSupportedLiveSource();
    fail();

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("does not fall back to the selected gateway after an inference read failure", async () => {
    mockSupportedLiveSource();
    const actual =
      await vi.importActual<typeof import("../../inference/live")>("../../inference/live");
    vi.mocked(getLiveGatewayInference).mockImplementationOnce(actual.getLiveGatewayInference);
    vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
      status: 1,
      output: "unreachable",
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "inference-route",
    });
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSanitizedResolvedOpenshell).mock.calls[0]?.[0]).toContain("nemoclaw");
    expect(raw.getProvider).not.toHaveBeenCalled();
  });

  it("retains direct tool selection through the live reader and stable verifier", async () => {
    const profile = {
      ...startup.profile,
      tools: { ...startup.profile.tools, disclosure: "direct" as const },
    };
    const encodedProfile = encodeManagedStartupProfile(profile);
    mockSupportedLiveSource(3, 3, {
      ...entry,
      toolDisclosure: "direct",
      workload: {
        ...entry.workload,
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      },
    });
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({ ok: true, source: { tools: { disclosure: "direct" } } });
    expect(raw.getSandbox).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("returns a complete non-secret raw snapshot", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", readFailureCanary);
    mockSupportedLiveSource();
    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "7", policyVersion: 3 },
      inference: {
        topology: "hosted",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        provider: "nvidia-prod",
        model: "model-a",
        endpointEvidence: {
          endpoint,
          provider: {
            id: "provider-id",
            resourceVersion: "8",
            workspace: "default",
          },
          source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
        },
      },
    });
    expect(result).not.toHaveProperty("registry.createdAt");
    expect(result).not.toHaveProperty("inference.credential");
    expect(captureSanitizedResolvedOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("preserves live revision fields for structural stability checks", async () => {
    mockSupportedLiveSource();
    const reader = createLiveExportSnapshotReader();
    const first = await reader.read("alpha");
    raw.getSandbox.mockResolvedValue(inventory(8, 4));
    raw.getSandboxConfig.mockResolvedValue(configuration(4));

    const second = await reader.read("alpha");

    expect(first).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "7", policyVersion: 3 },
      policy: { revision: "3" },
    });
    expect(second).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "8", policyVersion: 4 },
      policy: { revision: "4" },
    });
  });

  it("sanitizes credential-bearing policy failures", async () => {
    mockSupportedLiveSource();
    const canary = "credential-canary-value";
    raw.getSandboxConfig.mockResolvedValue({
      ...configuration(),
      policy: { ...configuration().policy, env: { TOKEN: canary } },
    });

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage: "effective-policy" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("maps inconsistent provider metadata to a controlled read failure", async () => {
    mockSupportedLiveSource();
    raw.getProvider.mockResolvedValue({
      provider: {
        ...provider().provider,
        credentials: { OTHER_API_KEY: readFailureCanary },
      },
    });

    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "provider-metadata",
    });
  });

  it.each([0, 3])(
    "preserves global policy revision agreement for revision %i",
    async (globalPolicyVersion) => {
      mockSupportedLiveSource();
      raw.getSandboxConfig.mockResolvedValue({
        ...configuration(),
        policySource: 2,
        globalPolicyVersion,
      });
      const result = await createLiveExportSnapshotReader().read("alpha");
      expect(result).toMatchObject({
        kind: "observed",
        policy: { revision: "3" },
        configuration: { policySource: "global", globalPolicyVersion },
      });
    },
  );

  it("rejects a global policy revision that differs from the sandbox revision", async () => {
    mockSupportedLiveSource();
    raw.getSandboxConfig.mockResolvedValue({
      ...configuration(),
      policySource: 2,
      globalPolicyVersion: 4,
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "effective-policy",
    });
  });

  it("maps route and policy revision drift to controlled read failures", async () => {
    mockSupportedLiveSource(4, 3);
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "effective-policy",
    });

    mockSupportedLiveSource();
    vi.mocked(getLiveGatewayInference).mockReturnValue({
      failure: null,
      inference: { provider: "nvidia-prod", model: "model-b" },
      output: "",
      status: 0,
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "inference-route",
    });
  });

  it("exports canonical YAML for the native NVIDIA hosted provider (#11154)", async () => {
    mockNativeNvidiaSource();
    const writeStdout = vi.fn(async (_yaml: string) => {});
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: () =>
          parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
        writeStdout,
        publish,
      },
    );
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "hosted-nvidia-prod",
        provider: "nvidia-prod",
        api: "openai-completions",
        endpoint,
        credential: { env: "NVIDIA_INFERENCE_API_KEY" },
      },
    ]);
    expect(document.spec.sandboxes[0].agents[0].type).toBe("openclaw");
    expect(yaml).not.toContain(readFailureCanary);
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { label: "endpoint override", providerChange: { config: { NVIDIA_BASE_URL: endpoint } } },
    {
      label: "credential mismatch",
      providerChange: { credentials: { OTHER_API_KEY: readFailureCanary } },
    },
    { label: "missing credentials", providerChange: { credentials: {} } },
    { label: "unverified profile scope", providerChange: { profileWorkspace: "default" } },
  ])("rejects native NVIDIA $label without publishing YAML", async ({ providerChange }) => {
    mockNativeNvidiaSource();
    raw.getProvider.mockResolvedValue({
      provider: { ...nativeNvidiaProvider(), ...providerChange },
    });
    const writeStdout = vi.fn();
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: vi.fn(),
        writeStdout,
        publish,
      },
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("rejects NVIDIA endpoint drift between the registry and builtin profile", async () => {
    mockNativeNvidiaSource();
    vi.mocked(loadRegistry).mockReturnValue({
      sandboxes: { alpha: { ...entry, endpointUrl: "https://different.example/v1" } },
      defaultSandbox: null,
    });
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({
          field: "spec.inferenceProviders[].endpoint",
          category: "drifted",
        }),
      ]),
    });
  });

  it("rejects a native NVIDIA provider that changes during both observations", async () => {
    mockNativeNvidiaSource();
    let revision = 0;
    raw.getProvider.mockImplementation(async () => ({
      provider: {
        ...nativeNvidiaProvider(),
        metadata: { ...provider().provider.metadata, resourceVersion: BigInt(++revision) },
      },
    }));
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(4);
  });

  it.each([
    { sampleRate: 0, serviceName: "s", collectorAllowed: true },
    { sampleRate: 0.5, serviceName: "research-assistant", collectorAllowed: true },
    { sampleRate: 1, serviceName: "s".repeat(256), collectorAllowed: true },
    { sampleRate: 0.5, serviceName: "research assistant", collectorAllowed: false },
  ])(
    "exports retained OTLP settings at sample $sampleRate without changing policy",
    async ({ sampleRate, serviceName, collectorAllowed }) => {
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL", "0");
      vi.stubEnv(
        "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
        "https://ignored.example/credential-canary-value",
      );
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME", "ignored-service");
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE", "0.9");
      mockSupportedLiveSource(3, 3, telemetryEntry({ sampleRate, serviceName }));
      const effective = configuration();
      const policy = {
        ...effective.policy,
        network_policies: {
          ...effective.policy.network_policies,
          ...(collectorAllowed
            ? {
                collector: {
                  name: "collector",
                  endpoints: [
                    {
                      host: "host.openshell.internal",
                      port: 4318,
                      protocol: "rest",
                      enforcement: "enforce",
                      allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
                      rules: [{ allow: { method: "POST", path: "/v1/traces" } }],
                    },
                  ],
                  binaries: [{ path: "/usr/local/bin/node" }],
                },
              }
            : {}),
        },
      };
      raw.getSandboxConfig.mockResolvedValue({ ...effective, policy });
      const writeStdout = vi.fn(async (_yaml: string) => {});
      const publish = vi.fn();

      const result = await runConfigExport(
        {
          sandboxName: "alpha",
          documentName: parseNemoClawConfigDocumentName("alpha"),
          target: { kind: "stdout" },
        },
        {
          observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
          createDocumentUid: () =>
            parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
          writeStdout,
          publish,
        },
      );

      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const yaml = writeStdout.mock.calls[0]?.[0] ?? "";
      const document = validateNemoClawConfig(YAML.parse(yaml));
      expect(document.spec.sandboxes[0]?.agents[0]).toMatchObject({
        type: "openclaw",
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName,
            sampleRate,
          },
        },
      });
      expect(document.spec.sandboxes[0]?.network.policy.explicit).toEqual(policy);
      expect(yaml).not.toContain(readFailureCanary);
      expect(yaml).not.toContain("NEMOCLAW_OPENCLAW_OTEL");
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "credential-bearing endpoint",
      telemetry: {
        endpointUrl: "http://user:credential-canary-value@host.openshell.internal:4318",
      },
    },
    {
      label: "collector query",
      telemetry: {
        endpointUrl: "http://host.openshell.internal:4318?token=credential-canary-value",
      },
    },
    {
      label: "remote collector",
      telemetry: { endpointUrl: "https://collector.example/v1/traces" },
    },
    { label: "invalid service", telemetry: { serviceName: "service\n" } },
    { label: "Unicode service", telemetry: { serviceName: "équipe" } },
    { label: "oversized service", telemetry: { serviceName: "s".repeat(257) } },
    { label: "out-of-range sample", telemetry: { sampleRate: 1.1 } },
    { label: "disabled nondefault settings", telemetry: { enabled: false } },
    { label: "invalid agent timeout", settings: { agentTimeoutSeconds: 1000000001 } },
    { label: "conflicting agent", registry: { agent: "hermes" } },
    { label: "DCode observability marker", registry: { observabilityEnabled: true } },
    {
      label: "stale workload",
      registry: {
        workload: { ...telemetryEntry().workload, startupProfileSha256: "c".repeat(64) },
      },
    },
    { label: "missing workload", registry: { workload: undefined } },
  ])("rejects telemetry $label before any output", async ({ telemetry, settings, registry }) => {
    mockSupportedLiveSource(3, 3, { ...telemetryEntry(telemetry, settings), ...registry });
    const writeStdout = vi.fn();
    const publish = vi.fn();

    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "file", outputPath: "/tmp/alpha.yaml", force: false },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: vi.fn(),
        writeStdout,
        publish,
      },
    );

    expect(result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("does not publish telemetry that changes during both observation pairs", async () => {
    mockSupportedLiveSource();
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: telemetryEntry({ sampleRate: reads++ % 2 === 0 ? 0.5 : 1 }) },
      defaultSandbox: null,
    }));
    const writeStdout = vi.fn();
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: vi.fn(),
        writeStdout,
        publish,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "observation", attempts: 2, findings: [{ category: "unstable-source" }] },
    });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("exports a stable SDK endpoint with verified policy and workload evidence", async () => {
    mockSupportedLiveSource();
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      source: {
        inference: { endpoint },
        runtime: { imageRef },
        sandboxName: "alpha",
      },
    });
    expect(raw.getProvider).toHaveBeenCalledTimes(2);
    expect(raw.getSandboxConfig).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("exports a secondary agent through SDK observations without copying provider credentials (#11434)", async () => {
    const built = buildManagedStartupProfile({
      ...startupInput,
      environment: {
        NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify([
          { id: "reviewer-2", tools: { allow: ["read"] } },
        ]),
      },
    });
    mockSupportedLiveSource(3, 3, {
      ...entry,
      workload: {
        ...entry.workload,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
      },
    });
    const { result, writeStdout } = await exportLiveSource();
    expect(result.ok).toBe(true);
    const yaml = writeStdout.mock.calls[0]![0];
    const config = validateNemoClawConfig(YAML.parse(yaml));
    const [primary, secondary] = config.spec.sandboxes[0]!.agents;
    expect(primary!.name).toBe("primary");
    expect(secondary).toEqual({
      name: "reviewer-2",
      type: "openclaw",
      tools: { allow: ["read"] },
      inference: primary!.inference,
    });
    expect(config.spec.inferenceProviders).toHaveLength(1);
    expect(yaml).not.toContain(readFailureCanary);
    expect(raw.getSandboxConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "endpoint",
      change: () =>
        raw.getProvider.mockResolvedValue({
          provider: {
            ...provider().provider,
            config: { OPENAI_BASE_URL: "https://different.example/v1" },
          },
        }),
      category: "drifted",
    },
    {
      label: "image",
      change: () =>
        raw.getSandbox.mockResolvedValue({
          sandbox: {
            ...inventory().sandbox,
            spec: { template: { image: imageRef.replace("aaaa", "bbbb") }, providers: [] },
          },
        }),
      category: "drifted",
    },
    {
      label: "provider attachments",
      change: () =>
        raw.getSandbox.mockResolvedValue({
          sandbox: {
            ...inventory().sandbox,
            spec: { template: { image: imageRef }, providers: ["extra"] },
          },
        }),
      category: "unsupported",
    },
  ])("rejects live $label drift", async ({ change, category }) => {
    mockSupportedLiveSource();
    change();
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining({ category })]),
    });
  });

  it("detects repeated provider revision changes", async () => {
    mockSupportedLiveSource();
    let revision = 20n;
    raw.getProvider.mockImplementation(async () => ({
      provider: {
        ...provider().provider,
        metadata: { ...provider().provider.metadata, resourceVersion: revision++ },
      },
    }));
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
  });

  it.each(["configRevision", "providerEnvRevision"])(
    "detects repeated %s changes",
    async (field) => {
      mockSupportedLiveSource();
      let revision = 20n;
      raw.getSandboxConfig.mockImplementation(async () => ({
        ...configuration(),
        [field]: revision++,
      }));
      const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
      expect(result).toMatchObject({
        ok: false,
        attempts: 2,
        findings: [expect.objectContaining({ category: "unstable-source" })],
      });
    },
  );

  it("does not expose concrete reader exceptions", async () => {
    const canary = "credential-canary-value";
    vi.mocked(loadRegistry).mockImplementation(() => {
      throw new Error(canary);
    });

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage: "registry" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

function mockManagedVllmSource(
  environmentOverrides: NodeJS.ProcessEnv = {},
  webSearch: ManagedStartupProfileBuilderInput["webSearch"] = null,
  toolDisclosure: ManagedStartupProfileBuilderInput["toolDisclosure"] = "progressive",
) {
  const catalog = loadServingCatalog();
  const provenance = servingProfileProvenance(catalog, EXPORTED_VLLM_PROFILE_ID);
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === EXPORTED_VLLM_RECIPE_ID)!;
  const model = recipe.spec.model.servedName!;
  const runtimeImage = provenance.runtimeImage as ImmutableImageReference;
  const inference = resolveManagedStartupInferenceRoute(
    "openclaw",
    "vllm-local",
    model,
    "openai-completions",
  );
  const environment: NodeJS.ProcessEnv = {};
  // This is the actual onboarding projection of the fixed server's /v1/models response.
  applyVllmRuntimeContextWindow({ data: [{ id: model, max_model_len: 65536 }] }, model, {
    env: environment,
    logger: { log: vi.fn(), warn: vi.fn() },
  });
  Object.assign(environment, environmentOverrides);
  const built = buildManagedStartupProfile({
    ...startupInput,
    inference: {
      routeProvider: inference.providerKey,
      upstreamProvider: "vllm-local",
      model,
      routedBaseUrl: inference.inferenceBaseUrl,
      upstreamEndpointUrl: null,
      api: "openai-completions",
      primaryModelRef: inference.primaryModelRef,
      compatibility: inference.inferenceCompat ?? {},
    },
    webSearch,
    toolDisclosure,
    environment,
  });
  const source: SandboxEntry = {
    ...entry,
    provider: "vllm-local",
    model,
    endpointUrl: "http://host.openshell.internal:18000/v1",
    credentialEnv: null,
    servingProfileProvenance: provenance,
    toolDisclosure,
    webSearchEnabled: webSearch !== null,
    webSearchProvider: webSearch?.provider ?? null,
    workload: {
      ...entry.workload!,
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    } as SandboxEntry["workload"],
  };
  const observed: ObservedManagedVllmRuntime = {
    containerId: "a".repeat(64),
    imageId: `sha256:${"b".repeat(64)}`,
    networkId: "c".repeat(64),
    startedAt: "2026-09-10T12:00:00Z",
    serving: {
      backend: "vllm",
      catalogDigest: provenance.catalogDigest,
      profile: { id: EXPORTED_VLLM_PROFILE_ID, digest: provenance.preset.digest },
      recipe: { id: EXPORTED_VLLM_RECIPE_ID, digest: provenance.recipe.digest },
      model: { ...provenance.model, servedName: model },
      runtime: { image: { ref: runtimeImage } },
      hostPort: 18000,
    },
  };
  mockSupportedLiveSource(3, 3, source);
  vi.mocked(observeManagedVllmForExport).mockReturnValue(observed);
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "vllm-local",
    model,
  });
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "vllm-local", model },
    output: "",
    status: 0,
  });
  const liveSandbox = inventory();
  Object.assign(liveSandbox.sandbox.spec, { providers: ["vllm-local"] });
  raw.getSandbox.mockResolvedValue(liveSandbox);
  const credentials = { NEMOCLAW_VLLM_LOCAL_TOKEN: readFailureCanary };
  raw.getProvider.mockResolvedValue({
    provider: {
      metadata: {
        id: "provider-id",
        name: "vllm-local",
        workspace: "default",
        resourceVersion: 8n,
      },
      type: "openai",
      profileWorkspace: "default",
      credentials,
      config: { OPENAI_BASE_URL: source.endpointUrl },
    },
  });
  raw.getProviderProfile.mockResolvedValue(openAiProviderProfile());
  return { source, observed };
}

describe("managed vLLM export pipeline", () => {
  it("exports the real fixed onboarding profile and reparses its managed provider", async () => {
    const f = mockManagedVllmSource();
    const output = vi.fn(async (_value: string) => {});
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: () =>
          parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174000"),
        publish,
        writeStdout: output,
      },
    );
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = output.mock.calls[0]![0];
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "managed-vllm",
        provider: "vllm-local",
        api: "openai-completions",
        serving: f.observed.serving,
      },
    ]);
    expect(document.spec.sandboxes[0]!.agents[0]!.inference.routes[0]!.overrides).toEqual({
      model: f.source.model,
      contextWindow: 65536,
    });
    expect(yaml).not.toContain(readFailureCanary);
    expect(yaml).not.toContain("NEMOCLAW_VLLM_LOCAL_TOKEN");
    expect(yaml).not.toContain("host.openshell.internal");
    expect(publish).not.toHaveBeenCalled();
  });

  it("exports direct tools, managed vLLM, Brave and retained OTLP with qualified profile bindings", async () => {
    const f = mockManagedVllmSource(
      {
        NEMOCLAW_OPENCLAW_OTEL: "1",
        NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
        NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "research-assistant",
        NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
      },
      { fetchEnabled: true, provider: "brave" },
      "direct",
    );
    const search = braveProvider();
    const readManagedProvider = raw.getProvider.getMockImplementation()!;
    const readManagedProfile = raw.getProviderProfile.getMockImplementation()!;
    raw.getProvider.mockImplementation(async (request: { name: string }) =>
      request.name === "alpha-brave-search"
        ? { provider: search.provider }
        : readManagedProvider(request),
    );
    raw.getProviderProfile.mockImplementation(async (request: { id: string }) =>
      request.id === "brave" ? { profile: managedBraveProfile() } : readManagedProfile(request),
    );
    const liveSandbox = inventory();
    Object.assign(liveSandbox.sandbox.spec, { providers: ["vllm-local", "alpha-brave-search"] });
    raw.getSandbox.mockResolvedValue(liveSandbox);
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    expect(yaml).not.toContain(readFailureCanary);
    expect(yaml).not.toContain("NEMOCLAW_VLLM_LOCAL_TOKEN");
    expect(yaml).not.toContain("host.openshell.internal:18000");
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "managed-vllm",
        provider: "vllm-local",
        api: "openai-completions",
        serving: f.observed.serving,
      },
    ]);
    expect(document.spec.sandboxes[0]!.agents).toEqual([
      {
        name: "primary",
        type: "openclaw",
        tools: { disclosure: "direct" },
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName: "research-assistant",
            sampleRate: 0.5,
          },
        },
        inference: {
          routes: [
            {
              name: "primary",
              providerRef: "managed-vllm",
              overrides: { model: f.source.model, contextWindow: 65536 },
            },
          ],
        },
      },
    ]);
    expect(document.spec.sandboxes[0]!.network.policy.explicit).toEqual(configuration().policy);
    expect(document.spec.sandboxes[0]!.integrations?.webSearch).toEqual({
      provider: "brave",
      agentRefs: ["primary"],
      credential: { env: "BRAVE_API_KEY" },
    });
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["NEMOCLAW_MAX_TOKENS", "NEMOCLAW_AGENT_TIMEOUT"])(
    "rejects unrepresented %s instead of losing it",
    async (field) => {
      mockManagedVllmSource({ [field]: "8192" });
      const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
      expect(result).toMatchObject({
        ok: false,
        findings: expect.arrayContaining([
          expect.objectContaining({
            category: "unsupported",
            field: "source.workload.startupProfile",
          }),
        ]),
      });
    },
  );

  it("rejects a changed managed route and keeps publication unreachable", async () => {
    const f = mockManagedVllmSource();
    vi.mocked(observeManagedVllmForExport).mockReturnValue({
      ...f.observed,
      serving: { ...f.observed.serving, hostPort: 19000 },
    });
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ field: "spec.inferenceProviders[].serving" }),
      ]),
    });
  });

  it("detects managed container restart between complete snapshots", async () => {
    const f = mockManagedVllmSource();
    let revision = 0;
    vi.mocked(observeManagedVllmForExport).mockImplementation(() => ({
      ...f.observed,
      startedAt: String(revision++),
    }));
    expect(
      await observeStableExportSource("alpha", createLiveExportSnapshotReader()),
    ).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
  });

  it("rejects a shadowed OpenAI profile with additional endpoint behavior", async () => {
    mockManagedVllmSource();
    raw.getProviderProfile.mockResolvedValue({
      profile: {
        id: "openai",
        source: "user",
        scope: "workspace",
        resourceVersion: 4n,
        credentials: [],
        endpoints: [{ host: "unexpected.example", port: 443 }],
        binaries: [],
        inferenceCapable: true,
      },
    });
    expect(await createLiveExportSnapshotReader().read("alpha")).toEqual({
      kind: "read-failed",
      stage: "provider-metadata",
    });
  });

  it("detects resolved provider profile revision changes", async () => {
    mockManagedVllmSource();
    let revision = 4n;
    raw.getProviderProfile.mockImplementation(async () => ({
      profile: {
        id: "openai",
        source: "user",
        scope: "workspace",
        resourceVersion: revision++,
        credentials: [],
        endpoints: [],
        binaries: [],
        inferenceCapable: true,
      },
    }));
    expect(
      await observeStableExportSource("alpha", createLiveExportSnapshotReader()),
    ).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
  });

  it("contains runtime failures before provider metadata or publication", async () => {
    mockManagedVllmSource();
    vi.mocked(observeManagedVllmForExport).mockImplementation(() => {
      throw new Error(readFailureCanary);
    });
    expect(await createLiveExportSnapshotReader().read("alpha")).toEqual({
      kind: "read-failed",
      stage: "managed-serving",
    });
    expect(raw.getProvider).not.toHaveBeenCalled();
  });
});

function ollamaProbe(observed: ObservedOllamaProxy) {
  const models = JSON.stringify({
    models: [{ name: observed.serving.model.servedName, digest: observed.serving.model.digest }],
  });
  return {
    backend: {
      kind: "ollama" as const,
      url: `http://127.0.0.1:${observed.serving.daemon.hostPort}`,
    },
    proxyPort: String(observed.serving.proxy.hostPort),
    pid: String(observed.pid),
    processMatches: vi.fn(() => true),
    readActiveConfig: vi.fn(() =>
      JSON.stringify({
        schemaVersion: 1,
        pid: observed.pid,
        listener: { address: observed.listenerAddress, port: observed.serving.proxy.hostPort },
        backendOrigin: `http://127.0.0.1:${observed.serving.daemon.hostPort}`,
      }),
    ),
    readProxyModels: vi.fn(() => models),
    readDaemonModels: vi.fn(() => models),
  };
}

function mockOllamaSource() {
  vi.spyOn(os, "platform").mockReturnValue("linux");
  const model = EXPORTED_OLLAMA_MODEL;
  const { source, observed } = ollamaSource(model);
  mockSupportedLiveSource(3, 3, source);
  const probe = ollamaProbe(observed);
  vi.mocked(createOllamaExportProbe).mockReturnValue(probe);
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "ollama-local",
    model,
  });
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "ollama-local", model },
    output: "",
    status: 0,
  });
  const liveSandbox = inventory();
  Object.assign(liveSandbox.sandbox.spec, { providers: ["ollama-local"] });
  raw.getSandbox.mockResolvedValue(liveSandbox);
  const readCredential = vi.fn(() => {
    throw new Error(readFailureCanary);
  });
  const credentials = Object.defineProperty({}, OLLAMA_LOCAL_CREDENTIAL_ENV, {
    enumerable: true,
    get: readCredential,
  });
  const localProvider = {
    ...provider().provider,
    metadata: { ...provider().provider.metadata, name: "ollama-local" },
    profileWorkspace: "default",
    credentials,
    config: { OPENAI_BASE_URL: source.endpointUrl },
  };
  raw.getProvider.mockResolvedValue({ provider: localProvider });
  raw.getProviderProfile.mockResolvedValue(openAiProviderProfile());
  return { source, observed, probe, readCredential, localProvider };
}

describe("attached Ollama export pipeline", () => {
  it("publishes the complete managed document without reading gateway credentials (#11435)", async () => {
    const { observed, probe, readCredential } = mockOllamaSource();
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "local-ollama",
        provider: "ollama-local",
        api: "openai-completions",
        serving: observed.serving,
      },
    ]);
    expect(document.spec.sandboxes[0]!.agents[0]!.inference.routes).toEqual([
      { name: "primary", providerRef: "local-ollama", overrides: { model: EXPORTED_OLLAMA_MODEL } },
    ]);
    expect(probe.readActiveConfig).toHaveBeenCalledWith(11440);
    expect(probe.readDaemonModels).toHaveBeenCalledWith(11439);
    expect(readCredential).not.toHaveBeenCalled();
    expect(yaml).not.toMatch(
      /NEMOCLAW_OLLAMA_PROXY_TOKEN|credential-canary-value|host\.openshell\.internal/u,
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("sanitizes a failed or legacy proxy observation and publishes nothing (#11435)", async () => {
    mockOllamaSource();
    vi.mocked(createOllamaExportProbe).mockImplementation(() => {
      throw new Error(readFailureCanary);
    });
    const { result, writeStdout } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it.each([
    [
      { endpointUrl: "http://host.openshell.internal:11435/v1" },
      { field: "spec.inferenceProviders[].endpoint", category: "drifted" },
    ],
    [
      { credentialEnv: "OTHER_TOKEN" },
      { field: "source.live", category: "live-verification-failed" },
    ],
    [{ agent: "hermes" }, { field: "spec.inferenceProviders[].serving", category: "drifted" }],
    [
      { sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=all" },
      { field: "spec.sandboxes[].runtime.gpu", category: "unsupported" },
    ],
  ])("refuses unsupported or drifted local route intent %# (#11435)", async (change, finding) => {
    const { source } = mockOllamaSource();
    Object.assign(source, change);
    expectExportRefusal(await exportLiveSource(), finding);
  });
  it("refuses an absent provider attachment (#11435)", async () => {
    mockOllamaSource();
    raw.getSandbox.mockResolvedValue(inventory());
    expectExportRefusal(await exportLiveSource(), {
      field: "spec.inferenceProviders[].serving",
      category: "drifted",
    });
  });
  it("refuses a continuously changing active proxy identity (#11435)", async () => {
    const { observed } = mockOllamaSource();
    let pid = observed.pid;
    vi.mocked(createOllamaExportProbe).mockImplementation(() =>
      ollamaProbe({ ...observed, pid: ++pid }),
    );
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
  });
});
describe("dashboard export observation", () => {
  it("projects registered dashboard and direct tools through complete live observation (#10904)", async () => {
    const sourceEntry = dashboardSource();
    mockSupportedLiveSource(3, 3, sourceEntry);
    const reader = createLiveExportSnapshotReader();
    const observed = await reader.read("alpha");
    expect(observed).toMatchObject({
      kind: "observed",
      registry: {
        dashboardPort: 19000,
        dashboardRemoteBindPrepared: true,
        toolDisclosure: "direct",
      },
    });
    const writeStdout = vi.fn(async (_yaml: string) => {});
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, reader),
        createDocumentUid: () =>
          parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
        writeStdout,
        publish: vi.fn(),
      },
    );
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    const yaml = writeStdout.mock.calls[0]?.[0] ?? "";
    expect(yaml).not.toContain(readFailureCanary);
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]?.agents[0]).toMatchObject({
      type: "openclaw",
      interfaces: { dashboard: { port: 19000, bind: "0.0.0.0" } },
      tools: { disclosure: "direct" },
    });
  });

  it("refuses dashboard registry changes without publishing (#10904)", async () => {
    mockSupportedLiveSource();
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: { ...entry, dashboardPort: reads++ % 2 === 0 ? 18789 : 19000 } },
      defaultSandbox: null,
    }));
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "unstable-source" });
  });
});

describe("Hermes interface export observation", () => {
  it("reads only retained interface fields and includes allocation changes in stability (#11433)", async () => {
    mockSupportedLiveSource();
    const first = {
      ...entry,
      hermesApiPort: 8643,
      hermesDashboardEnabled: true,
      hermesDashboardPort: 19000,
      hermesDashboardInternalPort: 19120,
      hermesDashboardTui: true,
    };
    vi.mocked(loadRegistry).mockReturnValue({ sandboxes: { alpha: first }, defaultSandbox: null });
    const reader = createLiveExportSnapshotReader();
    expect(await reader.read("alpha")).toMatchObject({
      kind: "observed",
      registry: {
        hermesApiPort: 8643,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 19000,
        hermesDashboardInternalPort: 19120,
        hermesDashboardTui: true,
      },
    });
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: { ...first, hermesApiPort: reads++ % 2 === 0 ? 8643 : 8644 } },
      defaultSandbox: null,
    }));
    expect(await observeStableExportSource("alpha", reader)).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
    expect(reads).toBe(4);
  });
});
