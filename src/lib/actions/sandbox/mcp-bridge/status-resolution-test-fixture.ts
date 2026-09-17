// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { expect } from "vitest";

// This focused companion keeps its 1,498-line owner under the repository's
// 1,500-line test budget while remaining excluded from production builds.

export const statusHarnessConfig = {
  concurrency: 4,
  sourceNodeOptions: [
    process.env.NODE_OPTIONS,
    `--require=${path.resolve("test/helpers/onboard-script-mocks.cjs")}`,
  ]
    .filter(Boolean)
    .join(" "),
  timeoutMs: 60_000,
};

export const TRUSTED_PRIVATE_STATUS_HARNESS = String.raw`
  Object.assign(sourceEntry, {
    url: "https://172.17.0.2:8443/mcp",
    trustedPrivateHost: "172.17.0.2",
    allowedIps: ["172.17.0.2"],
  });
  await bridge.dispatchMcpBridgeCommand("alpha", ["status", "github", "--probe", "--tools", "--json"]);
  const status = JSON.parse(logLines.join("\n"));
  writeHarnessResult(JSON.stringify({
    status,
    probeCommands: executedSandboxCommands.filter((c) => c.includes("NEMOCLAW_MCP_PROBE")),
    discoveryCommands: executedSandboxCommands.filter((c) => c.includes("mcp-tool-discovery-runtime")),
  }));
`;

export function expectTrustedPrivateStatusResult(stdout: string): void {
  const payload = JSON.parse(stdout) as {
    status: {
      url: string;
      trustedPrivateTarget: { host: string; recordedPins: string[] };
      provider: { credentialResolution: { ok: boolean | null; detail?: string } };
      toolDiscovery: { ok: boolean; count: number; tools: string[]; detail?: string };
    };
    probeCommands: string[];
    discoveryCommands: string[];
  };
  expect(payload.probeCommands).toHaveLength(1);
  expect(payload.probeCommands[0]).toContain("https://172.17.0.2:8443/mcp");
  expect(payload.discoveryCommands).toHaveLength(1);
  expect(payload.discoveryCommands[0]).toContain("https://172.17.0.2:8443/mcp");
  expect(payload.status.url).toBe("https://172.17.0.2:8443/mcp");
  expect(payload.status.trustedPrivateTarget).toMatchObject({
    host: "172.17.0.2",
    recordedPins: ["172.17.0.2"],
  });
  expect(payload.status.provider.credentialResolution).toMatchObject({
    ok: true,
    httpStatus: 200,
    controlHttpStatus: 401,
  });
  expect(payload.status.toolDiscovery).toMatchObject({
    ok: true,
    count: 2,
    tools: ["alpha", "zeta"],
    commandStatus: 0,
  });
}
