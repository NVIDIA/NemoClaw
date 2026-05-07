// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { verifyDeployment, formatVerificationDiagnostics } from "../../dist/lib/verify-deployment.js";
import { buildChain } from "../../dist/lib/dashboard-contract.js";

const chain = buildChain();

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
  it("reports healthy when gateway and dashboard reachable", () => {
    const result = verifyDeployment("my-sandbox", chain, makeDeps());
    expect(result.healthy).toBe(true);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
  });

  it("treats HTTP 401 as gateway alive (device auth enabled — fixes #2342)", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "401", stderr: "" }),
      probeHostPort: () => 401,
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(true);
    expect(result.verification.gatewayReachable).toBe(true);
    expect(result.verification.dashboardReachable).toBe(true);
  });

  it("reports unhealthy when gateway returns 000 (not running)", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
    const gwDiag = result.diagnostics.find((d) => d.link === "gateway");
    expect(gwDiag?.status).toBe("fail");
    expect(gwDiag?.hint).toContain("gateway.log");
  });

  it("reports unhealthy when sandbox is unreachable (SSH failed)", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => null,
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
  });

  it("reports unhealthy when dashboard port forward is down", () => {
    const deps = makeDeps({
      probeHostPort: () => 0,
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.verification.dashboardReachable).toBe(false);
    const dashDiag = result.diagnostics.find((d) => d.link === "dashboard");
    expect(dashDiag?.status).toBe("fail");
    expect(dashDiag?.hint).toContain("forward");
  });

  it("inference failure is a warning, not a blocker", () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("inference.local")) {
          return { status: 0, stdout: "000", stderr: "" };
        }
        // Gateway probe — return 200
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(true); // inference is non-blocking
    expect(result.verification.inferenceRouteWorking).toBe(false);
    const infDiag = result.diagnostics.find((d) => d.link === "inference");
    expect(infDiag?.status).toBe("warn");
  });

  it("messaging failure is a warning, not a blocker", () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["slack", "discord"],
      providerExistsInGateway: (name: string) => name !== "discord",
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(true); // messaging is non-blocking
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("discord");
  });

  it("detects gateway version from openclaw --version", () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.4.24", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.verification.gatewayVersion).toBe("2026.4.24");
  });

  it("reports null version when gateway is down (skips version probe)", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.verification.gatewayVersion).toBeNull();
  });

  it("detects access method from chain configuration", () => {
    // Default chain (localhost)
    const result = verifyDeployment("my-sandbox", chain, makeDeps());
    expect(result.verification.accessMethod).toBe("localhost");

    // Non-loopback chain (proxy)
    const proxyChain = buildChain({ chatUiUrl: "https://187890-abc.brevlab.com" });
    const result2 = verifyDeployment("my-sandbox", proxyChain, makeDeps());
    expect(result2.verification.accessMethod).toBe("proxy");
  });

  it("reports HTTP 502 as gateway not running", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "502", stderr: "" }),
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.healthy).toBe(false);
    expect(result.verification.gatewayReachable).toBe(false);
  });

  it("inference route working when HTTP response received (even 401)", () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("inference.local")) {
          return { status: 0, stdout: "401", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    expect(result.verification.inferenceRouteWorking).toBe(true);
  });
});

describe("formatVerificationDiagnostics", () => {
  it("prints success message when healthy", () => {
    const result = verifyDeployment("my-sandbox", chain, makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.4.24", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    }));
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("verified"))).toBe(true);
    expect(lines.some((l) => l.includes("2026.4.24"))).toBe(true);
  });

  it("prints failure diagnostics with hints when unhealthy", () => {
    const deps = makeDeps({
      executeSandboxCommand: () => ({ status: 0, stdout: "000", stderr: "" }),
      probeHostPort: () => 0,
    });
    const result = verifyDeployment("my-sandbox", chain, deps);
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("issues"))).toBe(true);
    expect(lines.some((l) => l.includes("gateway"))).toBe(true);
  });
});
