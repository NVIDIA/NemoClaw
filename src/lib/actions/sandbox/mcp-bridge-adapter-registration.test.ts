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

vi.mock("../../actions/global", () => ({
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  registerAgentAdapter,
} from "./mcp-bridge-adapters";

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
