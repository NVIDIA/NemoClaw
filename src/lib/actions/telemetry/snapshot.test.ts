// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";

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

it("joins a published OpenClaw configuration to its operation target (#12859)", async () => {
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
  expect(read).toHaveBeenCalledTimes(6);
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
      },
    ],
  });
  expect(event.parameters.configurations[0].agents[0].models[0].modelId).toBe("other");
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

async function collectNativeConfiguration(agent: string, configPath: string, rawConfig: string) {
  mocks.readRegistry.mockReturnValue({
    defaultSandbox: null,
    sandboxes: {
      native: { name: "native", agent, gatewayPort: 8080 },
    },
  });
  const responses: Record<string, string> = {
    [JSON.stringify(["uname", "-s"])]: "Linux",
    [JSON.stringify(["cat", configPath])]: rawConfig,
  };
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
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxName: "native", command: ["cat", configPath] }),
    expect.objectContaining({ workspace: "native" }),
  );
  expect(read).toHaveBeenCalledTimes(2);
  return event;
}

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
