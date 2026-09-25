// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import { McpBridgeError, type McpSourceEntry } from "./mcp-bridge-contracts";
import { inspectAgentMcpSources, removeLegacyAgentMcpEntry } from "./mcp-bridge-source";
import { assertDeepAgentsMcpMutationRuntimeCapability } from "./mcp-bridge-adapter-deepagents-capability";
import { registerOpenClawAdapter } from "./mcp-bridge-adapter-openclaw";
import { executeSandboxExecCommand } from "../../adapters/sandbox/command-transport";

vi.mock("../../adapters/sandbox/command-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/sandbox/command-transport")>()),
  executeSandboxExecCommand: vi.fn(),
}));
vi.mock("../../sandbox/config", () => ({
  resolveAgentConfig: () => ({
    agentName: "openclaw",
    configPath: "/sandbox/.openclaw/openclaw.json",
  }),
  readSandboxConfig: () => ({}),
  writeSandboxConfig: vi.fn(),
}));

const execute = vi.mocked(executeSandboxExecCommand);
const sandbox = { name: "alpha", agent: "openclaw" };
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };
const entry: McpSourceEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://example.com/mcp",
  env: [],
  policyName: "mcp-bridge-github",
};
const operations = [
  {
    name: "source inspection",
    run: () => inspectAgentMcpSources(sandbox, runtimeSelection),
    unavailable: "Sandbox 'alpha' is unreachable.",
    remote: "Could not inspect OpenClaw MCP configuration: remote refusal",
  },
  {
    name: "legacy cleanup",
    run: () => removeLegacyAgentMcpEntry(sandbox, entry, runtimeSelection),
    unavailable: "legacy source cleanup failed",
    remote: "legacy source cleanup failed",
  },
  {
    name: "capability inspection",
    run: () => assertDeepAgentsMcpMutationRuntimeCapability("alpha", runtimeSelection),
    unavailable:
      "native MCP capability could not be verified because the probe failed in transport",
    remote: "does not contain native MCP capability v3",
  },
  {
    name: "post-write verification",
    run: () => registerOpenClawAdapter("alpha", entry, runtimeSelection),
    unavailable: "OpenClaw MCP config verification failed after adding 'github'.",
    remote: "OpenClaw MCP config verification failed after adding 'github': remote refusal",
  },
];

beforeEach(() => {
  execute.mockReset();
});

describe.each(operations)("MCP $name failure boundary", ({ run, unavailable, remote }) => {
  it.each(["cancelled", "timeout", "capture", "invocation", "unavailable", "malformed"] as const)(
    "translates %s without retry or success",
    async (kind) => {
      execute.mockRejectedValue(new SandboxCommandTransportError(kind));
      const result = run();
      await expect(result).rejects.toBeInstanceOf(McpBridgeError);
      await expect(result).rejects.toThrow(unavailable);
      expect(execute).toHaveBeenCalledOnce();
    },
  );
  it("preserves remote nonzero diagnostics", async () => {
    execute.mockResolvedValue({ status: 7, stdout: "", stderr: "remote refusal" });
    await expect(run()).rejects.toThrow(remote);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("propagates unexpected errors", async () => {
    const error = new Error("authority refused");
    execute.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(execute).toHaveBeenCalledOnce();
  });
});
