// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  executeSandboxCommand: vi.fn(),
  executeGatewaySupervisorAction: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("./process-recovery", () => ({
  executeSandboxCommand: mocks.executeSandboxCommand,
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
}));

vi.mock("../../adapters/openshell/provider-command", () => ({
  OPENSHELL_OPERATION_TIMEOUT_MS: 30_000,
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  registerAgentAdapter,
} from "./mcp-bridge-adapters";
import { registerOpenClawAdapter } from "./mcp-bridge-adapter-openclaw";
import {
  entryHeaders,
  mcporterHeadersMatchExpected,
} from "./mcp-bridge-adapter-status";

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

describe.each(adapterCases)("$name MCP adapter registration", (adapterCase) => {
  beforeEach(() => {
    mocks.executeSandboxCommand.mockReset();
    mocks.executeGatewaySupervisorAction.mockReset();
    mocks.runOpenshellProviderCommand.mockReset();
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
