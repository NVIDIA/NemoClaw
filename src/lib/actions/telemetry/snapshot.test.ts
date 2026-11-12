// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";

const mocks = vi.hoisted(() => ({
  listRoots: vi.fn(),
  readRegistry: vi.fn(),
  createReader: vi.fn(),
}));

vi.mock("../../state/gateway-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/gateway-registry")>()),
  listGatewayStateRoots: mocks.listRoots,
  readGatewayRegistryFile: mocks.readRegistry,
}));
vi.mock("./native-reader", () => ({
  createSupervisedSandboxCommandReader: mocks.createReader,
}));
vi.mock("../sandbox/mcp-bridge-provider-inspection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox/mcp-bridge-provider-inspection")>()),
  getMcpProviderInspectionRuntimeSelection: (entry: { name: string }) => ({
    gatewayName: "nemoclaw",
    workspace: entry.name,
  }),
}));

import { collectOperationSnapshot } from "./snapshot";
import { collectOperationEvent } from "./send";
import { isOperationEvent } from "../../domain/telemetry/schema";
import {
  dcodeImageRef,
  dcodeProfileInput,
  hermesImageRef,
  hermesProfileInput,
  imageRef,
  managedWorkload,
  profileInput,
} from "../../domain/config/export-source-test-fixture";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../inference/native-local/contract";
import type { SandboxEntry } from "../../state/registry/types";

beforeEach(() => {
  mocks.listRoots.mockReset();
  mocks.readRegistry.mockReset();
  mocks.createReader.mockReset();
  mocks.listRoots.mockReturnValue([{ root: "/unused", gatewayPort: 8080 }]);
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `sandbox${index}`,
        { name: `sandbox${index}`, agent: "unsupported" },
      ]),
    ),
  });
});

function holdObservations() {
  const pending: Array<() => void> = [];
  let active = 0;
  let started = 0;
  let maximumActive = 0;
  mocks.createReader.mockReturnValue({
    read: vi.fn(async () => {
      throw new Error("no sandbox command in this test");
    }),
    observeInferenceRoute: vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          pending.push(() => {
            active -= 1;
            reject(new Error("no gateway in this test"));
          });
        }),
    ),
    dispose: vi.fn(),
  });
  return {
    pending,
    get started() {
      return started;
    },
    get maximumActive() {
      return maximumActive;
    },
  };
}

it("bounds concurrent runtime observations across a large inventory (#12859)", async () => {
  const observed = holdObservations();
  const result = collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
  await vi.waitFor(() => expect(observed.started).toBe(4));
  expect(observed.maximumActive).toBe(4);

  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  await vi.waitFor(() => expect(observed.started).toBe(8));
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  await vi.waitFor(() => expect(observed.started).toBe(9));
  observed.pending.shift()?.();
  const snapshot = await result;
  expect(snapshot.configurations).toHaveLength(9);
  expect(observed.started).toBe(9);
  expect(observed.maximumActive).toBe(4);
});

it("marks observations that never start before cancellation (#12859)", async () => {
  const observed = holdObservations();
  const controller = new AbortController();
  const result = collectOperationSnapshot({
    signal: controller.signal,
    deadlineAt: Date.now() + 10_000,
  });
  await vi.waitFor(() => expect(observed.started).toBe(4));
  controller.abort();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();
  observed.pending.shift()?.();

  const snapshot = await result;
  expect(observed.started).toBe(4);
  expect(snapshot.configurations.slice(4).map((row) => row.agentsStatus)).toEqual(
    Array(5).fill("not_observed"),
  );
  expect(snapshot.collectionStatus).toBe("partial");
});

it("joins a managed OpenClaw 2026.10.5 configuration to its operation target (#12859)", async () => {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  const imageTag = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: {
      first: {
        name: "first",
        agent: "openclaw",
        gatewayPort: 8080,
        model: "gpt-4o",
        provider: "openai-api",
      },
      selected: {
        name: "selected",
        agent: "openclaw",
        agentVersion: "2026.10.5",
        imageTag,
        workload: {
          schemaVersion: 1,
          kind: "managed-image",
          reference: imageTag,
          platform: "linux/amd64",
          release: "v0.0.132",
          sourceRevision: "b".repeat(40),
          sourceCohort: "ghrun-123456-1",
          capabilityContractVersion: 1,
          startupProfileContractVersion: 1,
          encodedProfile,
          startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
          credentialProxyReplayRequired: false,
          shared: true,
        },
        gatewayPort: 8080,
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        provider: "nvidia-prod",
      },
    },
  });
  const config = JSON.stringify({
    agents: {
      defaults: { model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b" },
      entries: { main: { default: true } },
    },
    models: {
      providers: {
        nvidia: { api: "openai-completions", baseUrl: "https://inference.local/v1" },
      },
    },
  });
  const responses: Record<string, Record<string, string>> = {
    first: {
      [JSON.stringify(["uname", "-s"])]: "Linux",
      [JSON.stringify(["openclaw", "agents", "list", "--json"])]: JSON.stringify([
        { id: "main", isDefault: true },
      ]),
      [JSON.stringify(["cat", "/sandbox/.openclaw/openclaw.json"])]: JSON.stringify({
        agents: {
          defaults: { model: "openai/gpt-4o" },
          entries: { main: { default: true } },
        },
        models: { providers: { openai: { api: "openai-completions" } } },
      }),
    },
    selected: {
      [JSON.stringify(["uname", "-s"])]: "Linux",
      [JSON.stringify(["openclaw", "agents", "list", "--json"])]: JSON.stringify([
        { id: "main", isDefault: true },
      ]),
      [JSON.stringify(["cat", "/sandbox/.openclaw/openclaw.json"])]: config,
    },
  };
  const read = vi.fn(
    async ({ sandboxName, command }: { sandboxName: string; command: readonly string[] }) => {
      const response = responses[sandboxName]?.[JSON.stringify(command)];
      return response ?? Promise.reject(new Error("Unexpected sandbox command"));
    },
  );
  mocks.createReader.mockReturnValue({
    read,
    observeInferenceRoute: vi.fn(async () => ({
      ok: true,
      value: {
        state: "configured",
        route: { model: "nvidia/nemotron-3-ultra-550b-a55b", provider: "nvidia-prod" },
      },
    })),
    dispose: vi.fn(),
  });
  const context = {
    operation: "sandbox_rebuild" as const,
    startedAt: "2026-10-09T00:00:00.000Z",
    completedAt: "2026-10-09T00:00:01.000Z",
    outcome: "completed" as const,
    state: "applied" as const,
    scope: "sandbox" as const,
    installedVersion: "1.2.3",
    targets: [
      {
        scope: "sandbox" as const,
        sandboxName: "selected",
        gatewayName: "nemoclaw",
        outcome: "completed" as const,
        state: "applied" as const,
      },
    ],
  };
  const event = await collectOperationEvent(context, {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
  expect(read).toHaveBeenCalled();
  // One configured agent each, so no sandbox needs the native roster command.
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).not.toHaveBeenCalledWith(
    expect.objectContaining({ sandboxName: "selected", command: ["uname", "-s"] }),
    expect.anything(),
  );
  expect(event.parameters).toMatchObject({
    publishedEnvironmentCount: 2,
    configuredRuntimeCount: 2,
    configuredAgentCount: 2,
    targetResults: [{ configurationPosition: 1, configurationStatus: "reported" }],
    configurations: [
      {
        agentHarnessId: "openclaw",
        agentsStatus: "reported",
      },
      {
        agentHarnessId: "openclaw",
        agentsStatus: "reported",
        currentInferenceRouteStatus: "reported",
        managedAgentVersion: "2026.10.5",
        managedAgentVersionStatus: "reported",
      },
    ],
  });
  expect(event.parameters.configurations[0].agents[0].models[0].modelId).toBe("gpt-4o");
  expect(event.parameters.configurations[1].agents).toHaveLength(1);
  expect(event.parameters.configurations[1].agents[0].models[0]).toMatchObject({
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    providerProfile: "nvidia",
    apiFamily: "openai-completions",
  });
  expect(event.parameters.configurations[1].currentInferenceRoute).toMatchObject({
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    providerProfile: "nvidia",
  });
  expect(isOperationEvent(event)).toBe(true);
});

const nativeModelCases = [
  {
    agent: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    validConfig:
      "model:\n  default: Qwen/Qwen3.6-27B-FP8\n  provider: anthropic\n  api_mode: anthropic_messages\n",
    invalidConfig: "model:\n  default: 42\n",
    modelId: "Qwen/Qwen3.6-27B-FP8",
    providerProfile: "anthropic",
    apiFamily: "anthropic-messages",
  },
  {
    agent: "langchain-deepagents-code",
    configPath: "/sandbox/.deepagents/config.toml",
    validConfig:
      '[models]\ndefault = "openai:nvidia/nemotron-3-ultra-550b-a55b"\n[models.providers.openai.params]\nuse_responses_api = true\n',
    invalidConfig: '[models]\ndefault = "invalid"\n',
    modelId: "nvidia/nemotron-3-ultra-550b-a55b",
    providerProfile: "openai",
    apiFamily: "openai-responses",
  },
] as const;

async function collectNativeEvent(
  agent: string,
  entryOverrides: Partial<SandboxEntry>,
  responses: Record<string, string>,
) {
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: {
      native: { name: "native", agent, gatewayPort: 8080, ...entryOverrides },
    },
  });
  const read = vi.fn(async ({ command }: { command: readonly string[] }) => {
    return (
      responses[JSON.stringify(command)] ?? Promise.reject(new Error("Unexpected sandbox command"))
    );
  });
  mocks.createReader.mockReturnValue({
    read,
    observeInferenceRoute: vi.fn(async () => ({ ok: true, value: { state: "unconfigured" } })),
    dispose: vi.fn(),
  });
  const event = await collectOperationEvent(
    {
      operation: "sandbox_rebuild",
      startedAt: "2026-10-09T00:00:00.000Z",
      completedAt: "2026-10-09T00:00:01.000Z",
      outcome: "completed",
      state: "applied",
      scope: "sandbox",
      installedVersion: "1.2.3",
      targets: [
        {
          scope: "sandbox",
          sandboxName: "native",
          gatewayName: "nemoclaw",
          outcome: "completed",
          state: "applied",
        },
      ],
    },
    { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000 },
  );
  return { event, read };
}

async function collectNativeConfiguration(
  agent: string,
  configPath: string,
  rawConfig: string,
  entryOverrides: Partial<SandboxEntry> = {},
  extraResponses: Record<string, string> = {},
  // A valid managed receipt supplies the sandbox OS; otherwise the collector runs `uname -s`.
  unameReads = entryOverrides.workload ? 0 : 1,
) {
  const { event, read } = await collectNativeEvent(agent, entryOverrides, {
    [JSON.stringify(["uname", "-s"])]: "Linux",
    [JSON.stringify(["cat", configPath])]: rawConfig,
    ...extraResponses,
  });
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxName: "native", command: ["cat", configPath] }),
    expect.objectContaining({ workspace: "native" }),
  );
  expect(read).toHaveBeenCalledTimes(1 + unameReads + Object.keys(extraResponses).length);
  return event;
}

it.each([
  ["0.1.71", "0.1.71", "reported"],
  ["private-build", "private-build", "reported"],
])(
  "reports managed Deep Agents version %s as %s (#12376)",
  async (agentVersion, managedAgentVersion, managedAgentVersionStatus) => {
    const { agent, configPath, validConfig } = nativeModelCases[1];
    const event = await collectNativeConfiguration(agent, configPath, validConfig, {
      agentVersion,
      imageTag: dcodeImageRef,
      workload: managedWorkload(dcodeProfileInput(), dcodeImageRef),
    });
    expect(event.parameters.configurations[0]).toMatchObject({
      agentHarnessId: agent,
      managedAgentVersion,
      managedAgentVersionStatus,
      settings: { imageOwnership: "managed", imageOwnershipStatus: "reported" },
      agents: [{ managedAgentVersion, managedAgentVersionStatus }],
    });
    expect(isOperationEvent(event)).toBe(true);
  },
);

it.each(nativeModelCases)(
  "reports the $agent native model, provider, and API family (#12859)",
  async ({ agent, configPath, validConfig, modelId, providerProfile, apiFamily }) => {
    const event = await collectNativeConfiguration(agent, configPath, validConfig);
    expect(event.parameters.configurations[0]).toMatchObject({
      agentHarnessId: agent,
      agentsStatus: "reported",
      defaultAgentModel: { agentPosition: 0, modelPosition: 0, status: "reported" },
      agents: [
        {
          modelsStatus: "reported",
          models: [{ modelId, modelStatus: "reported", providerProfile, apiFamily }],
        },
      ],
    });
    expect(isOperationEvent(event)).toBe(true);
  },
);

it.each(nativeModelCases)(
  "marks a malformed $agent native model as a collection error (#12859)",
  async ({ agent, configPath, invalidConfig }) => {
    const event = await collectNativeConfiguration(agent, configPath, invalidConfig);
    expect(event.parameters.configurations[0]).toMatchObject({
      agentHarnessId: agent,
      status: "collection_error",
      agentsStatus: "collection_error",
      defaultAgentModel: { status: "collection_error" },
    });
    expect(isOperationEvent(event)).toBe(true);
  },
);

const hostedNvidiaEndpoint = "https://integrate.api.nvidia.com/v1";
const hostedNvidiaModel = "nvidia/nemotron-3-ultra-550b-a55b";
const hostedNvidiaProvenance = {
  schemaVersion: 1,
  model: hostedNvidiaModel,
  provider: "nvidia-prod",
  providerProfile: "nvidia",
  modelSource: "custom",
  apiFamily: "openai-completions",
};

function hostedNvidiaHermes(routedBaseUrl = hostedNvidiaEndpoint): Partial<SandboxEntry> {
  const input = hermesProfileInput();
  // Registry JSON stores the persisted messaging plan, not the in-memory plan type.
  return {
    model: hostedNvidiaModel,
    provider: "nvidia-prod",
    modelSelectionProvenance: hostedNvidiaProvenance,
    // Settings a fresh onboard records, so only the model route decides completeness.
    agentVersion: "0.21.3",
    openshellDriver: "docker",
    sandboxGpuEnabled: false,
    webSearchEnabled: false,
    observabilityEnabled: false,
    appliedPolicySelection: { schemaVersion: 1, source: "verified_selection", tier: "balanced" },
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "native",
        agent: "hermes",
        workflow: "onboard",
        disabledChannels: [],
        channels: [],
        credentialBindings: [],
      },
    },
    imageTag: hermesImageRef,
    workload: managedWorkload(
      {
        ...input,
        inference: {
          ...input.inference!,
          routeProvider: "inference",
          upstreamProvider: "nvidia-prod",
          model: hostedNvidiaModel,
          routedBaseUrl,
          api: "openai-completions",
        },
      },
      hermesImageRef,
    ),
  } as unknown as Partial<SandboxEntry>;
}

const hermesNativeConfig = (baseUrl: string) =>
  `model:\n  default: ${hostedNvidiaModel}\n  provider: custom\n  base_url: "${baseUrl}"\n`;

it("binds a hosted native Hermes route recorded in the startup profile (#13576)", async () => {
  const event = await collectNativeConfiguration(
    "hermes",
    "/sandbox/.hermes/config.yaml",
    hermesNativeConfig(hostedNvidiaEndpoint),
    hostedNvidiaHermes(),
  );
  expect(event.parameters.configurations[0].agents[0].models[0]).toMatchObject({
    modelId: hostedNvidiaModel,
    modelSource: "custom",
    modelSourceStatus: "reported",
    providerProfile: "nvidia",
    providerStatus: "reported",
  });
  expect(event.parameters.collectionStatus).toBe("complete");
  expect(isOperationEvent(event)).toBe(true);
});

it.each([
  [
    "a native URL that differs from the recorded route",
    "https://example.invalid/v1",
    hostedNvidiaHermes(),
    0,
  ],
  [
    "no managed startup profile",
    hostedNvidiaEndpoint,
    { ...hostedNvidiaHermes(), imageTag: undefined, workload: undefined },
    1,
  ],
  [
    "an invalid managed receipt",
    hostedNvidiaEndpoint,
    { ...hostedNvidiaHermes(), imageTag: `${hermesImageRef.slice(0, -1)}d` },
    1,
  ],
])(
  "keeps an unrecorded upstream Hermes URL native with %s (#13576)",
  async (_label, baseUrl, overrides, unameReads) => {
    const event = await collectNativeConfiguration(
      "hermes",
      "/sandbox/.hermes/config.yaml",
      hermesNativeConfig(baseUrl),
      overrides,
      {},
      unameReads,
    );
    expect(event.parameters.configurations[0].agents[0].models[0]).toMatchObject({
      modelSource: "unknown",
      modelSourceStatus: "not_persisted",
      providerProfile: "custom",
    });
    expect(event.parameters.collectionStatus).toBe("partial");
    expect(isOperationEvent(event)).toBe(true);
  },
);

function hostedNvidiaWorkload(
  input: ReturnType<typeof profileInput>,
  reference: string,
  routedBaseUrl: string,
  primaryModelRef: string | null,
) {
  return managedWorkload(
    {
      ...input,
      inference: {
        ...input.inference!,
        routeProvider: "inference",
        upstreamProvider: "nvidia-prod",
        model: hostedNvidiaModel,
        routedBaseUrl,
        api: "openai-completions",
        primaryModelRef,
      },
    },
    reference,
  );
}

const hostedRouteBranches = [
  {
    agent: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
    config: (baseUrl: string) =>
      JSON.stringify({
        agents: { defaults: { model: `inference/${hostedNvidiaModel}` }, entries: { main: {} } },
        models: { providers: { inference: { api: "openai-completions", baseUrl } } },
      }),
    extraResponses: {},
    workload: (routedBaseUrl: string) => ({
      imageTag: imageRef,
      workload: hostedNvidiaWorkload(
        profileInput(),
        imageRef,
        routedBaseUrl,
        `inference/${hostedNvidiaModel}`,
      ),
    }),
    nativeProviderProfile: "custom",
  },
  {
    agent: "langchain-deepagents-code",
    configPath: "/sandbox/.deepagents/config.toml",
    config: (baseUrl: string) =>
      `[models]\ndefault = "openai:${hostedNvidiaModel}"\n[models.providers.openai]\nbase_url = "${baseUrl}"\n`,
    extraResponses: {},
    workload: (routedBaseUrl: string) => ({
      imageTag: dcodeImageRef,
      workload: hostedNvidiaWorkload(dcodeProfileInput(), dcodeImageRef, routedBaseUrl, null),
    }),
    nativeProviderProfile: "openai",
  },
] as const;

it.each(hostedRouteBranches)(
  "binds the $agent hosted native route recorded in the startup profile (#13576)",
  async ({ agent, configPath, config, extraResponses, workload }) => {
    const event = await collectNativeConfiguration(
      agent,
      configPath,
      config(hostedNvidiaEndpoint),
      {
        model: hostedNvidiaModel,
        provider: "nvidia-prod",
        modelSelectionProvenance: hostedNvidiaProvenance,
        ...workload(hostedNvidiaEndpoint),
      } as unknown as Partial<SandboxEntry>,
      extraResponses,
    );
    expect(event.parameters.configurations[0].agents[0].models[0]).toMatchObject({
      modelId: hostedNvidiaModel,
      modelSource: "custom",
      modelSourceStatus: "reported",
      providerProfile: "nvidia",
      providerStatus: "reported",
    });
    expect(isOperationEvent(event)).toBe(true);
  },
);

it.each(hostedRouteBranches)(
  "keeps a $agent upstream URL that differs from the recorded route native (#13576)",
  async ({ agent, configPath, config, extraResponses, workload, nativeProviderProfile }) => {
    const event = await collectNativeConfiguration(
      agent,
      configPath,
      config("https://example.invalid/v1"),
      {
        model: hostedNvidiaModel,
        provider: "nvidia-prod",
        modelSelectionProvenance: hostedNvidiaProvenance,
        ...workload(hostedNvidiaEndpoint),
      } as unknown as Partial<SandboxEntry>,
      extraResponses,
    );
    expect(event.parameters.configurations[0].agents[0].models[0]).toMatchObject({
      modelSource: "unknown",
      modelSourceStatus: "not_persisted",
      providerProfile: nativeProviderProfile,
    });
    expect(event.parameters.collectionStatus).toBe("partial");
    expect(isOperationEvent(event)).toBe(true);
  },
);

const hermesConfigPath = "/sandbox/.hermes/config.yaml";
// Hermes has no roster command, so these route tests do not depend on how the roster is read.
const hermesConfig = (model: string, baseUrl: string) =>
  `model:\n  default: ${model}\n  provider: custom\n  base_url: "${baseUrl}"\n`;
const nativeLocalBinding: NativeLocalBinding = {
  provider: "ollama-local",
  agent: "hermes",
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
  gatewayName: "nemoclaw",
  sandboxName: "native",
};
const nativeLocalAttachment = (binding: NativeLocalBinding) => ({
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1,
  providerId: "provider-id",
});

// Native providers are attached to the sandbox, so the gateway keeps no shared route for them.
const nativeRouteCases = [
  {
    label: "native NVIDIA",
    config: hermesConfig(hostedNvidiaModel, hostedNvidiaEndpoint),
    entry: {
      provider: "nvidia-prod",
      model: hostedNvidiaModel,
      modelSelectionProvenance: hostedNvidiaProvenance,
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
        providerId: "provider-id",
      },
    },
    route: {
      modelId: hostedNvidiaModel,
      providerProfile: "nvidia",
      modelSource: "custom",
      apiFamily: "openai-completions",
    },
  },
  {
    label: "native hosted OpenAI",
    config: hermesConfig("gpt-4o", "https://api.openai.com/v1"),
    entry: {
      provider: "openai-api",
      model: "gpt-4o",
      modelSelectionProvenance: {
        schemaVersion: 1,
        model: "gpt-4o",
        provider: "openai-api",
        providerProfile: "openai",
        modelSource: "provider_catalog",
        apiFamily: "openai-completions",
      },
      nativeHostedProviderAttachment: {
        schemaVersion: 1,
        profileId: "nemoclaw-openai-inference-v1",
        providerName: "nemoclaw-openai-api-v1",
        providerId: "provider-id",
      },
    },
    route: {
      modelId: "gpt-4o",
      providerProfile: "openai",
      modelSource: "provider_catalog",
      apiFamily: "openai-completions",
    },
  },
  {
    label: "native local Ollama",
    config: hermesConfig("qwen2.5:7b", nativeLocalBinding.endpointUrl),
    entry: {
      provider: "ollama-local",
      model: "qwen2.5:7b",
      modelSelectionProvenance: {
        schemaVersion: 1,
        model: "qwen2.5:7b",
        provider: "ollama-local",
        providerProfile: "ollama",
        modelSource: "local",
        apiFamily: "openai-completions",
      },
      gatewayName: "nemoclaw",
      nativeLocalProviderAttachment: nativeLocalAttachment(nativeLocalBinding),
    },
    route: {
      modelId: "qwen2.5:7b",
      providerProfile: "ollama",
      modelSource: "local",
      apiFamily: "openai-completions",
    },
  },
] as const;

it.each(nativeRouteCases)(
  "reports the recorded $label selection as the current route (#14241)",
  async ({ config, entry, route }) => {
    const event = await collectNativeConfiguration(
      "hermes",
      hermesConfigPath,
      config,
      entry as unknown as Partial<SandboxEntry>,
    );
    const row = event.parameters.configurations[0];
    expect(row.agents[0].models[0].modelStatus).toBe("reported");
    expect(row.currentInferenceRouteStatus).toBe("reported");
    expect(row.currentInferenceRoute).toEqual({
      assignment: "primary",
      modelId: route.modelId,
      modelStatus: "reported",
      modelSource: route.modelSource,
      modelSourceStatus: "reported",
      providerProfile: route.providerProfile,
      providerStatus: "reported",
      apiFamily: route.apiFamily,
      apiStatus: "reported",
    });
    // The shared gateway route belongs to other sandboxes, not to this one.
    expect(mocks.createReader.mock.results[0].value.observeInferenceRoute).not.toHaveBeenCalled();
    expect(isOperationEvent(event)).toBe(true);
  },
);

it("reports a recorded Pi native-local selection as the current route (#14241)", async () => {
  const { entry, route } = nativeRouteCases[2];
  // Pi has no telemetry config parser, so the collector reads only the sandbox OS.
  const { event, read } = await collectNativeEvent(
    "pi",
    {
      ...entry,
      nativeLocalProviderAttachment: nativeLocalAttachment({ ...nativeLocalBinding, agent: "pi" }),
    } as unknown as Partial<SandboxEntry>,
    { [JSON.stringify(["uname", "-s"])]: "Linux" },
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(event.parameters.configurations[0]).toMatchObject({
    currentInferenceRouteStatus: "reported",
    currentInferenceRoute: { modelId: route.modelId, providerProfile: route.providerProfile },
  });
  expect(mocks.createReader.mock.results[0].value.observeInferenceRoute).not.toHaveBeenCalled();
});

it("reports not_configured when the gateway has no route for a shared-route sandbox (#14241)", async () => {
  const event = await collectNativeConfiguration(
    "hermes",
    hermesConfigPath,
    hermesConfig("custom-model", "https://inference.local/v1"),
    { provider: "compatible-endpoint", model: "custom-model" },
  );
  expect(event.parameters.configurations[0]).toMatchObject({
    currentInferenceRouteStatus: "not_configured",
    currentInferenceRoute: { modelStatus: "not_configured", providerStatus: "not_configured" },
  });
  expect(mocks.createReader.mock.results[0].value.observeInferenceRoute).toHaveBeenCalledTimes(1);
  expect(isOperationEvent(event)).toBe(true);
});

it.each([
  ["a native selection whose provider differs from its attachment", 0, { provider: "openai-api" }],
  [
    "a native-local attachment recorded for another agent",
    2,
    {
      nativeLocalProviderAttachment: nativeLocalAttachment({
        ...nativeLocalBinding,
        agent: "openclaw",
      }),
    },
  ],
] as const)("marks %s as a route collection error (#14241)", async (_label, index, overrides) => {
  const { config, entry } = nativeRouteCases[index];
  const event = await collectNativeConfiguration("hermes", hermesConfigPath, config, {
    ...entry,
    ...overrides,
  } as unknown as Partial<SandboxEntry>);
  expect(event.parameters.configurations[0]).toMatchObject({
    currentInferenceRouteStatus: "collection_error",
    currentInferenceRoute: { modelStatus: "collection_error" },
  });
  expect(mocks.createReader.mock.results[0].value.observeInferenceRoute).not.toHaveBeenCalled();
  expect(isOperationEvent(event)).toBe(true);
});
it("reports a healthy OpenClaw rebuild without the native roster command (#14239)", async () => {
  const { agent, configPath, config, workload } = hostedRouteBranches[0];
  // collectNativeConfiguration rejects the roster command and counts every sandbox read.
  const event = await collectNativeConfiguration(agent, configPath, config(hostedNvidiaEndpoint), {
    model: hostedNvidiaModel,
    provider: "nvidia-prod",
    modelSelectionProvenance: hostedNvidiaProvenance,
    agentVersion: "2026.9.1",
    openshellDriver: "docker",
    sandboxGpuEnabled: false,
    webSearchEnabled: false,
    observabilityEnabled: false,
    appliedPolicySelection: { schemaVersion: 1, source: "verified_selection", tier: "balanced" },
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "native",
        agent: "openclaw",
        workflow: "onboard",
        disabledChannels: [],
        channels: [],
        credentialBindings: [],
      },
    },
    ...workload(hostedNvidiaEndpoint),
  } as unknown as Partial<SandboxEntry>);
  expect(event.parameters).toMatchObject({
    configuredRuntimeCount: 1,
    configuredAgentCount: 1,
    countsStatus: "reported",
    collectionStatus: "complete",
    configurations: [
      {
        status: "reported",
        agentsStatus: "reported",
        defaultAgentModel: { agentPosition: 0, modelPosition: 0, status: "reported" },
        sandboxOS: "linux",
        sandboxOSStatus: "reported",
        managedAgentVersionStatus: "reported",
        settings: {
          computeDriverStatus: "reported",
          gpuStatus: "reported",
          imageOwnershipStatus: "reported",
          policyTierStatus: "reported",
          webSearchStatus: "reported",
        },
      },
    ],
  });
  expect(isOperationEvent(event)).toBe(true);
});

const twoAgentConfig = JSON.stringify({
  agents: {
    defaults: { model: "openai/gpt-4o" },
    entries: { main: { default: true }, helper: {} },
  },
  models: { providers: { openai: { api: "openai-completions" } } },
});

async function collectWithFailures(failing: readonly string[]) {
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: { pair: { name: "pair", agent: "openclaw", gatewayPort: 8080 } },
  });
  const responses: Record<string, string> = {
    uname: "Linux",
    cat: twoAgentConfig,
    openclaw: JSON.stringify([
      { id: "main", isDefault: true },
      { id: "helper", isDefault: false },
    ]),
  };
  mocks.createReader.mockReturnValue({
    read: vi.fn(async ({ command }: { command: readonly string[] }) =>
      failing.includes(command[0])
        ? Promise.reject(new Error("Native evidence could not be verified"))
        : responses[command[0]],
    ),
    observeInferenceRoute: vi.fn(async () =>
      failing.includes("route")
        ? Promise.reject(new Error("no gateway in this test"))
        : { ok: true, value: { state: "unconfigured" } },
    ),
    dispose: vi.fn(),
  });
  return collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
}

it.each([
  [
    "no read",
    [],
    { status: "reported", agentsStatus: "reported", defaultAgentModel: { status: "reported" } },
    "reported",
    "complete",
  ],
  [
    "the OS read",
    ["uname"],
    { sandboxOSStatus: "collection_error", status: "reported", agentsStatus: "reported" },
    "reported",
    "partial",
  ],
  [
    "the route read",
    ["route"],
    { currentInferenceRouteStatus: "collection_error", agentsStatus: "reported" },
    "reported",
    "partial",
  ],
  [
    "the roster read",
    ["openclaw"],
    {
      status: "collection_error",
      agentsStatus: "reported",
      agents: [{ modelsStatus: "reported" }, { modelsStatus: "reported" }],
      defaultAgentModel: { status: "collection_error" },
      sandboxOSStatus: "reported",
    },
    "reported",
    "partial",
  ],
  [
    "the configuration read",
    ["cat"],
    {
      status: "collection_error",
      agentsStatus: "reported",
      agents: [{ modelsStatus: "collection_error" }, { modelsStatus: "collection_error" }],
      defaultAgentModel: { status: "collection_error" },
      sandboxOSStatus: "reported",
    },
    "reported",
    "partial",
  ],
  [
    "both agent reads",
    ["cat", "openclaw"],
    {
      status: "collection_error",
      agentsStatus: "collection_error",
      sandboxOSStatus: "reported",
      currentInferenceRouteStatus: "not_configured",
    },
    "collection_error",
    "partial",
  ],
] as const)(
  "degrades only the fields that %s supplies (#14239)",
  async (_label, failing, row, countsStatus, collectionStatus) => {
    const snapshot = await collectWithFailures(failing);
    expect(snapshot.configurations[0]).toMatchObject(row);
    expect(snapshot).toMatchObject({ countsStatus, collectionStatus });
  },
);
