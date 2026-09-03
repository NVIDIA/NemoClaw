// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildChain } from "./dashboard/contract.js";
import { verifyDeployment } from "./verify-deployment.js";

const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: (_name: string, _script: string) => ({
      status: 0,
      stdout: "200",
      stderr: "",
    }),
    probeHostPort: (_port: number, _path: string) => 200,
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

describe("verifyDeployment agent OpenAI-compatible API host forward (#9290)", () => {
  const agentChain = buildChain({
    chatUiUrl: "http://127.0.0.1:18789",
    dashboardHealthEndpoint: "/api/status",
    gatewayPort: 8642,
    gatewayHealthEndpoint: "/health",
  });

  function runWithApiHostCode(apiCode: number) {
    const hostProbes: Array<{ port: number; path: string }> = [];
    const deps = makeDeps({
      probeHostPort: (port: number, path: string) => {
        hostProbes.push({ port, path });
        return port === 8642 ? apiCode : 200;
      },
    });
    return { hostProbes, run: () => verifyDeployment("my-sandbox", agentChain, deps, NO_RETRY) };
  }

  it("probes the API port on the host, not just inside the sandbox", async () => {
    const { hostProbes, run } = runWithApiHostCode(200);

    const result = await run();

    // The in-sandbox gateway probe only proves the API answers inside the
    // sandbox; the host forward is what operators actually connect through.
    expect(hostProbes).toContainEqual({ port: 8642, path: "/health" });
    expect(result.healthy).toBe(true);
    expect(result.verification.agentApiReachable).toBe(true);
  });

  it("fails verification when the API host forward refuses connections", async () => {
    // The reported regression: the sandbox gateway is healthy and the dashboard
    // forward is up, but port 8642 never became reachable on the host.
    const { run } = runWithApiHostCode(0);

    const result = await run();

    expect(result.healthy).toBe(false);
    expect(result.verification.agentApiReachable).toBe(false);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
    const api = result.diagnostics.find((d) => d.link === "api");
    expect(api?.status).toBe("fail");
    expect(api?.hint).toContain("nemoclaw my-sandbox recover");
  });

  it("fails verification when the API host forward answers with a server error", async () => {
    const { run } = runWithApiHostCode(502);

    const result = await run();

    expect(result.healthy).toBe(false);
    expect(result.diagnostics.find((d) => d.link === "api")?.detail).toContain("502");
  });

  it("accepts an authenticated API host forward (HTTP 401)", async () => {
    // Bearer auth is enabled on the Hermes API; 401 still proves the forward
    // reaches a live listener.
    const { run } = runWithApiHostCode(401);

    expect((await run()).healthy).toBe(true);
  });

  it("keeps a single host probe for agents without a separate API port", async () => {
    // Regression lock: OpenClaw declares no gateway port, so buildChain falls
    // back to the dashboard port and no API probe or diagnostic is added.
    const openClawChain = buildChain({ chatUiUrl: "http://127.0.0.1:18789" });
    const hostProbes: Array<{ port: number; path: string }> = [];
    const deps = makeDeps({
      probeHostPort: (port: number, path: string) => {
        hostProbes.push({ port, path });
        return 200;
      },
    });

    const result = await verifyDeployment("my-sandbox", openClawChain, deps, NO_RETRY);

    expect(hostProbes).toEqual([{ port: 18789, path: "/health" }]);
    expect(result.diagnostics.some((d) => d.link === "api")).toBe(false);
    expect(result.verification.agentApiReachable).toBeNull();
    expect(result.healthy).toBe(true);
  });
});
