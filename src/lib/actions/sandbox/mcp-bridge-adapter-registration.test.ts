// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  executeSandboxExecCommand: vi.fn(),
  executeGatewaySupervisorAction: vi.fn(),
  getSandbox: vi.fn(),
  observeMcpCredentialRevision: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
  waitForMcpBridgeCondition: vi.fn((condition: () => boolean) =>
    Array.from({ length: 12 }).some(() => condition()),
  ),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
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
}));

import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  registerAgentAdapter,
  registerAgentAdapterAtCurrentCredentialRevision,
} from "./mcp-bridge-adapters";
import { registerOpenClawAdapter } from "./mcp-bridge-adapter-openclaw";
import { entryHeaders, mcporterHeadersMatchExpected } from "./mcp-bridge-adapter-status";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

const lifecycleSuccess = {
  status: 0,
  stdout: '{"changed":true,"ok":true,"reloaded":true}\n',
  stderr: "",
};

const commandSuccess = { status: 0, stdout: "", stderr: "" };
const registered = { status: 0, stdout: "registered\n", stderr: "" };
const mismatch = { status: 0, stdout: "mismatch\n", stderr: "" };

interface AdapterCase {
  name: string;
  adapter: AgentMcpAdapter;
  entry: McpBridgeEntry;
  arrangeInspection: (result: typeof registered) => void;
  statusCommand: (entry: McpBridgeEntry) => string;
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
  entry: McpBridgeEntry;
  arrange: () => void;
  mutationCalls: () => string;
}

const reconciliationCases: ReconciliationCase[] = [
  {
    name: "OpenClaw",
    adapter: "mcporter",
    entry: { ...baseEntry, agent: "openclaw", adapter: "mcporter" },
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
    mocks.getSandbox.mockReset();
  });

  it("re-reads the persisted definition before registration succeeds", () => {
    adapterCase.arrangeInspection(registered);

    expect(() =>
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).not.toThrow();

    expect(mocks.executeSandboxCommand).toHaveBeenLastCalledWith(
      "alpha",
      adapterCase.statusCommand(adapterCase.entry),
    );
  });

  it("rejects a persisted definition that differs from the requested entry", () => {
    adapterCase.arrangeInspection(mismatch);

    expect(() =>
      registerAgentAdapter("alpha", adapterCase.adapter, adapterCase.entry, {
        GITHUB_TOKEN: "host-only-secret",
      }),
    ).toThrow(`${adapterCase.adapter} config verification failed after adding 'github': mismatch.`);
  });
});

describe("OpenClaw MCP adapter registration", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.getSandbox.mockReset();
  });

  it("rejects a v11 post-write observation after registering the readiness-proven v12", () => {
    const entry: McpBridgeEntry = {
      ...baseEntry,
      agent: "openclaw",
      adapter: "mcporter",
    };
    const actualV11Headers = {
      Authorization: "Bearer openshell:resolve:env:v11_GITHUB_TOKEN",
    };
    const verification = mcporterHeadersMatchExpected(actualV11Headers, entryHeaders(entry, "v12"))
      ? registered
      : mismatch;
    mocks.executeSandboxCommand
      .mockReturnValueOnce({ status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" })
      .mockReturnValueOnce(commandSuccess)
      .mockReturnValueOnce(verification);

    expect(() =>
      registerOpenClawAdapter("alpha", entry, { GITHUB_TOKEN: "host-only-secret" }, false, "v12"),
    ).toThrow("mcporter config verification failed after adding 'github': mismatch");

    expect(mocks.executeSandboxCommand.mock.calls[1]?.[1]).toContain(
      "Authorization=Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
    expect(mocks.executeSandboxCommand.mock.calls[2]?.[1]).toContain(
      "Bearer openshell:resolve:env:v12_GITHUB_TOKEN",
    );
  });
});

describe("Deep Agents MCP adapter credential revision", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.getSandbox.mockReset();
  });

  it("writes and verifies the readiness-proven revision", () => {
    const entry: McpBridgeEntry = {
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
    mocks.getSandbox.mockReset();
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

describe.each(reconciliationCases)("$name MCP credential revision reconciliation", (adapterCase) => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset();
    mocks.observeMcpCredentialRevision.mockReset();
    mocks.observeMcpCredentialRevision.mockReturnValue("v12");
  });

  it("reconciles registration to a later stable revision", () => {
    mocks.observeMcpCredentialRevision.mockReturnValueOnce("v11");
    adapterCase.arrange();

    expect(
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        adapterCase.adapter,
        adapterCase.entry,
        { GITHUB_TOKEN: "host-only-secret" },
        "v11",
      ),
    ).toBe("v12");

    const mutationCalls = adapterCase.mutationCalls();
    expect(mutationCalls).toContain("openshell:resolve:env:v11_GITHUB_TOKEN");
    expect(mutationCalls).toContain("openshell:resolve:env:v12_GITHUB_TOKEN");
    expect(mutationCalls).not.toContain("host-only-secret");
  });
});

describe("MCP adapter credential revision reconciliation failures", () => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
    mocks.getSandbox.mockReset();
    mocks.observeMcpCredentialRevision.mockReset();
  });

  it.each(["absent", "canonical"] as const)(
    "fails closed when reconciliation observes %s credential authority",
    (observation) => {
      mocks.observeMcpCredentialRevision.mockReturnValue(observation);
      mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
        command === "command -v mcporter"
          ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
          : command.includes("config' 'add")
            ? commandSuccess
            : registered,
      );

      expect(() =>
        registerAgentAdapterAtCurrentCredentialRevision(
          "alpha",
          "mcporter",
          { ...baseEntry, agent: "openclaw", adapter: "mcporter" },
          {},
          "v11",
        ),
      ).toThrow("did not expose a revision-scoped credential");
    },
  );

  it("fails closed when the credential revision never stabilizes", () => {
    let revision = 10;
    mocks.observeMcpCredentialRevision.mockImplementation(() => `v${(revision += 1)}`);
    mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
      command === "command -v mcporter"
        ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
        : command.includes("config' 'add")
          ? commandSuccess
          : registered,
    );

    expect(() =>
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        "mcporter",
        { ...baseEntry, agent: "openclaw", adapter: "mcporter" },
        {},
        "v10",
      ),
    ).toThrow("credential revision did not stabilize");
  });

  it("fails closed when both bounded registrations advance the revision", () => {
    mocks.observeMcpCredentialRevision
      .mockReturnValueOnce("v11")
      .mockReturnValueOnce("v11")
      .mockReturnValueOnce("v11")
      .mockReturnValue("v12");
    mocks.executeSandboxCommand.mockImplementation((_sandbox, command: string) =>
      command === "command -v mcporter"
        ? { status: 0, stdout: "/usr/bin/mcporter\n", stderr: "" }
        : command.includes("config' 'add")
          ? commandSuccess
          : registered,
    );

    expect(() =>
      registerAgentAdapterAtCurrentCredentialRevision(
        "alpha",
        "mcporter",
        { ...baseEntry, agent: "openclaw", adapter: "mcporter" },
        {},
        "v10",
      ),
    ).toThrow("credential revision did not stabilize");
    expect(
      mocks.executeSandboxCommand.mock.calls.filter(([, command]) =>
        String(command).includes("config' 'add"),
      ),
    ).toHaveLength(2);
  });
});
