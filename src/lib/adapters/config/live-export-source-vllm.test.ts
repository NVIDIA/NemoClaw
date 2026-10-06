// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { runConfigExport } from "../../actions/config/export";
import {
  parseNemoClawConfigDocumentName,
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_RECIPE_ID,
  type ImmutableImageReference,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../../inference/serving/profile-provenance";
import { applyVllmRuntimeContextWindow } from "../../inference/vllm-runtime-context";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import type { ObservedManagedVllmRuntime } from "../../domain/config/export-evidence";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { createLiveExportSnapshotReader } from "./live-export-source";
import {
  braveProvider,
  readFailureCanary,
  startupInput,
  entry,
  inventory,
} from "./live-export-source-test-fixture";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";

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
  vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
    status: 0,
    output: `Gateway inference:\n  Provider: vllm-local\n  Model: ${model}\n`,
  });
  const liveSandbox = inventory();
  Object.assign(liveSandbox.sandbox.spec, { providers: ["vllm-local"] });
  raw.getSandbox.mockResolvedValue(liveSandbox);
  const credentials = { NEMOCLAW_VLLM_LOCAL_TOKEN: readFailureCanary };
  const localProvider = {
    metadata: {
      id: "provider-id",
      name: "vllm-local",
      workspace: "default",
      resourceVersion: 8n,
    },
    type: "openai",
    credentials,
    config: { OPENAI_BASE_URL: source.endpointUrl },
    // `openshell provider create` binds the selected workspace explicitly.
    profileWorkspace: "default",
  };
  raw.getProvider.mockResolvedValue({
    provider: localProvider,
  });
  raw.getProviderProfile.mockImplementation(async () => {
    throw new Error(readFailureCanary);
  });
  return { source, observed, localProvider };
}

describe("managed vLLM export pipeline", () => {
  it.each([
    { count: 1, names: ["researcher"] },
    { count: 2, names: ["researcher", "reviewer"] },
    { count: 128, names: Array.from({ length: 128 }, (_, index) => `reader-${index}`) },
  ])(
    "refuses all $count fixed-profile secondaries that current v1 cannot represent (#11859, #12012)",
    async ({ names }) => {
      mockManagedVllmSource({
        NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(
          names.map((id) => ({ id, tools: { allow: ["read"] } })),
        ),
      });
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
      expect(result).toMatchObject({
        ok: false,
        failure: {
          kind: "observation",
          findings: [
            expect.objectContaining({
              field: "spec.sandboxes[].agent",
              category: "unsupported",
              diagnostic:
                "V1alpha1 export does not support an OpenClaw sandbox with secondary agents.",
            }),
          ],
        },
      });
      expect(output).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("exports direct tools, managed vLLM, Brave and retained OTLP with qualified profile bindings", async () => {
    mockManagedVllmSource(
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
    const document = asExportedConfig(YAML.parse(writeStdout.mock.calls[0]![0]));
    expect(document.spec.services?.vllm).toMatchObject({ kind: "vllm", image: null });
    expect(document.spec.sandboxes[0]).toMatchObject({
      integrations: {
        "brave-search": {
          kind: "webSearch",
          provider: "brave",
          credential: { env: "BRAVE_API_KEY" },
        },
      },
      harness: {
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName: "research-assistant",
            sampleRate: 0.5,
          },
        },
      },
    });
    expect(document.spec.sandboxes[0]!.agent).toMatchObject({
      tools: { disclosure: "direct" },
      integrationRefs: ["brave-search"],
    });
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "execution",
      environment: { NEMOCLAW_AGENT_TIMEOUT: "900", NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5m" },
      execution: { timeoutSeconds: 900, heartbeatEvery: "5m" },
      overrides: {},
    },
    {
      label: "tuning with execution",
      environment: {
        NEMOCLAW_AGENT_TIMEOUT: "900",
        NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5m",
        NEMOCLAW_MAX_TOKENS: "8192",
        NEMOCLAW_REASONING: "true",
        NEMOCLAW_REASONING_EFFORT: "high",
      },
      execution: { timeoutSeconds: 900, heartbeatEvery: "5m" },
      overrides: { maxTokens: 8192, reasoning: true, reasoningEffort: "high" },
    },
    { label: "defaults", environment: {}, execution: undefined, overrides: {} },
    {
      label: "explicit defaults and disabled heartbeat",
      environment: {
        NEMOCLAW_AGENT_TIMEOUT: "600",
        NEMOCLAW_AGENT_HEARTBEAT_EVERY: "0m",
        NEMOCLAW_REASONING: "false",
        NEMOCLAW_REASONING_EFFORT: "default",
      },
      execution: { heartbeatEvery: "0m" },
      overrides: {},
    },
    {
      label: "tuning with reasoning disabled",
      environment: { NEMOCLAW_MAX_TOKENS: "8192", NEMOCLAW_REASONING: "false" },
      execution: undefined,
      overrides: { maxTokens: 8192 },
    },
  ])(
    "exports retained $label with the fixed managed deployment (#11855, #11856)",
    async ({ environment, execution, overrides }) => {
      mockManagedVllmSource(environment);
      vi.stubEnv("NEMOCLAW_AGENT_TIMEOUT", "1200");
      vi.stubEnv("NEMOCLAW_AGENT_HEARTBEAT_EVERY", "1h");
      vi.stubEnv("NEMOCLAW_MAX_TOKENS", "42");
      vi.stubEnv("NEMOCLAW_REASONING", "true");
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const document = asExportedConfig(YAML.parse(writeStdout.mock.calls[0]![0]));
      expect(document.spec.sandboxes[0]!.harness.execution).toEqual(execution);
      expect(document.spec.sandboxes[0]!.agent.inference.routes[0]!.overrides).toEqual({
        contextWindow: 65536,
        model: "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
        ...overrides,
      });
      expect(document.spec.services?.vllm).toMatchObject({ kind: "vllm", image: null });
      expect(raw.getProviderProfile).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("qualifies the fixed vLLM runtime when the registry omits profile provenance", async () => {
    const fixture = mockManagedVllmSource();
    const source: SandboxEntry = { ...fixture.source };
    delete source.servingProfileProvenance;
    vi.mocked(loadRegistry).mockReturnValue({
      sandboxes: { alpha: source },
      defaultSandbox: null,
    });

    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toMatchObject({
      kind: "observed",
      inference: {
        provider: "vllm-local",
        credentialEnv: null,
        endpointEvidence: {
          provider: { name: "vllm-local", workspace: "default" },
          source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
        },
      },
    });
    expect(observeManagedVllmForExport).toHaveBeenCalledWith(undefined);
    expect(raw.getProviderProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["agentConfig", { agentTimeoutSeconds: 0 }],
    ["agentConfig", { agentTimeoutSeconds: 1.5 }],
    ["agentConfig", { heartbeatEvery: "5m\n" }],
    ["agentConfig", { heartbeatEvery: "1".repeat(256) + "m" }],
    ["agentConfig", { minimalBootstrap: true }],
    ["tuning", { contextWindow: 32768 }],
    ["tuning", { maxTokens: 0 }],
    ["tuning", { maxTokens: 1_000_000_001 }],
    ["tuning", { reasoning: null }],
    ["tuning", { reasoningEffort: "credential-canary-value" }],
    ["tuning", { unexpected: "credential-canary-value" }],
    ["inference", { model: "another-model" }],
  ] as const)(
    "refuses invalid or conflicting retained %s settings %j (#11855, #11856)",
    async (field, change) => {
      const f = mockManagedVllmSource({
        NEMOCLAW_AGENT_TIMEOUT: "900",
        NEMOCLAW_MAX_TOKENS: "8192",
      });
      const workload = f.source.workload as typeof entry.workload;
      expect(workload.kind).toBe("managed-image");
      const profile = JSON.parse(
        Buffer.from(workload.encodedProfile, "base64url").toString("utf8"),
      ) as Record<string, Record<string, unknown>>;
      Object.assign(profile[field]!, change);
      const encodedProfile = Buffer.from(JSON.stringify(profile)).toString("base64url");
      vi.mocked(loadRegistry).mockReturnValue({
        sandboxes: {
          alpha: {
            ...f.source,
            workload: {
              ...workload,
              encodedProfile,
              startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
            },
          },
        },
        defaultSandbox: null,
      });
      const exported = await exportLiveSource();
      expect(exported.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
    },
  );

  it.each([
    { workload: undefined },
    { lifecycleLiveIdentityFingerprint: "f".repeat(64) },
    { compatibleEndpointReasoning: "false" },
    { model: "another-model" },
  ] as const)(
    "refuses incomplete or conflicting deployment evidence %j (#11855, #11856)",
    async (change) => {
      const f = mockManagedVllmSource({
        NEMOCLAW_AGENT_TIMEOUT: "900",
        NEMOCLAW_MAX_TOKENS: "8192",
        NEMOCLAW_REASONING: "true",
      });
      vi.mocked(loadRegistry).mockReturnValue({
        sandboxes: { alpha: { ...f.source, ...change } },
        defaultSandbox: null,
      });
      const exported = await exportLiveSource();
      expect(exported.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
    },
  );

  it("detects managed container restart between complete snapshots", async () => {
    const f = mockManagedVllmSource({ NEMOCLAW_AGENT_TIMEOUT: "900", NEMOCLAW_MAX_TOKENS: "8192" });
    let revision = 0;
    vi.mocked(observeManagedVllmForExport).mockImplementation(() => ({
      ...f.observed,
      startedAt: String(revision++),
    }));
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
  });

  it("rejects a cross-workspace OpenAI profile binding without reading the profile", async () => {
    const { localProvider } = mockManagedVllmSource();
    Object.assign(localProvider, { profileWorkspace: "other-workspace" });
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
    expect(raw.getProviderProfile).not.toHaveBeenCalled();
  });

  it("refuses endpoint drift from the verified managed runtime", async () => {
    const { source, localProvider } = mockManagedVllmSource();
    const endpointUrl = "http://host.openshell.internal:18001/v1";
    vi.mocked(loadRegistry).mockReturnValue({
      sandboxes: { alpha: { ...source, endpointUrl } },
      defaultSandbox: null,
    });
    Object.assign(localProvider.config, { OPENAI_BASE_URL: endpointUrl });

    expectExportRefusal(await exportLiveSource(), { category: "missing-provenance" });
  });

  it("detects direct provider revision changes", async () => {
    const { localProvider } = mockManagedVllmSource();
    let revision = 8n;
    raw.getProvider.mockImplementation(async () => ({
      provider: {
        ...localProvider,
        metadata: { ...localProvider.metadata, resourceVersion: revision++ },
      },
    }));
    expect(
      await observeStableExportSource("alpha", createLiveExportSnapshotReader()),
    ).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
    expect(raw.getProviderProfile).not.toHaveBeenCalled();
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
