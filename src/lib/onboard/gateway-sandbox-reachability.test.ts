// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import through the compiled dist/ output (matches preflight.test.ts and
// gateway-tcp-readiness.test.ts patterns — coverage is attributed there).
import {
  isSandboxBridgeGatewayReachable,
  formatSandboxBridgeUnreachableMessage,
} from "../../../dist/lib/onboard/gateway-sandbox-reachability";

describe("isSandboxBridgeGatewayReachable", () => {
  it("returns ok when the probe container connects", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectSubnetImpl: () => "172.19.0.0/16",
      runImpl: () => ({ status: 0 }),
    });
    expect(result).toEqual({ ok: true, reason: "ok", subnet: "172.19.0.0/16" });
  });

  it("flags network_not_found when subnet inspect returns empty", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectSubnetImpl: () => undefined,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("network_not_found");
    expect(result.detail).toContain("openshell-docker");
  });

  it("flags tcp_failed when probe container exits non-zero", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectSubnetImpl: () => "172.19.0.0/16",
      runImpl: () => ({ status: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tcp_failed");
    expect(result.subnet).toBe("172.19.0.0/16");
  });

  it("flags probe_unavailable when docker cannot run the helper container", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectSubnetImpl: () => "172.19.0.0/16",
      runImpl: () => ({ status: 125, stderr: "docker: failed to pull image" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
    expect(result.detail).toContain("failed to pull image");
  });

  it("threads through configured network name + port to the probe argv", async () => {
    const seen: { args: readonly string[] } = { args: [] };
    await isSandboxBridgeGatewayReachable({
      networkName: "custom-net",
      port: 9090,
      timeoutSec: 7,
      inspectSubnetImpl: () => "10.0.0.0/24",
      runImpl: (args) => {
        seen.args = args;
        return { status: 0 };
      },
    });
    expect(seen.args).toContain("custom-net");
    expect(seen.args).toContain("--pull=missing");
    expect(seen.args.join(" ")).toContain("nc -zw7 host.openshell.internal 9090");
  });
});

describe("formatSandboxBridgeUnreachableMessage", () => {
  it("returns empty for an ok result", () => {
    expect(
      formatSandboxBridgeUnreachableMessage({ ok: true, reason: "ok", subnet: "x" }),
    ).toBe("");
  });

  it("emits the detected subnet in the actionable hint", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      subnet: "172.19.0.0/16",
    });
    expect(msg).toContain("172.19.0.0/16");
    expect(msg).toContain("ufw allow from 172.19.0.0/16 to any port 8080");
  });

  it("falls back to shell-detected subnet when none is captured", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
    });
    expect(msg).toContain("docker network inspect openshell-docker");
    expect(msg).toContain('ufw allow from "$SUBNET" to any port 8080');
  });

  it("uses a distinct message for network_not_found", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "network_not_found",
      detail: 'Docker network "openshell-docker" not found',
    });
    expect(msg).toContain("bridge network is missing");
    expect(msg).not.toContain("ufw allow");
  });

  it("uses a non-firewall message when the probe itself cannot run", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "probe_unavailable",
      detail: "docker: failed to pull image",
    });
    expect(msg).toContain("Could not run the sandbox bridge reachability probe");
    expect(msg).toContain("continuing");
    expect(msg).not.toContain("ufw allow");
  });
});
