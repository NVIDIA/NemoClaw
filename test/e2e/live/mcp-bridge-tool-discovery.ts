// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { FakeMcpHttpsServer } from "./mcp-bridge-servers.ts";

export async function assertAuthenticatedMcpDiscovery(
  fakeMcp: FakeMcpHttpsServer,
  options: {
    requestOffset: number;
    expectedSecret: string;
    label: string;
  },
): Promise<void> {
  await expect
    .poll(
      () => {
        const requests = fakeMcp.requests.slice(options.requestOffset);
        const observed = (rpcMethod: "initialize" | "tools/list") =>
          requests.some(
            (request) =>
              request.method === "POST" &&
              request.path === "/mcp" &&
              request.rpcMethod === rpcMethod &&
              request.auth === `Bearer ${options.expectedSecret}`,
          );
        return {
          initialized: observed("initialize"),
          toolsListed: observed("tools/list"),
          requests: requests.map((request) => ({
            method: request.method,
            path: request.path,
            rpcMethod: request.rpcMethod,
            credentialRewritten: request.auth === `Bearer ${options.expectedSecret}`,
          })),
        };
      },
      { interval: 500, timeout: 90_000, message: options.label },
    )
    .toMatchObject({ initialized: true, toolsListed: true });
}

export async function assertAuthenticatedMcpToolDiscovery(
  host: HostCliClient,
  fakeMcp: FakeMcpHttpsServer,
  options: { sandboxName: string; artifactPrefix: string; hostSecret: string },
): Promise<void> {
  const toolListRequestsBefore = fakeMcp.requests.filter(
    (request) => request.rpcMethod === "tools/list",
  ).length;
  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", "fake", "--tools", "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-status-tools-json`,
      env: {
        ...buildAvailabilityProbeEnv(),
        FAKE_MCP_SECRET: options.hostSecret,
      },
      redactionValues: [options.hostSecret],
      timeoutMs: 60_000,
    },
  );
  assertExitZero(status, `${options.artifactPrefix} mcp status --tools --json`);
  const statusJson = JSON.parse(status.stdout) as {
    provider: { credentialResolution?: unknown };
    toolDiscovery: {
      ok: boolean;
      count: number;
      tools: string[];
      truncated: boolean;
      detail?: string;
    };
  };
  expect(statusJson.provider.credentialResolution).toBeUndefined();
  expect(statusJson.toolDiscovery).toMatchObject({
    ok: true,
    count: 2,
    tools: ["fake_echo", "fake_status"],
    truncated: false,
  });
  expect(status.stdout).not.toContain(options.hostSecret);
  const toolListRequests = fakeMcp.requests.filter((request) => request.rpcMethod === "tools/list");
  expect(toolListRequests).toHaveLength(toolListRequestsBefore + 2);
  expect(
    toolListRequests
      .slice(toolListRequestsBefore)
      .every((request) => request.auth === `Bearer ${options.hostSecret}`),
  ).toBe(true);
  expect(fakeMcp.requests.some((request) => request.rpcMethod === "tools/call")).toBe(false);
}
