// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { verifyDeployment, formatVerificationDiagnostics } from "../../dist/lib/verify-deployment.js";
import { buildChain } from "../../dist/lib/dashboard/contract.js";

const chain = buildChain();

// Tests run probes with no inter-attempt delay so the suite stays fast.
// Production callers use the default DEFAULT_RETRY_DELAYS_MS.
const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: (_name: string, _script: string) => ({ status: 0, stdout: "200", stderr: "" }),
    probeHostPort: (_port: number, _path: string) => 200,
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    getMessagingChannels: (_name: string) => [] as string[],
    providerExistsInGateway: (_name: string) => true,
    ...overrides,
  };
}

describe("verifyDeployment", () => {
  it("reports healthy when gateway and dashboard reachable", async () => {
    const result = await verifyDeployment("my-sandbox", chain, makeDeps(), NO_RETRY);
    expect(result.healthy).toBe(true);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
  });

  it("treats HTTP 401 as gateway alive (device auth enabled — fixes #2342)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "401", stderr: "" }),
      probeHostPort: () => 401,
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(true);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
  });

  it("reports unhealthy when gateway returns 000 (not running)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
    const gwDiag = result.diagnostics.find((d) => d.link === "gateway");
    expect(gwDiag?.status).toBe("fail");
    expect(gwDiag?.hint).toContain("openshell-gateway.log");
  });

  it("hint surfaces both the in-sandbox gateway log (via nemoclaw logs) and the host OpenShell log (#3563)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    const gwDiag = result.diagnostics.find((d) => d.link === "gateway");
    // In-sandbox gateway log surfaced via the documented CLI, not a raw `docker exec` hint.
    expect(gwDiag?.hint).toContain("nemoclaw my-sandbox logs");
    expect(gwDiag?.hint).toContain("/tmp/gateway.log");
    // Host-side OpenShell gateway log covers the createSandbox-never-came-up case.
    expect(gwDiag?.hint).toContain(".local/state/nemoclaw/openshell-docker-gateway");
    // The retry budget makes the old false-positive timing claim go away — no
    // bare "Check /tmp/gateway.log inside the sandbox" instruction anymore.
    expect(gwDiag?.hint).not.toContain("Check /tmp/gateway.log inside the sandbox");
  });

  it("reports unhealthy when sandbox is unreachable (SSH failed)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => null,
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
  });

  it("reports unhealthy when dashboard port forward is down", async () => {
    const deps = makeDeps({
      probeHostPort: () => 0,
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(false);
    expect(result.verification.dashboardReachable).toBe(false);
    const dashDiag = result.diagnostics.find((d) => d.link === "dashboard");
    expect(dashDiag?.status).toBe("fail");
    expect(dashDiag?.hint).toContain("forward");
  });

  it("inference failure is a warning, not a blocker", async () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("inference.local")) {
          return { status: 0, stdout: "000", stderr: "" };
        }
        // Gateway probe — return 200
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(true); // inference is non-blocking
    expect(result.verification.inferenceRouteWorking).toBe(false);
    const infDiag = result.diagnostics.find((d) => d.link === "inference");
    expect(infDiag?.status).toBe("warn");
  });

  it("messaging failure is a warning, not a blocker", async () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["slack", "discord"],
      providerExistsInGateway: (name: string) => name !== "discord",
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(true); // messaging is non-blocking
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("discord");
  });

  it("detects gateway version from openclaw --version", async () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.4.24", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.gatewayVersion).toBe("2026.4.24");
  });

  it("reports null version when gateway is down (skips version probe)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.gatewayVersion).toBeNull();
  });

  it("detects access method from chain configuration", async () => {
    // Default chain (localhost)
    const result = await verifyDeployment("my-sandbox", chain, makeDeps(), NO_RETRY);
    expect(result.verification.accessMethod).toBe("localhost");

    // Non-loopback chain (proxy)
    const proxyChain = buildChain({ chatUiUrl: "https://187890-abc.brevlab.com" });
    const result2 = await verifyDeployment("my-sandbox", proxyChain, makeDeps(), NO_RETRY);
    expect(result2.verification.accessMethod).toBe("proxy");
  });

  it("reports HTTP 502 as gateway not running", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "502", stderr: "" }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
  });

  it("inference route working when HTTP response received (even 401)", async () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("inference.local")) {
          return { status: 0, stdout: "401", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.inferenceRouteWorking).toBe(true);
  });

  it("retries the gateway probe and recovers when the gateway comes up late (#3563)", async () => {
    let gatewayCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.4.24", stderr: "" };
        }
        if (script.includes("inference.local")) {
          return { status: 0, stdout: "200", stderr: "" };
        }
        gatewayCalls += 1;
        // First two attempts fail (gateway still starting), third succeeds.
        const code = gatewayCalls <= 2 ? "000" : "200";
        return { status: 0, stdout: code, stderr: "" };
      },
    });
    const sleepCalls: number[] = [];
    const result = await verifyDeployment("my-sandbox", chain, deps, {
      retryDelaysMs: [10, 10, 10],
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });
    expect(result.healthy).toBe(true);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(gatewayCalls).toBe(3);
    expect(sleepCalls).toEqual([10, 10]);
  });

  it("retries the dashboard probe and recovers when the port forward comes up late (#3563)", async () => {
    let dashboardCalls = 0;
    const deps = makeDeps({
      probeHostPort: (_port: number, _path: string) => {
        dashboardCalls += 1;
        return dashboardCalls <= 1 ? 0 : 200;
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, {
      retryDelaysMs: [10],
      sleep: async () => {},
    });
    expect(result.healthy).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
    expect(dashboardCalls).toBe(2);
  });

  it("gives up after retry budget is exhausted and surfaces the last failure detail", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
      probeHostPort: () => 0,
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, {
      retryDelaysMs: [10, 10],
      sleep: async () => {},
    });
    expect(result.healthy).toBe(false);
    const gwDiag = result.diagnostics.find((d) => d.link === "gateway");
    expect(gwDiag?.detail).toContain("HTTP 0");
  });
});

describe("formatVerificationDiagnostics", () => {
  it("prints success message when healthy", async () => {
    const result = await verifyDeployment("my-sandbox", chain, makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.4.24", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    }), NO_RETRY);
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("verified"))).toBe(true);
    expect(lines.some((l) => l.includes("2026.4.24"))).toBe(true);
  });

  it("prints failure diagnostics with hints when unhealthy", async () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
      probeHostPort: () => 0,
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("issues"))).toBe(true);
    expect(lines.some((l) => l.includes("gateway"))).toBe(true);
  });
});
