// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeGatewaySupervisorAction: vi.fn(),
  executeSandboxExecCommand:
    vi.fn<
      typeof import("../../../src/lib/adapters/sandbox/command-transport").executeSandboxExecCommand
    >(),
  getSandbox: vi.fn(),
}));

vi.mock("../../../src/lib/actions/sandbox/process-recovery", () => ({
  executeGatewaySupervisorAction: mocks.executeGatewaySupervisorAction,
}));
vi.mock("../../../src/lib/adapters/sandbox/command-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/adapters/sandbox/command-transport")>()),
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
}));

vi.mock("../../../src/lib/state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/state/registry")>()),
  getSandbox: mocks.getSandbox,
}));

import { SandboxCommandTransportError } from "../../../src/lib/adapters/sandbox/command-transport";

import { assertAgentMcpMutationRuntimeCapability } from "../../../src/lib/actions/sandbox/mcp-bridge-adapters";

beforeEach(() => {
  mocks.executeGatewaySupervisorAction.mockReset();
  mocks.getSandbox.mockReset().mockReturnValue({
    agent: "langchain-deepagents-code",
    gatewayName: "nemoclaw-8091",
    name: "deepagents-box",
  });
});

type ProbeResult = Awaited<
  ReturnType<
    typeof import("../../../src/lib/adapters/sandbox/command-transport").executeSandboxExecCommand
  >
>;

async function runDeepAgentsProbe(result: ProbeResult) {
  mocks.executeSandboxExecCommand.mockReset().mockResolvedValue(result);
  const runtimeSelection = {
    gatewayName: "nemoclaw-8091",
    workspace: "default",
  } as const;

  let message = "";
  try {
    await assertAgentMcpMutationRuntimeCapability(
      "deepagents-box",
      "deepagents-config",
      runtimeSelection,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  return {
    calls: mocks.executeSandboxExecCommand.mock.calls.map(
      ([sandboxName, command, _timeout, options]) => ({
        sandboxName,
        command,
        runtimeSelection: options?.runtimeSelection,
      }),
    ),
    message,
  };
}

describe("Deep Agents managed MCP runtime capability", () => {
  it("accepts only the exact managed launcher capability marker", async () => {
    expect(
      await runDeepAgentsProbe({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=3\n",
        stderr: "",
      }),
    ).toEqual({
      calls: [
        {
          sandboxName: "deepagents-box",
          command: "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
          runtimeSelection: {
            gatewayName: "nemoclaw-8091",
            workspace: "default",
          },
        },
      ],
      message: "",
    });
  });

  it("refuses unavailable transport without rebuilding or changing authenticated MCP state", async () => {
    mocks.executeSandboxExecCommand
      .mockReset()
      .mockRejectedValue(new SandboxCommandTransportError("unavailable"));
    const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };
    const result = assertAgentMcpMutationRuntimeCapability(
      "deepagents-box",
      "deepagents-config",
      runtimeSelection,
    );
    await expect(result).rejects.toThrow(
      "could not be verified because the probe failed in transport",
    );
    await expect(result).rejects.not.toThrow(/rebuild/i);
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledExactlyOnceWith(
      "deepagents-box",
      "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
      undefined,
      { runtimeSelection },
    );
    expect(mocks.executeGatewaySupervisorAction).not.toHaveBeenCalled();
  });

  it.each([
    { status: 2, stdout: "", stderr: "unknown option" },
    { status: 0, stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n", stderr: "" },
    { status: 0, stdout: "deepagents-code 0.1.12\n", stderr: "" },
  ])("requires a rebuild before MCP side effects on stale images [case %#]", async (result) => {
    const probe = await runDeepAgentsProbe(result);
    expect(probe.calls).toHaveLength(1);
    expect(probe.message).toMatch(/does not contain native MCP capability v3/i);
    expect(probe.message).toMatch(/rebuild the sandbox before changing authenticated MCP state/i);
    expect(probe.message).not.toContain("unknown option");
  });
});
