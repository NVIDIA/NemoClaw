// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildChain } from "../../dist/lib/dashboard/contract.js";
import { verifyDeployment } from "../../dist/lib/verify-deployment.js";

const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: (_name: string, _script: string) => ({
      status: 0,
      stdout: "200",
      stderr: "",
    }),
    probeHostPort: (_port: number, _path: string) => 200,
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    getMessagingChannels: (_name: string) => [] as string[],
    providerExistsInGateway: (_name: string) => true,
    ...overrides,
  };
}

describe("verifyDeployment agent dashboard probes", () => {
  it("probes agent gateway and dashboard health on separate ports", async () => {
    const agentChain = buildChain({
      chatUiUrl: "http://127.0.0.1:18789",
      dashboardHealthEndpoint: "/api/status",
      gatewayPort: 8642,
      gatewayHealthEndpoint: "/health",
    });
    const sandboxScripts: string[] = [];
    const hostProbes: Array<{ port: number; path: string }> = [];
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        sandboxScripts.push(script);
        if (script.includes("inference.local")) return { status: 0, stdout: "200", stderr: "" };
        if (script.includes("openclaw --version")) return { status: 0, stdout: "", stderr: "" };
        return { status: 0, stdout: "200", stderr: "" };
      },
      probeHostPort: (port: number, path: string) => {
        hostProbes.push({ port, path });
        return 200;
      },
    });

    const result = await verifyDeployment("my-sandbox", agentChain, deps, NO_RETRY);

    expect(result.healthy).toBe(true);
    expect(sandboxScripts.some((script) => script.includes("http://127.0.0.1:8642/health"))).toBe(
      true,
    );
    expect(hostProbes).toContainEqual({ port: 18789, path: "/api/status" });
  });
});
