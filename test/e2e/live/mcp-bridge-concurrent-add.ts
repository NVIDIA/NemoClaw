// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import {
  type McpAdapter,
  retryAfterHermesRestartTransportFailure,
} from "./mcp-bridge-reliability.ts";

const HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.host;

export async function addBridgeConcurrentlyAndReadStatus(
  host: HostCliClient,
  options: {
    sandboxName: string;
    mcpUrl: string;
    expectedAdapter: McpAdapter;
    artifactPrefix: string;
    serverName: string;
    mutationTimeoutMs: number;
  },
): Promise<string> {
  const args = [
    options.sandboxName,
    "mcp",
    "add",
    options.serverName,
    "--url",
    options.mcpUrl,
    "--env",
    "FAKE_MCP_SECRET",
  ];
  const env = {
    ...buildAvailabilityProbeEnv(),
    FAKE_MCP_SECRET: HOST_SECRET,
  };
  const attempts = await Promise.all(
    ["first", "second"].map((attempt) =>
      host.nemoclaw(args, {
        artifactName: `${options.artifactPrefix}-mcp-concurrent-add-${attempt}`,
        env,
        redactionValues: [HOST_SECRET],
        // Keep both clients alive through Hermes' bounded restart and config
        // reload; the loser then acquires the lock and rejects the duplicate.
        timeoutMs: options.mutationTimeoutMs,
      }),
    ),
  );
  const successful = attempts.filter((result) => result.exitCode === 0);
  const rejected = attempts.filter((result) => result.exitCode !== 0);
  expect(successful).toHaveLength(1);
  expect(rejected).toHaveLength(1);

  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", options.serverName, "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-concurrent-add-coherent-status`,
      env,
      redactionValues: [HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expect(
    status.exitCode,
    `${options.artifactPrefix} concurrent add status\nstdout:\n${status.stdout}\nstderr:\n${status.stderr}`,
  ).toBe(0);
  const statusJson = JSON.parse(status.stdout) as {
    support: { supported: boolean; adapter: string };
    server: string;
    url: string;
    warnings: string[];
    env: { names: string[]; ready: boolean; missing: string[] };
    provider: {
      name: string;
      registryPresent: boolean;
      gatewayPresent: boolean;
      attached: boolean;
      credentialReady: boolean;
    };
    policy: { registryPresent: boolean; gatewayPresent: boolean };
    adapter: { registered: boolean };
  };
  expect(statusJson).toMatchObject({
    server: options.serverName,
    url: options.mcpUrl,
    support: { supported: true, adapter: options.expectedAdapter },
    env: { names: ["FAKE_MCP_SECRET"], ready: true, missing: [] },
    provider: {
      registryPresent: true,
      gatewayPresent: true,
      attached: true,
      credentialReady: true,
    },
    policy: { registryPresent: true, gatewayPresent: true },
    adapter: { registered: true },
  });
  expect(statusJson.warnings).toEqual([
    expect.stringMatching(/provider at sandbox scope.*endpoint-exclusive credential binding/i),
  ]);
  expect(status.stdout).not.toContain(HOST_SECRET);
  const providerPrefix = `${options.sandboxName}-mcp-${options.serverName}-`;
  expect(statusJson.provider.name.startsWith(providerPrefix)).toBe(true);
  expect(statusJson.provider.name.slice(providerPrefix.length)).toMatch(/^[a-f0-9]{16}$/u);

  const duplicateRejection = await retryAfterHermesRestartTransportFailure({
    adapter: options.expectedAdapter,
    committedBridgeVerified: true,
    diagnostic: resultText(rejected[0]!),
    originalResult: rejected[0]!,
    serverName: options.serverName,
    retry: () =>
      host.nemoclaw(args, {
        artifactName: `${options.artifactPrefix}-mcp-concurrent-add-after-restart-transport-failure`,
        env,
        redactionValues: [HOST_SECRET],
        timeoutMs: options.mutationTimeoutMs,
      }),
  });
  expect(
    duplicateRejection.exitCode,
    `${options.artifactPrefix} concurrent MCP add must reject the serialized duplicate`,
  ).not.toBe(0);
  expect(resultText(duplicateRejection)).toMatch(/already exists/iu);
  return statusJson.provider.name;
}
