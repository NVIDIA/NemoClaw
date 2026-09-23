// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import { inspectAdapterRegistrationCommand } from "./mcp-bridge-adapter-inspection";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { probeCredentialResolution } from "./mcp-bridge-resolution-probe";
import { discoverMcpTools } from "./mcp-bridge-tool-discovery";

const mocks = vi.hoisted(() => ({ executeSandboxExecCommand: vi.fn() }));
vi.mock("../../adapters/sandbox/command-transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/sandbox/command-transport")>()),
  executeSandboxExecCommand: mocks.executeSandboxExecCommand,
}));

const entry: McpSourceEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
};
const runtime = {
  gatewayName: "nemoclaw-8091",
  localTlsDir: "/recorded/gateway/tls",
  workspace: "default",
} as const;
const readiness = {
  policyGatewayPresent: true,
  providerAttached: true,
  providerCredentialReady: true,
} as const;
const operations = [
  {
    name: "adapter inspection",
    run: () => inspectAdapterRegistrationCommand("alpha", entry, "inspect", runtime),
    result: { state: "error" },
  },
  {
    name: "credential probe",
    run: () =>
      probeCredentialResolution("alpha", entry, "openclaw-config", readiness, runtime, "v1"),
    result: { ok: null },
  },
  {
    name: "tool discovery",
    run: () => discoverMcpTools("alpha", entry, "openclaw-config", readiness, runtime),
    result: { ok: false, count: 0, tools: [], commandStatus: null, failureClass: "runtime" },
  },
];

beforeEach(() => vi.resetAllMocks());

describe.each([
  "cancelled",
  "timeout",
  "capture",
  "invocation",
  "unavailable",
  "malformed",
] as const)("MCP native transport failure: %s", (kind) => {
  it.each(operations)("reports $name without retrying", async ({ run, result }) => {
    const error = new SandboxCommandTransportError(kind);
    mocks.executeSandboxExecCommand.mockRejectedValue(error);
    await expect(run()).resolves.toMatchObject({ ...result, detail: error.message });
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledOnce();
  });
  it("preserves best-effort cleanup but fails strict mutations", async () => {
    const error = new SandboxCommandTransportError(kind);
    mocks.executeSandboxExecCommand.mockRejectedValue(error);
    await expect(
      runDeepAgentsAdapterCommand("alpha", entry, "remove", "failed", runtime, {
        bestEffort: true,
      }),
    ).resolves.toBe("");
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledOnce();
    mocks.executeSandboxExecCommand.mockClear();
    await expect(
      runDeepAgentsAdapterCommand("alpha", entry, "add", "failed", runtime),
    ).rejects.toBe(error);
    expect(mocks.executeSandboxExecCommand).toHaveBeenCalledOnce();
  });
});

it.each(operations)("propagates unexpected authority errors from $name", async ({ run }) => {
  const error = new Error("runtime authority rejected");
  mocks.executeSandboxExecCommand.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(mocks.executeSandboxExecCommand).toHaveBeenCalledOnce();
});

it("does not suppress unexpected authority errors during best-effort cleanup", async () => {
  const error = new Error("runtime authority rejected");
  mocks.executeSandboxExecCommand.mockRejectedValue(error);
  await expect(
    runDeepAgentsAdapterCommand("alpha", entry, "remove", "failed", runtime, { bestEffort: true }),
  ).rejects.toBe(error);
});
