// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import type { OpenShellSandboxBufferedCommandRequest } from "../../adapters/openshell/sandbox-command";
import type { SandboxEntry } from "../../state/registry/types";

const mocks = vi.hoisted(() => ({ registry: vi.fn(), reader: vi.fn(), selection: vi.fn() }));
vi.mock("../../state/gateway-registry", async (original) => ({
  ...(await original<typeof import("../../state/gateway-registry")>()),
  listGatewayStateRoots: () => [{ root: "/unused", gatewayPort: 8080 }],
  readGatewayRegistryFile: mocks.registry,
}));
vi.mock("./native-reader", async (original) => ({
  ...(await original<typeof import("./native-reader")>()),
  createSupervisedSandboxCommandReader: mocks.reader,
}));
vi.mock("../sandbox/mcp-bridge-provider-inspection", () => ({
  getMcpProviderInspectionRuntimeSelection: mocks.selection,
}));

import { collectOperationSnapshot } from "./snapshot";
import { CollectionDiagnostics, parseCollectionDiagnostics } from "./diagnostics";
import { NativeTelemetryReadError } from "./native-reader";
import type { OpenShellInferenceRouteResult } from "../../adapters/openshell/inference-route";
import { collectOperationEvent } from "./send";
import { nativeArtifactWorkloadReceiptFixture } from "../../onboard/workload/native-artifact-test-fixture";
import { managedWorkload } from "../../domain/config/export-source-test-fixture";
import { isOperationEvent } from "../../domain/telemetry/schema";

const config = {
  agents: {
    defaults: { model: "openai/gpt-4o" },
    entries: { main: { default: true }, worker: { model: "anthropic/claude-sonnet-4-5" } },
  },
  models: {
    providers: { openai: { api: "openai-completions" }, anthropic: { api: "anthropic-messages" } },
  },
};
const roster = JSON.stringify([
  { id: "main", isDefault: true },
  { id: "worker", isDefault: false },
]);

function fixture(
  rawConfig: string | Error = JSON.stringify(config),
  rawRoster: string | Error = roster,
  overrides: Partial<SandboxEntry> = {},
) {
  mocks.registry.mockReturnValue({
    sandboxes: { selected: { name: "selected", agent: "openclaw", ...overrides } },
  });
  const read = vi.fn(async ({ command }: OpenShellSandboxBufferedCommandRequest) => {
    const value = command[0] === "uname" ? "Linux" : command[0] === "cat" ? rawConfig : rawRoster;
    return value instanceof Error ? Promise.reject(value) : value;
  });
  const route = vi.fn<() => Promise<OpenShellInferenceRouteResult>>(async () => ({
    ok: true,
    value: { state: "configured", route: { model: "route-only", provider: "openai-api" } },
  }));
  const dispose = vi.fn();
  mocks.reader.mockReturnValue({ read, observeInferenceRoute: route, dispose });
  return { read, route, dispose };
}

beforeEach(() => {
  mocks.registry.mockReset();
  mocks.reader.mockReset();
  mocks.selection.mockReset().mockReturnValue({ gatewayName: "nemoclaw", workspace: "default" });
});

async function event(diagnostics?: CollectionDiagnostics) {
  const result = await collectOperationEvent(
    {
      operation: "sandbox_rebuild",
      startedAt: "2026-11-03T00:00:00.000Z",
      completedAt: "2026-11-03T00:00:01.000Z",
      outcome: "unverified",
      state: "applied",
      scope: "sandbox",
      installedVersion: "1.2.3",
      targets: [
        {
          sandboxName: "selected",
          gatewayName: "nemoclaw",
          scope: "sandbox",
          outcome: "unverified",
          state: "applied",
        },
      ],
    },
    { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, diagnostics },
  );
  expect(isOperationEvent(result)).toBe(true);
  expect(result.parameters.outcome).toBe("unverified");
  return result.parameters;
}

it("reports models from valid native OpenClaw JSON5", async () => {
  fixture(`// native configuration\n${JSON.stringify(config)}`);
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    agents: [
      {
        modelsStatus: "reported",
        models: [{ modelId: "gpt-4o", providerProfile: "openai", apiFamily: "openai-completions" }],
      },
      {
        modelsStatus: "reported",
        models: [
          {
            modelId: "claude-sonnet-4-5",
            providerProfile: "anthropic",
            apiFamily: "anthropic-messages",
          },
        ],
      },
    ],
  });
});

it.each(["entries", "list"])(
  "preserves the explicit %s roster and same-agent models when the roster command fails",
  async (shape) => {
    const agents = {
      defaults: config.agents.defaults,
      [shape]:
        shape === "entries"
          ? config.agents.entries
          : [
              { id: "main", default: true },
              { id: "worker", model: "anthropic/claude-sonnet-4-5" },
            ],
    };
    fixture(JSON.stringify({ ...config, agents }), new Error("private command failure"));
    const result = await event();
    expect(result.configuredAgentCount).toBe(2);
    expect(result.countsStatus).toBe("reported");
    expect(result.configurations[0]).toMatchObject({
      status: "collection_error",
      agentsStatus: "reported",
      agents: [
        { models: [{ modelId: "gpt-4o", assignment: "primary" }] },
        { models: [{ modelId: "claude-sonnet-4-5", assignment: "override" }] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private command failure");
  },
);

it.each([
  "{",
  '{"agents":[]}',
  '{"agents":{"defaults":[]}}',
  '{"agents":{"entries":[]}}',
  '{"agents":{"list":[42]}}',
])("preserves a successful runtime roster when config is invalid: %s", async (raw) => {
  fixture(raw);
  const result = await event();
  expect(result.configuredAgentCount).toBe(2);
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    defaultAgentModel: { status: "collection_error" },
    agents: [
      { modelsStatus: "collection_error", models: [{ modelStatus: "collection_error" }] },
      { modelsStatus: "collection_error", models: [{ modelStatus: "collection_error" }] },
    ],
  });
});

it("preserves route, OS, harness and roster when config cannot be read", async () => {
  fixture(new Error("private unreadable config"));
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentHarnessId: "openclaw",
    agentHarnessStatus: "reported",
    sandboxOS: "linux",
    sandboxOSStatus: "reported",
    agentsStatus: "reported",
    currentInferenceRouteStatus: "reported",
    currentInferenceRoute: { modelId: "route-only" },
  });
  expect(result.configurations[0].agents).toHaveLength(2);
  expect(result.collectionStatus).toBe("partial");
});

it("does not turn defaults or a gateway route into a roster", async () => {
  fixture(JSON.stringify({ agents: { defaults: config.agents.defaults } }), new Error("no roster"));
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "collection_error",
    agents: [],
    currentInferenceRouteStatus: "reported",
  });
});

it.each(["", "not-json", '[{"id":"main"},{"id":"main"}]', '[{"name":"private-name"}]'])(
  "rejects an invalid runtime roster when explicit membership is absent: %s",
  async (rawRoster) => {
    fixture(JSON.stringify({ agents: { defaults: config.agents.defaults } }), rawRoster);
    const result = await event();
    expect(result.configurations[0]).toMatchObject({
      agentsStatus: "collection_error",
      agents: [],
    });
  },
);

it("distinguishes an observed empty runtime roster from a read failure", async () => {
  fixture(new Error("unreadable"), "[]");
  const result = await event();
  expect(result.configuredAgentCount).toBe(0);
  expect(result.configurations[0]).toMatchObject({
    status: "collection_error",
    agentsStatus: "reported",
    agents: [],
    defaultAgentModel: { status: "not_configured" },
  });
});

it("does not invent an agent for an explicit empty configured roster", async () => {
  fixture(JSON.stringify({ agents: { entries: {} } }), new Error("no CLI"));
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    agents: [],
    defaultAgentModel: { status: "not_configured" },
  });
});

it("reports an absent configured model without claiming a collection failure", async () => {
  fixture(
    JSON.stringify({ agents: { entries: { main: {} } } }),
    '[{"id":"main","isDefault":true}]',
  );
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    defaultAgentModel: { status: "not_configured" },
    agents: [
      {
        modelsStatus: "reported",
        models: [{ modelStatus: "not_configured", providerStatus: "not_configured" }],
      },
    ],
  });
});

it("keeps a stopped target's registry identity and independently observed gateway route", async () => {
  fixture(new Error("target stopped"), new Error("target stopped"));
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentHarnessId: "openclaw",
    agentHarnessStatus: "reported",
    agentsStatus: "collection_error",
    agents: [],
    currentInferenceRoute: { modelId: "route-only" },
    currentInferenceRouteStatus: "reported",
  });
});

it.each(["missing binding", "authority drift"])(
  "does not inspect a runtime when authority resolution fails: %s",
  async (reason) => {
    const reader = fixture();
    mocks.selection.mockImplementation(() => {
      throw new Error(reason);
    });
    const result = await event();
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.route).not.toHaveBeenCalled();
    expect(result.configurations[0]).toMatchObject({
      agentHarnessStatus: "reported",
      agentsStatus: "collection_error",
      agents: [],
    });
    expect(reader.dispose).toHaveBeenCalledOnce();
  },
);

it("keeps OS and route observations for a harness without a native parser", async () => {
  const reader = fixture("{}", "[]", { agent: "custom-harness" });
  const result = await event();
  expect(reader.read).toHaveBeenCalledTimes(1);
  expect(result.configurations[0]).toMatchObject({
    agentHarnessId: "custom-harness",
    agentsStatus: "not_observed",
    sandboxOSStatus: "reported",
    currentInferenceRouteStatus: "reported",
  });
});

it("leaves inactive native-artifact receipts unobserved without runtime reads", async () => {
  const reader = fixture("{}", "[]", {
    workload: nativeArtifactWorkloadReceiptFixture(managedWorkload().encodedProfile),
  });
  const result = await event();
  expect(reader.read).not.toHaveBeenCalled();
  expect(reader.route).not.toHaveBeenCalled();
  expect(result.configurations[0]).toMatchObject({
    state: "unavailable",
    agentsStatus: "not_observed",
    agents: [],
    currentInferenceRouteStatus: "not_observed",
  });
});

it("preserves completed config observations across concurrent cancellation and ignores late results", async () => {
  const reader = fixture();
  mocks.registry.mockReturnValue({
    sandboxes: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `sandbox${i}`,
        { name: `sandbox${i}`, agent: "openclaw" },
      ]),
    ),
  });
  const late: Array<(raw: string) => void> = [];
  reader.read.mockImplementation(async ({ command }) => {
    const settled: Record<string, string> = { cat: JSON.stringify(config), uname: "Linux" };
    return settled[command[0]] ?? new Promise<string>((resolve) => late.push(resolve));
  });
  const controller = new AbortController();
  const diagnostics = new CollectionDiagnostics();
  const pending = collectOperationSnapshot({
    signal: controller.signal,
    deadlineAt: Date.now() + 10_000,
    diagnostics,
  });
  await vi.waitFor(() => expect(late).toHaveLength(4));
  controller.abort();
  const result = await pending;
  expect(result.configurations.slice(0, 4).map((row) => row.agents.length)).toEqual([2, 2, 2, 2]);
  expect(result.configurations.slice(4).every((row) => row.agentsStatus === "not_observed")).toBe(
    true,
  );
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toMatchObject({
    "roster_read.cancelled": 4,
    "runtime.not_started_cancelled": 5,
    "roster.config_recovered": 4,
  });
  const diagnosticBefore = diagnostics.serialize();
  const before = JSON.stringify(result);
  late.forEach((resolve) => resolve("[]"));
  await Promise.resolve();
  await Promise.resolve();
  expect(JSON.stringify(result)).toBe(before);
  expect(diagnostics.serialize()).toBe(diagnosticBefore);
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("preserves a settled roster when config stalls until the shared deadline", async () => {
  const reader = fixture();
  reader.read.mockImplementation(async ({ command }) =>
    command[0] === "cat"
      ? new Promise<string>(() => {})
      : command[0] === "uname"
        ? "Linux"
        : roster,
  );
  const result = await collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 50,
  });
  expect(result.configuredAgentCount).toBe(2);
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    sandboxOSStatus: "reported",
    currentInferenceRouteStatus: "reported",
    agents: [{ modelsStatus: "collection_error" }, { modelsStatus: "collection_error" }],
  });
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("preserves completed native models when route and OS reads exceed the deadline", async () => {
  const reader = fixture();
  reader.read.mockImplementation(async ({ command }) =>
    command[0] === "uname"
      ? new Promise<string>(() => {})
      : command[0] === "cat"
        ? JSON.stringify(config)
        : roster,
  );
  reader.route.mockImplementation(() => new Promise(() => {}));
  const result = await collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 50,
  });
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    sandboxOSStatus: "collection_error",
    currentInferenceRouteStatus: "collection_error",
    agents: [{ models: [{ modelId: "gpt-4o" }] }, { models: [{ modelId: "claude-sonnet-4-5" }] }],
  });
  expect(result.collectionStatus).toBe("partial");
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("stops concurrent reads at the shared deadline and retains completed explicit membership", async () => {
  const reader = fixture();
  mocks.registry.mockReturnValue({
    sandboxes: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `sandbox${i}`,
        { name: `sandbox${i}`, agent: "openclaw" },
      ]),
    ),
  });
  reader.read.mockImplementation(async ({ command }) =>
    command[0] === "cat"
      ? JSON.stringify(config)
      : command[0] === "uname"
        ? "Linux"
        : new Promise<string>(() => {}),
  );
  const diagnostics = new CollectionDiagnostics();
  const result = await collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 50,
    diagnostics,
  });
  expect(reader.read).toHaveBeenCalledTimes(12);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toMatchObject({
    "roster_read.deadline": 4,
    "runtime.not_started_deadline": 5,
    "roster.config_recovered": 4,
  });
  expect(result.configurations.slice(0, 4).map((row) => row.agents.length)).toEqual([2, 2, 2, 2]);
  expect(result.configurations.slice(4).every((row) => row.agentsStatus === "not_observed")).toBe(
    true,
  );
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("does not read any target after cancellation before collection", async () => {
  const reader = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await collectOperationSnapshot({
    signal: controller.signal,
    deadlineAt: Date.now() + 100,
  });
  expect(reader.read).not.toHaveBeenCalled();
  expect(reader.route).not.toHaveBeenCalled();
  expect(result.collectionStatus).toBe("collection_error");
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("observes a custom image's native config without claiming a managed version", async () => {
  fixture(JSON.stringify(config), roster, {
    imageTag: `example/custom@sha256:${"a".repeat(64)}`,
    workload: {
      schemaVersion: 1,
      kind: "external-image",
      reference: `example/custom@sha256:${"a".repeat(64)}`,
      platform: "linux/arm64",
      runtimeImageContentId: `sha256:${"b".repeat(64)}`,
      shared: true,
    },
  });
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    settings: { imageOwnership: "custom", imageOwnershipStatus: "reported" },
    managedAgentVersionStatus: "not_applicable",
    agents: [
      { managedAgentVersionStatus: "not_applicable", models: [{ modelId: "gpt-4o" }] },
      { managedAgentVersionStatus: "not_applicable", models: [{ modelId: "claude-sonnet-4-5" }] },
    ],
  });
});

it("does not join a removed target to an unrelated published configuration", async () => {
  fixture();
  mocks.registry.mockReturnValue({
    sandboxes: { survivor: { name: "survivor", agent: "openclaw" } },
  });
  const result = await event();
  expect(result.targetResults).toMatchObject([
    { configurationPosition: -1, configurationStatus: "unavailable" },
  ]);
  expect(result.configurations).toHaveLength(1);
});

it.each([
  { agents: { entries: { main: { id: "other" } } } },
  { agents: { list: [{ id: "main" }, { id: "main" }] } },
  { agents: { entries: { "invalid id": {} } } },
  { agents: { entries: [] } },
])("does not recover membership from malformed explicit config: %j", async (invalid) => {
  fixture(JSON.stringify(invalid), new Error("roster unavailable"));
  const result = await event();
  expect(result.configurations[0]).toMatchObject({ agentsStatus: "collection_error", agents: [] });
});

it("does not invent a default selection from multiple explicit agents after roster failure", async () => {
  fixture(
    JSON.stringify({ ...config, agents: { ...config.agents, ownership: "explicit" } }),
    new Error("roster unavailable"),
  );
  const result = await event();
  expect(result.configurations[0]).toMatchObject({
    agentsStatus: "reported",
    defaultAgentModel: { agentPosition: -1, modelPosition: -1, status: "collection_error" },
  });
});

it("retains same-agent fallback and subagent assignments after roster failure", async () => {
  fixture(
    JSON.stringify({
      ...config,
      agents: {
        defaults: {
          model: { primary: "openai/gpt-4o", fallbacks: ["anthropic/claude-sonnet-4-5"] },
          subagents: { model: "openai/gpt-4o-mini" },
        },
        entries: {
          main: {},
          worker: {
            model: "anthropic/claude-sonnet-4-5",
            subagents: { model: "anthropic/claude-haiku-4-5" },
          },
        },
      },
    }),
    new Error("roster unavailable"),
  );
  const result = await event();
  expect(
    result.configurations[0].agents.map((agent) =>
      agent.models.map(({ assignment, modelId }) => ({ assignment, modelId })),
    ),
  ).toEqual([
    [
      { assignment: "primary", modelId: "gpt-4o" },
      { assignment: "fallback", modelId: "claude-sonnet-4-5" },
      { assignment: "subagent", modelId: "gpt-4o-mini" },
    ],
    [
      { assignment: "override", modelId: "claude-sonnet-4-5" },
      { assignment: "fallback", modelId: "claude-sonnet-4-5" },
      { assignment: "subagent", modelId: "claude-haiku-4-5" },
    ],
  ]);
});

it("counts a failed native roster read and config recovery without exposing private context", async () => {
  fixture(JSON.stringify(config), new NativeTelemetryReadError("nonzero_exit"));
  const diagnostics = new CollectionDiagnostics();
  const result = await event(diagnostics);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toMatchObject({
    "roster_read.nonzero_exit": 1,
    "roster.config_recovered": 1,
  });
  expect(result.configurations[0].agents).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain("diagnostics");
  expect(diagnostics.serialize()).not.toContain("selected");
  expect(diagnostics.serialize()).not.toContain("gpt-4o");
});

it("distinguishes config and roster parse failures from native read failures", async () => {
  fixture("{", "malformed-private-roster");
  const diagnostics = new CollectionDiagnostics();
  await event(diagnostics);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toEqual({
    "config_parse.invalid": 1,
    "roster_parse.invalid": 1,
    "agents_projection.unresolved": 1,
  });
  expect(diagnostics.serialize()).not.toContain("private");
});

it("counts a shared failed route attempt once across multiple configurations", async () => {
  const reader = fixture();
  reader.route.mockResolvedValue({
    ok: false,
    error: { kind: "authentication", message: "private gateway error" },
  });
  mocks.registry.mockReturnValue({
    sandboxes: {
      first: { name: "first", agent: "openclaw" },
      second: { name: "second", agent: "openclaw" },
    },
  });
  const diagnostics = new CollectionDiagnostics();
  const result = await event(diagnostics);
  expect(reader.route).toHaveBeenCalledOnce();
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toEqual({
    "route_observation.authentication": 1,
  });
  expect(result.configurations.every((row) => row.agentsStatus === "reported")).toBe(true);
  expect(diagnostics.serialize()).not.toContain("private gateway error");
});

it("keeps inventory failures separate from runtime authority failures", async () => {
  fixture();
  mocks.registry.mockImplementation(() => {
    throw new Error("private registry path");
  });
  const inventory = new CollectionDiagnostics();
  await event(inventory);
  expect(parseCollectionDiagnostics(inventory.serialize())).toEqual({ "inventory.failed": 1 });
  fixture();
  mocks.selection.mockImplementation(() => {
    throw new Error("private authority detail");
  });
  const authority = new CollectionDiagnostics();
  await event(authority);
  expect(parseCollectionDiagnostics(authority.serialize())).toEqual({
    "runtime_authority.failed": 1,
  });
});

it("records unsupported parsers as expected skips without a failure category", async () => {
  fixture("{}", "[]", { agent: "custom-harness" });
  const diagnostics = new CollectionDiagnostics();
  await event(diagnostics);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toEqual({
    "runtime.unsupported_parser": 1,
  });
});

it("does not change remote event fields when local diagnostics are requested", async () => {
  fixture();
  const ordinary = await event();
  fixture();
  const diagnostics = new CollectionDiagnostics();
  const observed = await event(diagnostics);
  expect(observed).toEqual(ordinary);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toEqual({});
});
