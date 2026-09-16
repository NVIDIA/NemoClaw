// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import ConfigExportCommand from "../../../commands/config/export";
import { runConfigExport } from "../../actions/config/export";
import {
  parseNemoClawConfigDocumentName,
  EXPORTED_VLLM_PROFILE_ID,
  EXPORTED_VLLM_RECIPE_ID,
  type ImmutableImageReference,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { validateNemoClawConfig } from "../../config/schema";
import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../../inference/serving/profile-provenance";
import { applyVllmRuntimeContextWindow } from "../../inference/vllm-runtime-context";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import type { ObservedManagedVllmRuntime } from "../../domain/config/export-evidence";
import { getLiveGatewayInference } from "../../inference/live";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { createLiveExportSnapshotReader } from "./live-export-source";
import {
  braveProvider,
  readFailureCanary,
  startupInput,
  entry,
  inventory,
  configuration,
  openAiProviderProfile,
} from "./live-export-source-test-fixture";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";

const readOnlyRoster = ["researcher", "reviewer"].map((id) => ({
  id,
  tools: { allow: ["read"] },
}));
const rosterEnvironment = { NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(readOnlyRoster) };

function replaceProfileSection(
  source: SandboxEntry,
  field: string,
  change: Record<string, unknown>,
) {
  const workload = source.workload as typeof entry.workload;
  const profile = JSON.parse(
    Buffer.from(workload.encodedProfile, "base64url").toString("utf8"),
  ) as Record<string, Record<string, unknown>>;
  Object.assign(profile[field]!, change);
  const encodedProfile = Buffer.from(JSON.stringify(profile)).toString("base64url");
  return {
    ...source,
    workload: {
      ...workload,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
    },
  };
}

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
  it.each([
    { count: 1, names: ["researcher"] },
    { count: 2, names: ["researcher", "reviewer"] },
    { count: 128, names: Array.from({ length: 128 }, (_, index) => `reader-${index}`) },
  ])("exports the complete command with $count read-only agents (#11859)", async ({ names }) => {
    const f = mockManagedVllmSource({
      NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify(
        names.map((id) => ({ id, tools: { allow: ["read"] } })),
      ),
    });
    let yaml = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string,
      callback?: (error?: Error | null) => void,
    ) => {
      yaml += chunk;
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      await expect(
        ConfigExportCommand.run(["alpha", "--output", "-"], process.cwd()),
      ).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "managed-vllm",
        provider: "vllm-local",
        api: "openai-completions",
        serving: f.observed.serving,
      },
    ]);
    expect(document.spec.sandboxes[0]!.agents).toEqual(
      ["primary", ...names].map((name) => ({
        name,
        type: "openclaw",
        ...(name === "primary" ? {} : { tools: { allow: ["read"] } }),
        inference: {
          routes: [
            {
              name: "primary",
              providerRef: "managed-vllm",
              overrides: { model: f.source.model, contextWindow: 65536 },
            },
          ],
        },
      })),
    );
    expect(yaml).not.toContain(readFailureCanary);
    expect(yaml).not.toContain("NEMOCLAW_VLLM_LOCAL_TOKEN");
  });

  it("refuses an absent OpenAI profile without publishing (#11435)", async () => {
    mockManagedVllmSource();
    raw.getProviderProfile.mockRejectedValue({ code: 5 });
    expectExportRefusal(await exportLiveSource(), {
      field: "spec.inferenceProviders[].serving",
      category: "drifted",
    });
  });

  it.each([
    { failure: "missing serving provenance", category: "live-verification-failed" },
    { failure: "inconsistent roster authority", category: "missing-provenance" },
  ])(
    "leaves no YAML or staging file when the command refuses $failure (#11859)",
    async ({ failure, category }) => {
      const f = mockManagedVllmSource(rosterEnvironment);
      const source: SandboxEntry =
        failure === "missing serving provenance"
          ? { ...f.source, servingProfileProvenance: undefined }
          : ({
              ...f.source,
              workload: { ...f.source.workload!, startupProfileSha256: "f".repeat(64) },
            } as SandboxEntry);
      vi.mocked(loadRegistry).mockReturnValue({
        sandboxes: { alpha: source },
        defaultSandbox: null,
      });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-roster-refusal-"));
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expect(
          ConfigExportCommand.run(
            ["alpha", "--output", path.join(directory, "roster.yaml")],
            process.cwd(),
          ),
        ).rejects.toThrow(`Config export failed (${category})`);
        expect(fs.readdirSync(directory)).toEqual([]);
        expect(write).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
        platform.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
      }
      expect(fs.existsSync(directory)).toBe(false);
    },
  );

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
        ...rosterEnvironment,
        NEMOCLAW_OPENCLAW_OTEL: "1",
        NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
        NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "research-assistant",
        NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
      },
      { fetchEnabled: true, provider: "brave" },
      "direct",
    );
    const search = braveProvider();
    vi.mocked(loadRegistry).mockReturnValue({
      sandboxes: {
        alpha: {
          ...replaceProfileSection(f.source, "dashboard", {
            port: 19000,
            url: "http://127.0.0.1:19000",
          }),
          dashboardPort: 19000,
        },
      },
      defaultSandbox: null,
    });
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
    const primary = document.spec.sandboxes[0]!.agents[0]!;
    expect(document.spec.sandboxes[0]!.agents).toEqual([
      {
        name: "primary",
        type: "openclaw",
        tools: { disclosure: "direct" },
        interfaces: { dashboard: { port: 19000 } },
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
      ...readOnlyRoster.map(({ id, tools }) => ({
        name: id,
        type: "openclaw",
        tools,
        inference: primary.inference,
      })),
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

  it.each(
    [
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
    ].flatMap((settings) => [
      { ...settings, roster: false },
      { ...settings, roster: true },
    ]),
  )(
    "exports retained $label with managed roster=$roster (#11855, #11856, #11859)",
    async ({ environment, execution, overrides, roster }) => {
      const f = mockManagedVllmSource({ ...environment, ...(roster ? rosterEnvironment : {}) });
      vi.stubEnv("NEMOCLAW_AGENT_TIMEOUT", "1200");
      vi.stubEnv("NEMOCLAW_AGENT_HEARTBEAT_EVERY", "1h");
      vi.stubEnv("NEMOCLAW_MAX_TOKENS", "42");
      vi.stubEnv("NEMOCLAW_REASONING", "true");
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const yaml = writeStdout.mock.calls[0]![0];
      const document = validateNemoClawConfig(YAML.parse(yaml));
      expect(document.spec.inferenceProviders).toEqual([
        {
          name: "managed-vllm",
          provider: "vllm-local",
          api: "openai-completions",
          serving: f.observed.serving,
        },
      ]);
      const agent = document.spec.sandboxes[0]!.agents[0]!;
      expect(agent).toEqual({
        name: "primary",
        type: "openclaw",
        ...(execution === undefined ? {} : { execution }),
        inference: {
          routes: [
            {
              name: "primary",
              providerRef: "managed-vllm",
              overrides: { model: f.source.model, contextWindow: 65536, ...overrides },
            },
          ],
        },
      });
      expect(document.spec.sandboxes[0]!.agents.slice(1)).toEqual(
        (roster ? readOnlyRoster : []).map(({ id, tools }) => ({
          name: id,
          type: "openclaw",
          tools,
          inference: agent.inference,
        })),
      );
      expect(yaml).not.toContain(readFailureCanary);
      expect(publish).not.toHaveBeenCalled();
    },
  );

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
        ...rosterEnvironment,
        NEMOCLAW_AGENT_TIMEOUT: "900",
        NEMOCLAW_MAX_TOKENS: "8192",
      });
      vi.mocked(loadRegistry).mockReturnValue({
        sandboxes: { alpha: replaceProfileSection(f.source, field, change) },
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
    { label: "different model", change: { model: "inference/other" } },
    { label: "independent route", change: { model: "other-provider/same-model" } },
    { label: "tools", change: { tools: { allow: ["read", "write"] } } },
    { label: "execution", change: { execution: { timeoutSeconds: 900 } } },
    { label: "context", change: { contextWindow: 32768 } },
    { label: "interface", change: { interfaces: { dashboard: { port: 19000 } } } },
    { label: "authentication", change: { auth: { method: "api-key" } } },
    { label: "observability", change: { observability: { enabled: true } } },
    { label: "description", change: { description: "unsupported" } },
    { label: "subagents", change: { subagents: { allowAgents: ["researcher"] } } },
    { label: "duplicate name", change: { id: "researcher" } },
    { label: "reserved name", change: { id: "primary" } },
  ])(
    "refuses a later agent's unsupported $label without file publication (#11859)",
    async ({ change }) => {
      const f = mockManagedVllmSource(rosterEnvironment);
      const source = replaceProfileSection(f.source, "agentConfig", {
        extraAgents: {
          agents: [readOnlyRoster[0], { ...readOnlyRoster[1], ...change }],
          defaults: {},
          main: {},
        },
      });
      vi.mocked(loadRegistry).mockReturnValue({
        sandboxes: { alpha: source },
        defaultSandbox: null,
      });
      const exported = await exportLiveSource({
        kind: "file",
        outputPath: "/tmp/refused-roster.yaml",
        force: false,
      });
      expect(exported.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(exported.publish).not.toHaveBeenCalled();
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(JSON.stringify(exported.result)).not.toContain(readFailureCanary);
    },
  );

  it.each([
    { extraAgents: null },
    {
      extraAgents: {
        agents: readOnlyRoster,
        defaults: { subagents: { maxSpawnDepth: 2 } },
        main: {},
      },
    },
    { extraAgents: { agents: readOnlyRoster, defaults: {}, main: { tools: { allow: ["read"] } } } },
  ])("refuses missing roster authority or shared overrides %j (#11859)", async (change) => {
    const f = mockManagedVllmSource(rosterEnvironment);
    const source = replaceProfileSection(f.source, "agentConfig", change);
    vi.mocked(loadRegistry).mockReturnValue({ sandboxes: { alpha: source }, defaultSandbox: null });
    const exported = await exportLiveSource();
    expect(exported.result.ok).toBe(false);
    expect(exported.publish).not.toHaveBeenCalled();
    expect(exported.writeStdout).not.toHaveBeenCalled();
  });

  it("refuses a roster that does not match its workload digest (#11859)", async () => {
    const f = mockManagedVllmSource(rosterEnvironment);
    const source = {
      ...f.source,
      workload: { ...f.source.workload!, startupProfileSha256: "f".repeat(64) },
    } as SandboxEntry;
    vi.mocked(loadRegistry).mockReturnValue({ sandboxes: { alpha: source }, defaultSandbox: null });
    expectExportRefusal(await exportLiveSource(), { category: "missing-provenance" });
  });

  it("refuses a roster reordered between both observation pairs (#11859)", async () => {
    const f = mockManagedVllmSource(rosterEnvironment);
    const reordered = replaceProfileSection(f.source, "agentConfig", {
      extraAgents: { agents: [...readOnlyRoster].reverse(), defaults: {}, main: {} },
    });
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: reads++ % 2 === 0 ? f.source : reordered },
      defaultSandbox: null,
    }));
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
  });

  it.each(["id", "revision", "servedName"] as const)(
    "refuses serving model %s drift with a roster (#11859)",
    async (field) => {
      const f = mockManagedVllmSource(rosterEnvironment);
      vi.mocked(observeManagedVllmForExport).mockReturnValue({
        ...f.observed,
        serving: {
          ...f.observed.serving,
          model: { ...f.observed.serving.model, [field]: "f".repeat(40) },
        },
      });
      expectExportRefusal(await exportLiveSource(), { category: "drifted" });
    },
  );

  it.each([
    { workload: undefined },
    { servingProfileProvenance: undefined },
    { lifecycleLiveIdentityFingerprint: "f".repeat(64) },
    { compatibleEndpointReasoning: "false" },
    { model: "another-model" },
  ] as const)(
    "refuses incomplete or conflicting deployment evidence %j (#11855, #11856)",
    async (change) => {
      const f = mockManagedVllmSource({
        ...rosterEnvironment,
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

  it.each([
    { hostPort: 19000 },
    { catalogDigest: `sha256:${"f".repeat(64)}` },
    { profile: { id: EXPORTED_VLLM_PROFILE_ID, digest: `sha256:${"f".repeat(64)}` } },
    { recipe: { id: EXPORTED_VLLM_RECIPE_ID, digest: `sha256:${"f".repeat(64)}` } },
    {
      runtime: {
        image: { ref: `nvcr.io/nvidia/vllm@sha256:${"f".repeat(64)}` as ImmutableImageReference },
      },
    },
  ])("rejects serving drift with retained settings %j (#11855, #11856)", async (change) => {
    const f = mockManagedVllmSource({
      ...rosterEnvironment,
      NEMOCLAW_AGENT_TIMEOUT: "900",
      NEMOCLAW_MAX_TOKENS: "8192",
    });
    vi.mocked(observeManagedVllmForExport).mockReturnValue({
      ...f.observed,
      serving: { ...f.observed.serving, ...change },
    });
    expectExportRefusal(await exportLiveSource(), {
      field: "spec.inferenceProviders[].serving",
      category: "drifted",
    });
  });

  it("detects managed container restart between complete snapshots", async () => {
    const f = mockManagedVllmSource({
      ...rosterEnvironment,
      NEMOCLAW_AGENT_TIMEOUT: "900",
      NEMOCLAW_MAX_TOKENS: "8192",
    });
    let revision = 0;
    vi.mocked(observeManagedVllmForExport).mockImplementation(() => ({
      ...f.observed,
      startedAt: String(revision++),
    }));
    expectExportRefusal(await exportLiveSource(), { category: "unstable-source" });
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
