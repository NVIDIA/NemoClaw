// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { addBridgeConcurrentlyAndReadStatus } from "../live/mcp-bridge-concurrent-add.ts";

const SANDBOX_NAME = "e2e-mcp-hermes";
const SERVER_NAME = "fake";
const MCP_URL = "https://fixture.trycloudflare.com/mcp";
const PROVIDER_NAME = `${SANDBOX_NAME}-mcp-${SERVER_NAME}-0123456789abcdef`;

function result(exitCode: number, stdout = "", stderr = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    artifacts: { stdout: "", stderr: "", result: "" },
  };
}

function coherentStatus(): string {
  return JSON.stringify({
    support: { supported: true, adapter: "hermes-config" },
    server: SERVER_NAME,
    url: MCP_URL,
    warnings: ["MCP provider at sandbox scope uses endpoint-exclusive credential binding"],
    env: { names: ["FAKE_MCP_SECRET"], ready: true, missing: [] },
    provider: {
      name: PROVIDER_NAME,
      registryPresent: true,
      gatewayPresent: true,
      attached: true,
      credentialReady: true,
    },
    policy: { registryPresent: true, gatewayPresent: true },
    adapter: { registered: true },
  });
}

function options() {
  return {
    sandboxName: SANDBOX_NAME,
    mcpUrl: MCP_URL,
    expectedAdapter: "hermes-config" as const,
    artifactPrefix: "hermes",
    serverName: SERVER_NAME,
    mutationTimeoutMs: 720_000,
  };
}

describe("MCP bridge concurrent-add sequencing", () => {
  it("reuses the one committed winner and inspects that exact server", async () => {
    let addAttempt = 0;
    const nemoclaw = vi.fn(async (args: string[], _runOptions: ShellProbeRunOptions) => {
      if (args[2] === "add") {
        addAttempt += 1;
        return addAttempt === 1
          ? result(0)
          : result(1, "", `MCP server '${SERVER_NAME}' already exists`);
      }
      if (args[2] === "status") return result(0, coherentStatus());
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    const host = { nemoclaw } as unknown as HostCliClient;

    await expect(addBridgeConcurrentlyAndReadStatus(host, options())).resolves.toBe(PROVIDER_NAME);

    const commandArgs = nemoclaw.mock.calls.map(([args]) => args);
    expect(commandArgs).toEqual([
      [SANDBOX_NAME, "mcp", "add", SERVER_NAME, "--url", MCP_URL, "--env", "FAKE_MCP_SECRET"],
      [SANDBOX_NAME, "mcp", "add", SERVER_NAME, "--url", MCP_URL, "--env", "FAKE_MCP_SECRET"],
      [SANDBOX_NAME, "mcp", "status", SERVER_NAME, "--json"],
    ]);
    expect(
      nemoclaw.mock.calls.every(([, runOptions]) =>
        runOptions.redactionValues?.includes(MCP_BRIDGE_TEST_CREDENTIALS.host),
      ),
    ).toBe(true);
  });

  it("fails unless concurrent attempts serialize to exactly one winner", async () => {
    const nemoclaw = vi.fn(async (_args: string[], _runOptions: ShellProbeRunOptions) => result(0));
    const host = { nemoclaw } as unknown as HostCliClient;

    await expect(addBridgeConcurrentlyAndReadStatus(host, options())).rejects.toThrow();
    expect(nemoclaw).toHaveBeenCalledTimes(2);
  });
});
