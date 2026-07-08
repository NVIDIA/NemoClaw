// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeGatewaySupervisorAction: vi.fn(),
  executeSandboxCommand: vi.fn(),
}));

vi.mock("../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
  executeSandboxCommand: mocks.executeSandboxCommand,
}));

import { assertAgentMcpMutationRuntimeCapability } from "../src/lib/actions/sandbox/mcp-bridge-adapters";

type ProbeResult = { status: number; stdout: string; stderr: string } | null;

function runDeepAgentsProbe(result: ProbeResult) {
  mocks.executeSandboxCommand.mockReset().mockReturnValue(result);

  let message = "";
  try {
    assertAgentMcpMutationRuntimeCapability("deepagents-box", "deepagents-config");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  return {
    calls: mocks.executeSandboxCommand.mock.calls.map(([sandboxName, command]) => ({
      sandboxName,
      command,
    })),
    message,
  };
}

describe("Deep Agents managed MCP runtime capability", () => {
  it("accepts only the exact managed launcher capability marker", () => {
    expect(
      runDeepAgentsProbe({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=2\n",
        stderr: "",
      }),
    ).toEqual({
      calls: [
        {
          sandboxName: "deepagents-box",
          command: "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
        },
      ],
      message: "",
    });
  });

  it("requires a rebuild before MCP side effects on stale or unreachable images", () => {
    for (const result of [
      null,
      { status: 2, stdout: "", stderr: "unknown option" },
      { status: 0, stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n", stderr: "" },
      { status: 0, stdout: "deepagents-code 0.1.12\n", stderr: "" },
    ]) {
      const probe = runDeepAgentsProbe(result);
      expect(probe.calls).toHaveLength(1);
      expect(probe.message).toMatch(/does not contain managed MCP capability v2/i);
      expect(probe.message).toMatch(/rebuild the sandbox before changing authenticated MCP state/i);
      expect(probe.message).not.toContain("unknown option");
    }
  });
});
