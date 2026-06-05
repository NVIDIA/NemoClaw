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

  it("warns when an expected channel is absent from the runtime config entirely (stale rebuild)", async () => {
    // Registry says telegram is enabled, but a stale or bad rebuild
    // produced an openclaw.json with no `channels.telegram` block. The
    // probe extracts no channels from the file, so neither visibleChannels
    // nor configuredButNotRunning mention telegram — yet the registry
    // expects it. verifyDeployment must catch this by comparing the
    // expected set against `visibleChannels` directly.
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: [],
        configuredChannels: [],
        configuredButNotRunning: [],
        logProbeOk: true,
        detail: "config + log corroborated (empty channels block)",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    expect(result.verification.messagingRuntimeChannelsMissing).toEqual(["telegram"]);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.detail).toContain("configured but not in OpenClaw runtime: telegram");
  });

  it("warns when a configured channel is configured but the runtime never started it (#4156)", async () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: [],
        configuredChannels: ["telegram"],
        configuredButNotRunning: ["telegram"],
        logProbeOk: true,
        detail: "config /sandbox/.openclaw/openclaw.json parsed and gateway log /tmp/gateway.log corroborated",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    expect(result.verification.messagingRuntimeChannelsMissing).toEqual(["telegram"]);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("configured but not in OpenClaw runtime: telegram");
    expect(msgDiag?.hint).toContain("No channels found");
    // Hint should mention both layers neutrally (config file + log) since
    // the cause could be either a stale rebuild or a runtime failure
    // (CodeRabbit catch on PR #4182). It must not point at only the log.
    expect(msgDiag?.hint).toContain("openclaw.json");
    expect(msgDiag?.hint).toContain("logs");
    expect(msgDiag?.hint).not.toContain("no startup entries");
  });

  it("does not falsely warn when runtime probe corroborates every configured channel", async () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: ["telegram"],
        configuredChannels: ["telegram"],
        configuredButNotRunning: [],
        logProbeOk: true,
        detail: "config + log corroborated",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingBridgesHealthy).toBe(true);
    expect(result.verification.messagingRuntimeChannelsMissing).toEqual([]);
    expect(result.diagnostics.find((d) => d.link === "messaging")).toBeUndefined();
  });

  it("warns when the gateway log is unavailable so the runtime layer cannot corroborate", async () => {
    // Provider attached, config has the channel, but the gateway log is
    // unreadable (sandbox just rebuilt, log not yet created). The probe
    // can only confirm config — we must surface that as a warn rather
    // than claim runtime verification. The probe now returns
    // `visibleChannels: []` when `logProbeOk` is false so callers cannot
    // accidentally treat config-only as healthy, and verifyDeployment
    // must NOT then flag every configured channel as missing.
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: [],
        configuredChannels: ["telegram"],
        configuredButNotRunning: [],
        logProbeOk: false,
        detail: "config /sandbox/.openclaw/openclaw.json parsed; gateway log /tmp/gateway.log unreadable, runtime confirmation skipped",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    // No false-positive "configured but not in OpenClaw runtime" — we
    // simply do not have enough evidence to make that claim.
    expect(result.verification.messagingRuntimeChannelsMissing).toBeNull();
    expect(result.verification.messagingConfigChannelsMissing).toEqual([]);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("runtime gateway log not yet available");
    expect(msgDiag?.detail).not.toContain("configured but not in OpenClaw runtime");
  });

  it("flags a stale rebuild even when the gateway log is unavailable (config-only diff)", async () => {
    // Registry expects telegram but openclaw.json never had the channel
    // block — and the gateway log is unreadable, so the runtime layer
    // cannot corroborate. Earlier revisions of this fix masked the
    // mismatch behind the log warning; this test pins the new
    // configMissing surface that exposes config-only mismatches even
    // without log corroboration (CodeRabbit on PR #4182).
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: [],
        configuredChannels: [],
        configuredButNotRunning: [],
        logProbeOk: false,
        detail: "config /sandbox/.openclaw/openclaw.json parsed; gateway log /tmp/gateway.log unreadable, runtime confirmation skipped",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    expect(result.verification.messagingRuntimeChannelsMissing).toBeNull();
    expect(result.verification.messagingConfigChannelsMissing).toEqual(["telegram"]);
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("missing from sandbox config: telegram");
    expect(msgDiag?.hint).toContain("openclaw.json");
    expect(msgDiag?.hint).toContain("rebuild");
  });

  it("surfaces an inconclusive runtime probe as a messaging warn (catches malformed openclaw.json #4156)", async () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: false,
        visibleChannels: [],
        configuredChannels: [],
        configuredButNotRunning: [],
        logProbeOk: false,
        detail: "runtime channel config /sandbox/.openclaw/openclaw.json is missing or empty",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    // The provider is attached but the runtime config could not be read —
    // that is exactly the gap the probe was added to catch (#4156), so it
    // must surface as a warn diagnostic, not silently pass.
    expect(result.verification.messagingBridgesHealthy).toBe(false);
    expect(result.verification.messagingRuntimeChannelsMissing).toBeNull();
    const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
    expect(msgDiag?.status).toBe("warn");
    expect(msgDiag?.detail).toContain("runtime channel probe inconclusive");
    expect(msgDiag?.hint).toContain("openclaw.json");
  });

  it("skips runtime probe entirely when no channels are configured", async () => {
    let probeCalls = 0;
    const deps = makeDeps({
      getMessagingChannels: () => [],
      probeChannelRuntimeStatus: () => {
        probeCalls += 1;
        return {
          ok: true,
          visibleChannels: [],
          configuredChannels: [],
          configuredButNotRunning: [],
          logProbeOk: true,
          detail: "x",
        };
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(probeCalls).toBe(0);
    expect(result.verification.messagingRuntimeChannelsMissing).toBeNull();
  });

  it("leaves messagingRuntimeChannelsMissing null when no probe dep is wired (e.g. Hermes)", async () => {
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram"],
      // no probeChannelRuntimeStatus
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.messagingRuntimeChannelsMissing).toBeNull();
    expect(result.verification.messagingBridgesHealthy).toBe(true);
  });

  it("detects gateway version from openclaw --version", async () => {
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.5.27", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.verification.gatewayVersion).toBe("2026.5.27");
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
          return { status: 0, stdout: "2026.5.27", stderr: "" };
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
          return { status: 0, stdout: "2026.5.27", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
    }), NO_RETRY);
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("verified"))).toBe(true);
    expect(lines.some((l) => l.includes("2026.5.27"))).toBe(true);
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

  it("still surfaces messaging warnings alongside the healthy success line (#4156)", async () => {
    // The overall result is healthy (gateway + dashboard pass) but the
    // runtime never started telegram. Pre-fix the warning was silently
    // dropped on the healthy path; the user only learned of the failure
    // from the dashboard's "No channels found" panel later.
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        if (script.includes("openclaw --version")) {
          return { status: 0, stdout: "2026.5.18", stderr: "" };
        }
        return { status: 0, stdout: "200", stderr: "" };
      },
      getMessagingChannels: () => ["telegram"],
      providerExistsInGateway: () => true,
      probeChannelRuntimeStatus: () => ({
        ok: true,
        visibleChannels: [],
        configuredChannels: ["telegram"],
        configuredButNotRunning: ["telegram"],
        logProbeOk: true,
        detail: "config + log corroborated",
      }),
    });
    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);
    expect(result.healthy).toBe(true);
    const lines = formatVerificationDiagnostics(result);
    expect(lines.some((l) => l.includes("verified"))).toBe(true);
    expect(lines.some((l) => l.includes("messaging:"))).toBe(true);
    expect(lines.some((l) => l.includes("configured but not in OpenClaw runtime: telegram"))).toBe(true);
  });
});
