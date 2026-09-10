// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpSourceEntry } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  executeSandboxExecCommand: vi.fn(),
  executeGatewaySupervisorAction: vi.fn(),
  getSandbox: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  readSandboxConfig: vi.fn(),
  resolveAgentConfig: vi.fn(),
  restartSandboxGateway: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
  waitForManagedGatewaySupervisor: vi.fn(),
  writeSandboxConfig: vi.fn(),
  waitForMcpBridgeCondition: vi.fn((condition: () => boolean) =>
    Array.from({ length: 12 }).some(() => condition()),
  ),
  waitForMcpBridgeConditionAsync: vi.fn(async (condition: () => Promise<boolean>) => {
    const attempt = async (remaining: number): Promise<boolean> =>
      remaining === 0 ? false : (await condition()) || attempt(remaining - 1);
    return attempt(12);
  }),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
  restartSandboxGateway: mocks.restartSandboxGateway,
  waitForManagedGatewaySupervisor: mocks.waitForManagedGatewaySupervisor,
}));

vi.mock("../../sandbox/config", () => ({
  readSandboxConfig: mocks.readSandboxConfig,
  resolveAgentConfig: mocks.resolveAgentConfig,
  writeSandboxConfig: mocks.writeSandboxConfig,
}));

vi.mock("../../adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

vi.mock("../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

vi.mock("./mcp-bridge-provider-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-bridge-provider-readiness")>()),
  observeMcpCredentialRevision: mocks.observeMcpCredentialRevision,
}));

vi.mock("./mcp-bridge/timing", () => ({
  waitForMcpBridgeCondition: mocks.waitForMcpBridgeCondition,
  waitForMcpBridgeConditionAsync: mocks.waitForMcpBridgeConditionAsync,
}));

import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  registerAgentAdapter,
  registerAgentAdapterAtCurrentCredentialRevision,
  reloadOpenClawGatewayAfterMcpMutation,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { registerOpenClawAdapter } from "./mcp-bridge-adapter-openclaw";
import { entryHeaders, openClawHeadersMatchExpected } from "./mcp-bridge-adapter-status";

const baseEntry: McpSourceEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
};

const lifecycleSuccess = {
  status: 0,
  stdout: '{"changed":true,"ok":true,"reloaded":true}\n',
  stderr: "",
};

const commandSuccess = { status: 0, stdout: "", stderr: "" };
const registered = { status: 0, stdout: "registered\n", stderr: "" };
const mismatch = { status: 0, stdout: "mismatch\n", stderr: "" };
const sandbox = { name: "alpha", agent: "hermes", gatewayName: "nemoclaw-8091" };
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };

function resetOpenClawConfigMocks(): void {
  mocks.readSandboxConfig.mockReset().mockReturnValue({
    plugins: { allow: ["nemoclaw"] },
    tools: { toolSearch: { mode: "tools" } },
  });
  mocks.resolveAgentConfig.mockReset().mockReturnValue({
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
  });
  mocks.waitForManagedGatewaySupervisor.mockReset().mockReturnValue(true);
  mocks.writeSandboxConfig.mockReset();
}

interface AdapterCase {
  name: string;
  adapter: AgentMcpAdapter;
  entry: McpSourceEntry;
  arrangeInspection: (result: typeof registered) => void;
  statusCommand: (entry: McpSourceEntry) => string;
}

const adapterCases: AdapterCase[] = [
  {
    name: "Hermes",
    adapter: "hermes-config",
    entry: baseEntry,
    arrangeInspection: (result) => {
      mocks.runOpenshellProviderCommand.mockReturnValue(lifecycleSuccess);
      mocks.executeSandboxCommand.mockReturnValue(result);
    },
    statusCommand: buildHermesMcpStatusCommand,
  },
  {
    name: "Deep Agents",
    adapter: "deepagents-config",
    entry: {
      ...baseEntry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
    },
    arrangeInspection: (result) => {
      mocks.executeSandboxCommand.mockReturnValueOnce(commandSuccess).mockReturnValueOnce(result);
    },
    statusCommand: buildDeepAgentsMcpStatusCommand,
  },
];

interface ReconciliationCase {
  name: string;
  adapter: AgentMcpAdapter;
  entry: McpSourceEntry;
  arrange: () => void;
  mutationCalls: () => string;
}

const reconciliationCases: ReconciliationCase[] = [
  {
    name: "OpenClaw",
    adapter: "openclaw-config",
    entry: { ...baseEntry, agent: "openclaw", adapter: "openclaw-config" },
    arrange: () => {
      mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
        command === "command -v mcporter"
          ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
          : command.includes("config' 'add")
            ? commandSuccess
            : registered,
      );
    },
    mutationCalls: () => JSON.stringify(mocks.executeSandboxCommand.mock.calls),
  },
  {
    name: "Hermes",
    adapter: "hermes-config",
    entry: baseEntry,
    arrange: () => {
      mocks.runOpenshellProviderCommand.mockReturnValue(lifecycleSuccess);
      mocks.executeSandboxCommand.mockReturnValue(registered);
    },
    mutationCalls: () => JSON.stringify(mocks.runOpenshellProviderCommand.mock.calls),
  },
  {
    name: "Deep Agents",
    adapter: "deepagents-config",
    entry: {
      ...baseEntry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
    },
    arrange: () => {
      mocks.executeSandboxCommand
        .mockReturnValueOnce(commandSuccess)
        .mockReturnValueOnce(registered)
        .mockReturnValueOnce(commandSuccess)
        .mockReturnValueOnce(registered);
    },
    mutationCalls: () => JSON.stringify(mocks.executeSandboxCommand.mock.calls),
  },
];

describe.each(adapterCases)("$name MCP adapter registration", (adapterCase) => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.executeSandboxExecCommand.mockReset();
    mocks.executeGatewaySupervisorAction.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("re-reads the persisted definition before registration succeeds", () => {
    adapterCase.arrangeInspection(registered);

    expect(() =>
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, runtimeSelection, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).not.toThrow();

    expect(mocks.executeSandboxCommand).toHaveBeenLastCalledWith(
      "alpha",
      adapterCase.statusCommand(adapterCase.entry),
      { runtimeSelection },
    );
    expect(mocks.executeSandboxCommand.mock.calls.map((call) => call[2])).toEqual(
      Array(mocks.executeSandboxCommand.mock.calls.length).fill({ runtimeSelection }),
    );
  });

  it("rejects a persisted definition that differs from the requested entry", () => {
    adapterCase.arrangeInspection(mismatch);

    expect(() =>
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, runtimeSelection, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).toThrow(`${adapterCase.adapter} config verification failed after adding 'github': mismatch.`);
  });
});

describe("OpenClaw MCP adapter registration", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
    resetOpenClawConfigMocks();
    mocks.restartSandboxGateway.mockReset();
    mocks.writeSandboxConfig.mockReset();
  });

  it("restarts the gateway only for native OpenClaw MCP mutations", async () => {
    mocks.restartSandboxGateway.mockReturnValue({
      ok: true,
      restarted: true,
      healthPassed: true,
      forwardRecovered: true,
    });

    await reloadOpenClawGatewayAfterMcpMutation("alpha", ["openclaw-config"]);
    await reloadOpenClawGatewayAfterMcpMutation("alpha", ["hermes-config", "deepagents-config"]);

    expect(mocks.restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
    });
  });

  it("fails when the gateway cannot activate the verified config", async () => {
    mocks.restartSandboxGateway.mockReturnValue({
      ok: false,
      failureLayer: "health timeout",
      detail: "gateway process restarted but health did not pass before timeout",
    });

    await expect(
      reloadOpenClawGatewayAfterMcpMutation("alpha", ["openclaw-config"]),
    ).rejects.toThrow(
      "OpenClaw gateway did not activate the native MCP configuration (health timeout: gateway process restarted but health did not pass before timeout).",
    );
  });

  it("rejects a v11 post-write observation after registering the readiness-proven v12", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    const actualV11Headers = {
      Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
    };
    const verification = openClawHeadersMatchExpected(actualV11Headers, entryHeaders(entry, "v12"))
      ? registered
      : mismatch;
    mocks.executeSandboxCommand.mockReturnValueOnce(verification);

    expect(() =>
      registerOpenClawAdapter(
        "alpha",
        entry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        false,
        "v12",
      ),
    ).toThrow("OpenClaw MCP config verification failed after adding 'github': mismatch");

    expect(mocks.executeSandboxCommand.mock.calls[0]?.[1]).toContain(
      "openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.writeSandboxConfig).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ configPath: "/sandbox/.openclaw/openclaw.json" }),
      expect.objectContaining({
        mcp: {
          servers: {
            github: {
              transport: "streamable-http",
              url: entry.url,
              headers: { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
            },
          },
        },
        plugins: { allow: ["nemoclaw"] },
        tools: { alsoAllow: ["bundle-mcp"], toolSearch: { mode: "tools" } },
      }),
    );
  });

  it("removes the native entry through the paired config and hash transaction", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.readSandboxConfig.mockReturnValue({
      preserved: true,
      plugins: { allow: ["nemoclaw"] },
      tools: { alsoAllow: ["bundle-mcp"], toolSearch: { mode: "tools" } },
      mcp: {
        servers: {
          github: {
            transport: "streamable-http",
            url: entry.url,
            headers: { Authorization: "Bearer openshell:resolve:env:v12_GITHUB_TOKEN" },
          },
        },
      },
    });

    expect(unregisterAgentAdapter("alpha", "openclaw-config", entry, runtimeSelection)).toBe(
      "removed",
    );
    expect(mocks.writeSandboxConfig).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ configPath: "/sandbox/.openclaw/openclaw.json" }),
      {
        preserved: true,
        mcp: { servers: {} },
        plugins: { allow: ["nemoclaw"] },
        tools: { alsoAllow: ["bundle-mcp"], toolSearch: { mode: "tools" } },
      },
    );
  });

  it("adds a non-restrictive tool-policy extension when no tools block exists", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.readSandboxConfig.mockReturnValue({});
    mocks.executeSandboxCommand.mockReturnValue(registered);

    registerOpenClawAdapter("alpha", entry, runtimeSelection, {}, false, "v12");

    expect(mocks.writeSandboxConfig.mock.calls[0]?.[2]).toMatchObject({
      tools: { alsoAllow: ["bundle-mcp"] },
    });
    expect(mocks.writeSandboxConfig.mock.calls[0]?.[2]).not.toHaveProperty("plugins");
  });

  it("waits for PID 1 config authority before reading or writing OpenClaw config", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.waitForManagedGatewaySupervisor.mockReturnValue(false);

    expect(() =>
      registerOpenClawAdapter("alpha", entry, runtimeSelection, {}, false, "v12"),
    ).toThrow("OpenClaw managed gateway supervisor is not ready for config mutation");

    expect(mocks.waitForManagedGatewaySupervisor).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(mocks.readSandboxConfig).not.toHaveBeenCalled();
    expect(mocks.writeSandboxConfig).not.toHaveBeenCalled();
  });
});

describe("Deep Agents MCP adapter credential revision", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("writes and verifies the readiness-proven revision", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
    };
    mocks.executeSandboxCommand.mockReturnValueOnce(commandSuccess).mockReturnValueOnce(registered);

    expect(() =>
      registerAgentAdapter(
        "alpha",
        "deepagents-config",
        entry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        { credentialRevision: "v12" },
      ),
    ).not.toThrow();

    expect(mocks.executeSandboxCommand.mock.calls[0]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.executeSandboxCommand.mock.calls[1]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(JSON.stringify(mocks.executeSandboxCommand.mock.calls)).not.toContain(
      "host-only-secret",
    );
  });
});

describe("Hermes MCP adapter credential revision", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.executeSandboxExecCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("writes and verifies the readiness-proven revision", () => {
    mocks.runOpenshellProviderCommand.mockReturnValue(lifecycleSuccess);
    mocks.executeSandboxCommand.mockReturnValue(registered);
    mocks.executeSandboxExecCommand.mockReturnValue({
      status: 0,
      stdout: "v12\n",
      stderr: "",
    });

    expect(() =>
      registerAgentAdapter(
        "alpha",
        "hermes-config",
        baseEntry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        { credentialRevision: "v12" },
      ),
    ).not.toThrow();

    expect(JSON.stringify(mocks.runOpenshellProviderCommand.mock.calls[0]?.[0])).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.executeSandboxCommand.mock.calls[0]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(JSON.stringify(mocks.runOpenshellProviderCommand.mock.calls)).not.toContain(
      "host-only-secret",
    );
  });
});

describe.each(reconciliationCases)(
  "$name MCP credential revision reconciliation",
  (adapterCase) => {
    beforeEach(() => {
      mocks.executeSandboxCommand.mockReset();
      mocks.runOpenshellProviderCommand.mockReset();
      mocks.getSandbox.mockReset();
      mocks.getSandbox.mockReturnValue(sandbox);
      resetOpenClawConfigMocks();
      mocks.observeMcpCredentialRevision.mockReset();
      mocks.observeMcpCredentialRevision.mockResolvedValue("v12");
    });

    it("reconciles registration to a later stable revision", async () => {
      mocks.observeMcpCredentialRevision.mockResolvedValueOnce("v11");
      adapterCase.arrange();

      await expect(
        registerAgentAdapterAtCurrentCredentialRevision(
          "alpha",
          adapterCase.adapter,
          adapterCase.entry,
          runtimeSelection,
          { GITHUB_TOKEN: "host-only-secret" },
          "v11",
        ),
      ).resolves.toBe("v12");

      const mutationCalls = adapterCase.mutationCalls();
      expect(mutationCalls).toContain("openshell:resolve:env:v11_GITHUB_TOKEN");
      expect(mutationCalls).toContain("openshell:resolve:env:v12_GITHUB_TOKEN");
      expect(mutationCalls).not.toContain("host-only-secret");
    });
  },
);

describe("MCP adapter credential revision reconciliation failures", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
    mocks.observeMcpCredentialRevision.mockReset();
    resetOpenClawConfigMocks();
  });

  it("keeps one operation target after the registry target changes (#10514)", async () => {
    const operationSelection = {
      gatewayName: "nemoclaw-8091",
      localTlsDir: "/authority/gateway-8091/tls",
      workspace: "default",
    } as const;
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
      command.includes("servers[payload.server]") ? commandSuccess : registered,
    );
    mocks.observeMcpCredentialRevision.mockImplementation(async () => {
      mocks.getSandbox.mockReturnValue({
        agent: "openclaw",
        gatewayName: "foreign-gateway",
        name: "alpha",
      });
      return "v11";
    });

    await expect(
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        "openclaw-config",
        entry,
        operationSelection,
        {},
        "v11",
      ),
    ).resolves.toBe("v11");
    expect(mocks.getSandbox()).toMatchObject({ gatewayName: "foreign-gateway" });
    expect(mocks.executeSandboxCommand.mock.calls.map((call) => call[2]?.runtimeSelection)).toEqual(
      Array(mocks.executeSandboxCommand.mock.calls.length).fill(operationSelection),
    );
    expect(mocks.observeMcpCredentialRevision.mock.calls.map((call) => call[2])).toEqual(
      Array(mocks.observeMcpCredentialRevision.mock.calls.length).fill(operationSelection),
    );
  });

  it.each(["absent", "canonical"] as const)(
    "fails closed when reconciliation observes %s credential authority",
    async (observation) => {
      mocks.observeMcpCredentialRevision.mockResolvedValue(observation);
      mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
        command === "command -v mcporter"
          ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
          : command.includes("config' 'add")
            ? commandSuccess
            : registered,
      );

      await expect(
        registerAgentAdapterAtCurrentCredentialRevision(
          "alpha",
          "openclaw-config",
          { ...baseEntry, agent: "openclaw", adapter: "openclaw-config" },
          runtimeSelection,
          {},
          "v11",
        ),
      ).rejects.toThrow("did not expose a revision-scoped credential");
    },
  );

  it("fails closed when the credential revision never stabilizes", async () => {
    let revision = 10;
    mocks.observeMcpCredentialRevision.mockImplementation(async () => `v${(revision += 1)}`);
    mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
      command === "command -v mcporter"
        ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
        : command.includes("config' 'add")
          ? commandSuccess
          : registered,
    );

    await expect(
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        "openclaw-config",
        { ...baseEntry, agent: "openclaw", adapter: "openclaw-config" },
        runtimeSelection,
        {},
        "v10",
      ),
    ).rejects.toThrow("credential revision did not stabilize");
  });

  it("fails closed when both bounded registrations advance the revision", async () => {
    mocks.observeMcpCredentialRevision
      .mockResolvedValueOnce("v11")
      .mockResolvedValueOnce("v11")
      .mockResolvedValueOnce("v11")
      .mockResolvedValue("v12");
    mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
      command === "command -v mcporter"
        ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
        : command.includes("config' 'add")
          ? commandSuccess
          : registered,
    );

    await expect(
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        "openclaw-config",
        { ...baseEntry, agent: "openclaw", adapter: "openclaw-config" },
        runtimeSelection,
        {},
        "v10",
      ),
    ).rejects.toThrow("credential revision did not stabilize");
    expect(mocks.writeSandboxConfig).toHaveBeenCalledTimes(2);
  });
});
