// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProviderCommandRuntimeHooksForTest } from "../../adapters/openshell/provider-command";

const mocks = vi.hoisted(() => ({
  applyGeneratedPolicy: vi.fn(),
  assertMutationCapabilities: vi.fn(),
  attachProvider: vi.fn(),
  register: vi.fn(),
  inspectAdapter: vi.fn(),
  reloadHermes: vi.fn(),
  unregister: vi.fn(),
  observe: vi.fn(),
  wait: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  status: vi.fn(),
  inspectSources: vi.fn(),
  preflightTargets: vi.fn(),
  getBridgeAdapter: vi.fn(),
  getSandboxAgent: vi.fn(),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => ({
  withMcpLifecycleLock: async (_name: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../../onboard/experimental/portable-agent-lifecycle", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
}));
vi.mock("./mcp-bridge-adapters", () => ({
  inspectAgentAdapterRegistration: mocks.inspectAdapter,
  reloadHermesGatewayAfterMcpRestart: mocks.reloadHermes,
  registerAgentAdapterAtCurrentCredentialRevision: mocks.register,
  unregisterAgentAdapter: mocks.unregister,
  reloadOpenClawGatewayAfterMcpMutation: mocks.reload,
}));
vi.mock("./mcp-bridge-policy", () => ({
  applyGeneratedPolicy: mocks.applyGeneratedPolicy,
  assertGeneratedPolicyMutationSafe: vi.fn(),
}));
vi.mock("./mcp-bridge-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider")>()),
  assertMcpProviderRecoverable: vi.fn(() => ({ exists: true })),
  assertNoAttachedProviderCredentialCollisions: vi.fn(),
  assertNoProviderCredentialCollisions: vi.fn(),
  attachProvider: mocks.attachProvider,
  detachMissingProviderReference: vi.fn(),
  ensureMcpBridgeProviderProfile: vi.fn(),
  getMcpProviderInspectionRuntimeSelection: vi.fn(() => ({
    gatewayName: "nemoclaw",
    workspace: "default",
  })),
  observeMcpCredentialRevision: mocks.observe,
  preflightMcpEntryTargets: mocks.preflightTargets,
  refreshMcpProviderEnvironment: mocks.refresh,
  upsertMcpProvider: vi.fn(),
  waitForAttachedMcpCredential: mocks.wait,
  waitForDetachedMcpCredential: vi.fn(),
}));
vi.mock("./mcp-bridge-runtime-capabilities", () => ({
  assertMcpAdapterMutationRuntimeCapabilities: mocks.assertMutationCapabilities,
  assertMcpAdapterTeardownRuntimeCapabilities: vi.fn(),
}));
vi.mock("./mcp-bridge-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-state")>()),
  ensureSandboxGatewaySelected: vi.fn(),
  getBridgeAdapter: mocks.getBridgeAdapter,
  getSandboxAgent: mocks.getSandboxAgent,
  getSandboxOrThrow: vi.fn(() => ({ name: "alpha", agent: "openclaw" })),
}));
vi.mock("./mcp-bridge-source", () => ({
  inspectSourceBridgeState: mocks.inspectSources,
}));
vi.mock("./mcp-bridge-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-status")>()),
  statusMcpBridge: mocks.status,
}));
vi.mock("./mcp-bridge-validation", () => ({
  assertAuthenticatedBridgeEntry: vi.fn(),
  assertMcpCredentialBoundaryRuntimeVersion: vi.fn(),
  resolveCredentialEnv: vi.fn(() => ({})),
  validateSandboxName: vi.fn(),
}));

import {
  assertNoAttachedProviderCredentialCollisions,
  assertNoProviderCredentialCollisions,
} from "./mcp-bridge-provider";
import {
  assertNoAttachedProviderCredentialCollisions as realAssertNoAttachedProviderCredentialCollisions,
  assertNoProviderCredentialCollisions as realAssertNoProviderCredentialCollisions,
} from "./mcp-bridge-provider-inspection";
import { restartMcpBridge, restoreExistingMcpBridgeRuntime } from "./mcp-bridge-restart";

const entries = ["first", "second"].map((server) => ({
  server,
  agent: "openclaw",
  adapter: "openclaw-config" as const,
  url: `https://${server}.example.test/mcp`,
  env: [`${server.toUpperCase()}_TOKEN`],
  allowedIps: [server === "first" ? "1.1.1.1" : "8.8.8.8"],
  providerName: `alpha-mcp-${server}`,
  providerId: `${server}-provider-id`,
  policyName: `mcp-bridge-${server}`,
  source: "native" as const,
}));

describe("OpenClaw MCP partial-mutation recovery", () => {
  afterEach(() => {
    setProviderCommandRuntimeHooksForTest({});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyGeneratedPolicy.mockReset();
    mocks.assertMutationCapabilities.mockReset().mockResolvedValue(undefined);
    mocks.attachProvider.mockReset();
    vi.mocked(assertNoAttachedProviderCredentialCollisions).mockReset();
    vi.mocked(assertNoProviderCredentialCollisions).mockReset();
    mocks.observe.mockReset().mockResolvedValue("v1");
    mocks.inspectAdapter.mockReset().mockResolvedValue({ state: "registered" });
    mocks.reloadHermes.mockReset();
    mocks.getBridgeAdapter.mockReset().mockReturnValue("openclaw-config");
    mocks.getSandboxAgent.mockReset().mockReturnValue({
      name: "openclaw",
      mcpCapability: { support: "bridge", adapter: "openclaw-config" },
    });
    mocks.wait.mockReset().mockResolvedValue("v1");
    mocks.refresh.mockReset();
    mocks.unregister.mockReset();
    mocks.reload.mockReset();
    mocks.inspectSources.mockReturnValue({
      bridges: Object.fromEntries(entries.map((entry) => [entry.server, entry])),
      sources: {
        native: Object.fromEntries(entries.map((entry) => [entry.server, entry])),
        legacy: {},
      },
    });
    mocks.status.mockResolvedValue([
      {
        policy: { present: true },
        provider: { present: true, attached: true, credentialReady: true },
      },
    ]);
    mocks.preflightTargets.mockResolvedValue(
      new Map(entries.map((entry) => [entry.server, { addresses: entry.allowedIps }])),
    );
    mocks.register.mockImplementation(
      (_sandbox: string, _adapter: string, entry: { server: string }) => {
        const fail =
          entry.server === "second"
            ? () => {
                throw new Error("post-write verification failed");
              }
            : () => undefined;
        fail();
      },
    );
  });

  it("removes an unauthorized restored adapter before reloading and rejecting", async () => {
    const events: string[] = [];
    const handle = `s${"a".repeat(64)}`;
    mocks.observe.mockResolvedValue(handle);
    mocks.wait.mockResolvedValue(handle);
    mocks.refresh.mockImplementation(() => {
      events.push("refresh");
    });
    mocks.status.mockImplementation(async () => {
      events.push("probe");
      return [
        {
          provider: {
            credentialResolution: {
              ok: null,
              httpStatus: 401,
              controlHttpStatus: 401,
              detail: "updated credential remained unauthorized",
            },
          },
        },
      ];
    });
    mocks.unregister.mockImplementation(async () => {
      events.push("unregister");
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("removed");
      return "removed";
    });
    mocks.reload.mockImplementation(() => {
      events.push("reload");
    });

    await expect(restoreExistingMcpBridgeRuntime("alpha", [entries[0]])).rejects.toThrow(
      "did not authorize its unchanged stable credential handle after provider update",
    );
    expect(events).toEqual(["refresh", "probe", "unregister", "removed", "reload"]);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith("alpha", "first", {
      allowCredentialProbeWithAdapterMismatch: true,
      probeCredentialResolution: true,
      runtimeSelection: { gatewayName: "nemoclaw", workspace: "default" },
    });
  });

  it("reloads every attempted OpenClaw restart mutation before propagating failure", async () => {
    await expect(restartMcpBridge("alpha")).rejects.toThrow("post-write verification failed");

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledWith("alpha", ["openclaw-config", "openclaw-config"], {
      gatewayName: "nemoclaw",
      workspace: "default",
    });
  });

  it("restarts an unchanged Hermes adapter through the authenticated supervisor", async () => {
    const hermesEntry = {
      ...entries[0],
      agent: "hermes",
      adapter: "hermes-config" as const,
    };
    mocks.getBridgeAdapter.mockReturnValue("hermes-config");
    mocks.getSandboxAgent.mockReturnValue({
      name: "hermes",
      mcpCapability: { support: "bridge", adapter: "hermes-config" },
    });
    mocks.inspectSources.mockReturnValue({
      bridges: { first: hermesEntry },
      sources: { native: { first: hermesEntry }, legacy: {} },
    });
    mocks.register.mockReset();

    await restartMcpBridge("alpha", "first");

    expect(mocks.inspectAdapter).toHaveBeenCalledWith(
      "alpha",
      "hermes-config",
      hermesEntry,
      { gatewayName: "nemoclaw", workspace: "default" },
      "v1",
    );
    expect(mocks.reloadHermes).toHaveBeenCalledWith("alpha");
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("reloads every attempted OpenClaw restoration mutation before propagating failure", async () => {
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "recorded-workspace",
      localTlsDir: "/recorded/tls",
    };
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    await expect(
      restoreExistingMcpBridgeRuntime("alpha", entries, { runtimeSelection }),
    ).rejects.toThrow("post-write verification failed");

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledWith(
      "alpha",
      ["openclaw-config", "openclaw-config"],
      runtimeSelection,
    );
  });

  it("reloads successful restoration using its recorded runtime", async () => {
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      workspace: "recorded-workspace",
      localTlsDir: "/recorded/tls",
    };
    vi.stubEnv("OPENSHELL_GATEWAY", "other-gateway");
    mocks.register.mockReset().mockResolvedValue(undefined);
    await restoreExistingMcpBridgeRuntime("alpha", entries, { runtimeSelection });
    expect(mocks.reload).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      ["openclaw-config", "openclaw-config"],
      runtimeSelection,
    );
  });

  it("requires current Hermes mutation capability before replacement restore", async () => {
    const hermesEntry = {
      ...entries[0],
      agent: "hermes",
      adapter: "hermes-config" as const,
    };
    mocks.getBridgeAdapter.mockReturnValue("hermes-config");
    mocks.getSandboxAgent.mockReturnValue({
      name: "hermes",
      mcpCapability: { support: "bridge", adapter: "hermes-config" },
    });
    mocks.register.mockReset().mockResolvedValue("v1");

    await restoreExistingMcpBridgeRuntime("alpha", [hermesEntry]);

    expect(mocks.assertMutationCapabilities).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ name: "alpha" }),
      [hermesEntry],
      { gatewayName: "nemoclaw", workspace: "default" },
    );
    expect(mocks.register).toHaveBeenCalledOnce();
  });

  it("rejects an ambiguous recovery batch before target preflight or mutation", async () => {
    const ambiguousEntries = [
      entries[0],
      {
        ...entries[1],
        url: entries[0].url,
      },
    ];

    await expect(restoreExistingMcpBridgeRuntime("alpha", ambiguousEntries)).rejects.toThrow(
      /cannot safely choose between credentials for an indistinguishable endpoint/,
    );

    expect(mocks.preflightTargets).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it("enforces the 32-provider attachment limit before restore mutations and allows an already attached provider", async () => {
    const firstId = "11111111-2222-4333-8444-555555555555";
    const firstEntry = { ...entries[0], providerId: firstId };
    let targetAlreadyAttached = false;
    setProviderCommandRuntimeHooksForTest({
      runOpenshell: ((args: string[]) => {
        const names = Array.from({ length: 32 }, (_, index) =>
          index === 0 && targetAlreadyAttached
            ? "alpha-mcp-first"
            : `alpha-mcp-srv${String(index)}`,
        );
        const listStdout = [
          "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
          ...names.map((name) => `${name} nemoclaw-mcp-v1 1 0`),
        ].join("\n");
        const providerName = args[2] ?? "alpha-mcp-srv0";
        const isFirst = providerName === "alpha-mcp-first";
        const providerStdout = [
          `Name: ${providerName}`,
          `Id: ${isFirst ? firstId : "00000000-0000-4000-8000-000000000099"}`,
          "Type: nemoclaw-mcp-v1",
          "Resource version: 1",
          `Credential keys: ${isFirst ? "FIRST_TOKEN" : `OTHER_${providerName.toUpperCase().replaceAll("-", "_")}`}`,
          "Config keys: <none>",
        ].join("\n");
        return {
          status: 0,
          stdout: args[0] === "sandbox" ? listStdout : providerStdout,
          stderr: "",
        };
      }) as never,
    });
    vi.mocked(assertNoProviderCredentialCollisions).mockImplementation(
      realAssertNoProviderCredentialCollisions,
    );
    vi.mocked(assertNoAttachedProviderCredentialCollisions).mockImplementation(
      realAssertNoAttachedProviderCredentialCollisions,
    );
    mocks.register.mockReset().mockResolvedValue(undefined);

    await expect(restoreExistingMcpBridgeRuntime("alpha", [firstEntry])).rejects.toThrow(
      "Sandbox 'alpha' already has 32 attached OpenShell providers",
    );
    expect(mocks.applyGeneratedPolicy).not.toHaveBeenCalled();
    expect(mocks.attachProvider).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();

    targetAlreadyAttached = true;
    await expect(restoreExistingMcpBridgeRuntime("alpha", [firstEntry])).resolves.toBeUndefined();
    expect(mocks.attachProvider).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledOnce();
  });
});
