// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpSourceEntry } from "./mcp-bridge-contracts";

const mocks = vi.hoisted(() => ({
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
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
  restartSandboxGateway: mocks.restartSandboxGateway,
  waitForManagedGatewaySupervisor: mocks.waitForManagedGatewaySupervisor,
}));
vi.mock("../../adapters/sandbox/command-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/sandbox/command-transport")>()),
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
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
  HermesMcpReloadRelayLossError,
  inspectAgentAdapterRegistration,
  inspectHermesMcpReloadFinality,
  observeStableMcpCredentialRevision,
  registerAgentAdapter,
  registerAgentAdapterAtCurrentCredentialRevision,
  reloadOpenClawGatewayAfterMcpMutation,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { registerOpenClawAdapter, unregisterOpenClawAdapter } from "./mcp-bridge-adapter-openclaw";
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
const hermesReloadRelayLoss = `Error:   × code: 'The service is currently unavailable', message: "exec relay closed before the command reported an exit status"\n`;

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
      mocks.executeSandboxExecCommand.mockReturnValue(result);
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
      mocks.executeSandboxExecCommand
        .mockReturnValueOnce(commandSuccess)
        .mockReturnValueOnce(result);
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
      mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
        command === "command -v mcporter"
          ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
          : command.includes("config' 'add")
            ? commandSuccess
            : registered,
      );
    },
    mutationCalls: () => JSON.stringify(mocks.executeSandboxExecCommand.mock.calls),
  },
  {
    name: "Hermes",
    adapter: "hermes-config",
    entry: baseEntry,
    arrange: () => {
      mocks.runOpenshellProviderCommand.mockReturnValue(lifecycleSuccess);
      mocks.executeSandboxExecCommand.mockReturnValue(registered);
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
      mocks.executeSandboxExecCommand
        .mockReturnValueOnce(commandSuccess)
        .mockReturnValueOnce(registered)
        .mockReturnValueOnce(commandSuccess)
        .mockReturnValueOnce(registered);
    },
    mutationCalls: () => JSON.stringify(mocks.executeSandboxExecCommand.mock.calls),
  },
];

describe.each(adapterCases)("$name MCP adapter registration", (adapterCase) => {
  beforeEach(() => {
    mocks.executeSandboxExecCommand.mockReset();
    mocks.executeGatewaySupervisorAction.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("re-reads the persisted definition before registration succeeds", async () => {
    adapterCase.arrangeInspection(registered);

    await expect(
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, runtimeSelection, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).resolves.toBeUndefined();

    expect(mocks.executeSandboxExecCommand).toHaveBeenLastCalledWith(
      "alpha",
      adapterCase.statusCommand(adapterCase.entry),
      undefined,
      { runtimeSelection },
    );
    expect(mocks.executeSandboxExecCommand.mock.calls.map((call) => call[3])).toEqual(
      Array(mocks.executeSandboxExecCommand.mock.calls.length).fill({
        runtimeSelection,
      }),
    );
  });

  it("rejects a persisted definition that differs from the requested entry", async () => {
    adapterCase.arrangeInspection(mismatch);

    await expect(
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, runtimeSelection, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).rejects.toThrow(
      `${adapterCase.adapter} config verification failed after adding 'github': mismatch.`,
    );
  });
});

describe("Hermes MCP reload finality", () => {
  beforeEach(() => {
    mocks.executeSandboxExecCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("forwards a caller deadline to the adapter inspection transport", async () => {
    mocks.executeSandboxExecCommand.mockReturnValue(registered);

    await inspectAgentAdapterRegistration(
      "alpha",
      "hermes-config",
      baseEntry,
      runtimeSelection,
      undefined,
      4_321,
    );

    expect(mocks.executeSandboxExecCommand).toHaveBeenLastCalledWith(
      "alpha",
      buildHermesMcpStatusCommand(baseEntry),
      4_321,
      { runtimeSelection },
    );
  });

  it("classifies only the exact status-1 reload relay loss and retains its credential revision", async () => {
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: `\u001b[31m${hermesReloadRelayLoss}\u001b[0m`,
    });

    let failure: unknown;
    try {
      await registerAgentAdapter(
        "alpha",
        "hermes-config",
        baseEntry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        { credentialRevision: "v12" },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HermesMcpReloadRelayLossError);
    expect(failure).toMatchObject({ credentialRevision: "v12" });
    expect(String(failure)).not.toContain("host-only-secret");
  });

  it("retains relay-loss finality when a credential overlaps the diagnostic text", async () => {
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: hermesReloadRelayLoss,
    });

    let failure: unknown;
    try {
      await registerAgentAdapter(
        "alpha",
        "hermes-config",
        baseEntry,
        runtimeSelection,
        { GITHUB_TOKEN: "exec relay" },
        { credentialRevision: "v12" },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HermesMcpReloadRelayLossError);
    expect(failure).toMatchObject({ credentialRevision: "v12" });
    expect(String(failure)).not.toContain("exec relay");
  });

  it.each([
    ["another exit status", { status: 2, stdout: "", stderr: hermesReloadRelayLoss }],
    [
      "a spawn error",
      {
        status: 1,
        stdout: "",
        stderr: hermesReloadRelayLoss,
        error: new Error("spawn failed"),
      },
    ],
    [
      "another service-unavailable message",
      {
        status: 1,
        stdout: "",
        stderr: hermesReloadRelayLoss.replace(
          "exec relay closed before the command reported an exit status",
          "supervisor session disconnected",
        ),
      },
    ],
    [
      "an exact message with unrelated output",
      {
        status: 1,
        stdout: "",
        stderr: `unrelated diagnostic\n${hermesReloadRelayLoss}`,
      },
    ],
    [
      "a multiplication sign inside semantic text",
      {
        status: 1,
        stdout: "",
        stderr: hermesReloadRelayLoss.replace("exec relay", "e×ec relay"),
      },
    ],
  ])("does not classify %s as a reload relay loss", async (_label, result) => {
    mocks.runOpenshellProviderCommand.mockReturnValue(result);

    await expect(
      registerAgentAdapter(
        "alpha",
        "hermes-config",
        baseEntry,
        runtimeSelection,
        {},
        { credentialRevision: "v12" },
      ),
    ).rejects.not.toBeInstanceOf(HermesMcpReloadRelayLossError);
  });

  it("proves committed state with one read-only helper observation", () => {
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"state":"committed"}\n',
      stderr: "",
    });

    expect(inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection)).toEqual({
      state: "committed",
    });
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledOnce();
    const [args, options] = mocks.runOpenshellProviderCommand.mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["--timeout", "650", "reconcile"]));
    expect(options).toMatchObject({ timeout: 675_000 });
    expect(JSON.stringify(mocks.runOpenshellProviderCommand.mock.calls)).not.toContain(
      "host-only-secret",
    );
  });

  it("proves absence only after committed-state reconciliation fails", () => {
    mocks.runOpenshellProviderCommand
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "config mismatch" })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"ok":true,"state":"absent"}\n',
        stderr: "",
      });

    expect(inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection)).toEqual({
      state: "absent",
    });
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledTimes(2);
  });

  it("shares one bounded deadline across committed and absent reconciliation", () => {
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(11_001);
    mocks.runOpenshellProviderCommand
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "config mismatch" })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"ok":true,"state":"absent"}\n',
        stderr: "",
      });

    expect(
      inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection, {
        deadlineMs: 676_000,
        readinessDeadlineMs: 621_000,
      }),
    ).toEqual({ state: "absent" });
    const [args, options] = mocks.runOpenshellProviderCommand.mock.calls[1] ?? [];
    expect(args).toEqual(expect.arrayContaining(["--timeout", "639", "reconcile"]));
    expect(options).toMatchObject({ timeout: 664_999 });
    expect(639_000 + 25_000).toBeLessThanOrEqual(664_999);
    now.mockRestore();
  });

  it("returns unknown without a second probe when the finality deadline is exhausted", () => {
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(676_001);
    mocks.runOpenshellProviderCommand.mockReturnValueOnce({
      status: 2,
      stdout: "",
      stderr: "reconciliation timed out",
    });

    expect(
      inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection, {
        deadlineMs: 676_000,
        readinessDeadlineMs: 621_000,
      }),
    ).toEqual({
      state: "unknown",
      detail: "Hermes MCP reconciliation exhausted its finality deadline.",
    });
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledOnce();
    now.mockRestore();
  });

  it("does not start reconciliation without the reserved thirty-second proof budget", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(621_001);

    expect(
      inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection, {
        deadlineMs: 676_000,
        readinessDeadlineMs: 621_000,
      }),
    ).toEqual({
      state: "unknown",
      detail: "Hermes MCP reconciliation exhausted its finality deadline.",
    });
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("uses the exact proof reserve at the readiness boundary", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(621_000);
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"state":"committed"}\n',
      stderr: "",
    });

    expect(
      inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection, {
        deadlineMs: 676_000,
        readinessDeadlineMs: 621_000,
      }),
    ).toEqual({ state: "committed" });
    const [args, options] = mocks.runOpenshellProviderCommand.mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["--timeout", "30", "reconcile"]));
    expect(options).toMatchObject({ timeout: 55_000 });
    now.mockRestore();
  });

  it("returns unknown when neither helper observation proves finality", () => {
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "config mismatch",
    });

    expect(inspectHermesMcpReloadFinality("alpha", baseEntry, "v12", runtimeSelection)).toEqual({
      state: "unknown",
      detail: "Hermes MCP reconciliation proved neither committed state nor absence.",
    });
  });
});

describe("OpenClaw MCP adapter registration", () => {
  beforeEach(() => {
    mocks.executeSandboxExecCommand.mockReset();
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

  it("rejects a v11 post-write observation after registering the readiness-proven v12", async () => {
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
    mocks.executeSandboxExecCommand.mockReturnValueOnce(verification);

    await expect(
      registerOpenClawAdapter(
        "alpha",
        entry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        false,
        "v12",
      ),
    ).rejects.toThrow("OpenClaw MCP config verification failed after adding 'github': mismatch");

    expect(mocks.executeSandboxExecCommand.mock.calls[0]?.[1]).toContain(
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

  it("removes the native entry through the paired config and hash transaction", async () => {
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

    expect(await unregisterAgentAdapter("alpha", "openclaw-config", entry, runtimeSelection)).toBe(
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

  it("preserves a changed OpenClaw entry unless removal is explicitly forced", () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.readSandboxConfig.mockReturnValue({
      preserved: true,
      mcp: { servers: { github: { url: "https://changed.example/mcp" } } },
    });

    expect(() => unregisterOpenClawAdapter("alpha", entry, runtimeSelection)).toThrow(
      "Refusing to remove modified OpenClaw MCP server 'github'",
    );
    expect(mocks.writeSandboxConfig).not.toHaveBeenCalled();

    unregisterOpenClawAdapter("alpha", entry, runtimeSelection, { force: true });
    expect(mocks.writeSandboxConfig).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ configPath: "/sandbox/.openclaw/openclaw.json" }),
      { preserved: true, mcp: { servers: {} } },
    );
  });

  it("adds a non-restrictive tool-policy extension when no tools block exists", async () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "openclaw-config",
    };
    mocks.readSandboxConfig.mockReturnValue({});
    mocks.executeSandboxExecCommand.mockReturnValue(registered);

    await registerOpenClawAdapter("alpha", entry, runtimeSelection, {}, false, "v12");

    expect(mocks.writeSandboxConfig.mock.calls[0]?.[2]).toMatchObject({
      tools: { alsoAllow: ["bundle-mcp"] },
    });
    expect(mocks.writeSandboxConfig.mock.calls[0]?.[2]).not.toHaveProperty("plugins");
    expect(mocks.waitForManagedGatewaySupervisor).not.toHaveBeenCalled();
  });
});

describe("Deep Agents MCP adapter credential revision", () => {
  beforeEach(() => {
    mocks.executeSandboxExecCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("writes and verifies the readiness-proven revision", async () => {
    const entry: McpSourceEntry = {
      ...baseEntry,
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
    };
    mocks.executeSandboxExecCommand
      .mockReturnValueOnce(commandSuccess)
      .mockReturnValueOnce(registered);

    await expect(
      registerAgentAdapter(
        "alpha",
        "deepagents-config",
        entry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        { credentialRevision: "v12" },
      ),
    ).resolves.toBeUndefined();

    expect(mocks.executeSandboxExecCommand.mock.calls[0]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.executeSandboxExecCommand.mock.calls[1]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(JSON.stringify(mocks.executeSandboxExecCommand.mock.calls)).not.toContain(
      "host-only-secret",
    );
  });
});

describe("Hermes MCP adapter credential revision", () => {
  beforeEach(() => {
    mocks.executeSandboxExecCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset().mockReturnValue(sandbox);
  });

  it("writes and verifies the readiness-proven revision", async () => {
    mocks.runOpenshellProviderCommand.mockReturnValue(lifecycleSuccess);
    mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
      command === buildHermesMcpStatusCommand(baseEntry, "v12")
        ? registered
        : {
            status: 0,
            stdout: "v12\n",
            stderr: "",
          },
    );

    await expect(
      registerAgentAdapter(
        "alpha",
        "hermes-config",
        baseEntry,
        runtimeSelection,
        { GITHUB_TOKEN: "host-only-secret" },
        { credentialRevision: "v12" },
      ),
    ).resolves.toBeUndefined();

    expect(JSON.stringify(mocks.runOpenshellProviderCommand.mock.calls[0]?.[0])).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.executeSandboxExecCommand.mock.calls[0]?.[1]).toContain(
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
      mocks.executeSandboxExecCommand.mockReset();
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
    mocks.executeSandboxExecCommand.mockReset();
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
    mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
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
    expect(
      mocks.executeSandboxExecCommand.mock.calls.map((call) => call[3]?.runtimeSelection),
    ).toEqual(Array(mocks.executeSandboxExecCommand.mock.calls.length).fill(operationSelection));
    expect(mocks.observeMcpCredentialRevision.mock.calls.map((call) => call[2])).toEqual(
      Array(mocks.observeMcpCredentialRevision.mock.calls.length).fill(operationSelection),
    );
  });

  it.each(["absent", "canonical"] as const)(
    "fails closed when reconciliation observes %s credential authority",
    async (observation) => {
      mocks.observeMcpCredentialRevision.mockResolvedValue(observation);
      mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
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
      ).rejects.toThrow("did not expose a credential handle");
    },
  );

  it("fails closed when the credential revision never stabilizes", async () => {
    let revision = 10;
    mocks.observeMcpCredentialRevision.mockImplementation(async () => `v${(revision += 1)}`);
    mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
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

  it("rejects v7, v7, v8 while proving an attempted v7 revision", async () => {
    mocks.observeMcpCredentialRevision
      .mockResolvedValueOnce("v7")
      .mockResolvedValueOnce("v7")
      .mockResolvedValueOnce("v8");

    await expect(
      observeStableMcpCredentialRevision("alpha", baseEntry, runtimeSelection, 30, "v7"),
    ).rejects.toThrow("credential revision did not stabilize");
    expect(mocks.observeMcpCredentialRevision).toHaveBeenCalledTimes(3);
  });

  it("bounds every stable revision observation by the shared finality deadline", async () => {
    mocks.observeMcpCredentialRevision.mockResolvedValue("v7");
    const now = vi.fn(() => 10_000);

    await expect(
      observeStableMcpCredentialRevision("alpha", baseEntry, runtimeSelection, 30, "v7", {
        deadlineMs: 40_000,
        now,
      }),
    ).resolves.toBe("v7");

    expect(mocks.waitForMcpBridgeConditionAsync).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ deadlineMs: 40_000, now }),
    );
    expect(mocks.observeMcpCredentialRevision).toHaveBeenCalledTimes(3);
    expect(mocks.observeMcpCredentialRevision).toHaveBeenNthCalledWith(
      1,
      "alpha",
      baseEntry,
      runtimeSelection,
      30_000,
    );
  });

  it("fails closed when both bounded registrations advance the revision", async () => {
    mocks.observeMcpCredentialRevision
      .mockResolvedValueOnce("v11")
      .mockResolvedValueOnce("v11")
      .mockResolvedValueOnce("v11")
      .mockResolvedValue("v12");
    mocks.executeSandboxExecCommand.mockImplementation((_sandbox, command: string) =>
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

describe("native OpenClaw stable credential headers", () => {
  const stable = `s${"a".repeat(64)}` as const;
  const scoped = (generation: string, key = "GITHUB_TOKEN") => ({
    Authorization: `Bearer openshell:resolve:env:${generation}_${key}`,
  });

  it("matches the exact stable handle and canonical key without accepting another handle", () => {
    expect(openClawHeadersMatchExpected(scoped(stable), entryHeaders(baseEntry))).toBe(true);
    expect(openClawHeadersMatchExpected(scoped(stable), entryHeaders(baseEntry, stable))).toBe(
      true,
    );
    expect(
      openClawHeadersMatchExpected(scoped(`s${"b".repeat(64)}`), entryHeaders(baseEntry, stable)),
    ).toBe(false);
  });

  it.each([`s${"a".repeat(63)}`, `s${"a".repeat(65)}`, `s${"A".repeat(64)}`])(
    "rejects malformed stable generation %s",
    (generation) => {
      expect(openClawHeadersMatchExpected(scoped(generation), entryHeaders(baseEntry))).toBe(false);
    },
  );

  it("rejects a different key and every extra native header", () => {
    expect(
      openClawHeadersMatchExpected(scoped(stable, "OTHER_TOKEN"), entryHeaders(baseEntry)),
    ).toBe(false);
    expect(
      openClawHeadersMatchExpected(
        { ...scoped(stable), accept: "application/json, text/event-stream" },
        entryHeaders(baseEntry),
      ),
    ).toBe(false);
  });
});
