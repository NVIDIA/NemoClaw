// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  __test,
  formatSandboxBridgeUnreachableMessage,
  isSandboxBridgeGatewayReachable,
  tryAutoApplyUfwRule,
} from "../../../dist/lib/onboard/gateway-sandbox-reachability";

describe("gateway sandbox reachability route modeling", () => {
  it("parses Docker network IPAM config for subnet and gateway", () => {
    expect(
      __test.parseDockerNetworkIpamConfig(
        '[{"Subnet":"fd00::/64","Gateway":"fd00::1"},{"Subnet":"172.19.0.0/16","Gateway":"172.19.0.1"}]',
      ),
    ).toEqual({ subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" });
  });

  it("mirrors OpenShell native Linux bridge host aliases", () => {
    const route = __test.buildOpenShellDockerRoute(
      "openshell-docker",
      { subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" },
      false,
    );
    expect(route?.routeKind).toBe("bridge_gateway");
    expect(route?.addHosts).toEqual([
      "host.docker.internal:172.19.0.1",
      "host.openshell.internal:172.19.0.1",
    ]);
  });

  it("mirrors OpenShell Docker Desktop and VM-backed host-gateway routing", () => {
    const route = __test.buildOpenShellDockerRoute(
      "openshell-docker",
      { subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" },
      true,
    );
    expect(route?.routeKind).toBe("host_gateway");
    expect(route?.addHosts).toEqual(["host.openshell.internal:host-gateway"]);
  });
});

describe("isSandboxBridgeGatewayReachable", () => {
  it("returns ok when the correctly-routed helper connects", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectNetworkImpl: () => ({ subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result).toEqual({
      ok: true,
      reason: "ok",
      networkName: "openshell-docker",
      subnet: "172.19.0.0/16",
      gatewayIp: "172.19.0.1",
      routeKind: "bridge_gateway",
    });
  });

  it("uses add-host aliases before the probe image", async () => {
    const seen: { args: readonly string[] } = { args: [] };
    await isSandboxBridgeGatewayReachable({
      networkName: "custom-net",
      port: 9090,
      timeoutSec: 7,
      inspectNetworkImpl: () => ({ subnet: "10.0.0.0/24", gatewayIp: "10.0.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args) => {
        seen.args = args;
        return { status: 0 };
      },
    });
    expect(seen.args).toContain("custom-net");
    expect(seen.args).toContain("--pull=missing");
    expect(seen.args).toContain("host.openshell.internal:10.0.0.1");
    const addHostIndex = seen.args.findIndex((arg) =>
      arg.includes("host.openshell.internal:10.0.0.1"),
    );
    const probeCommandIndex = seen.args.findIndex((arg) =>
      arg.includes("nc -zw7 host.openshell.internal 9090"),
    );
    expect(addHostIndex).toBeGreaterThanOrEqual(0);
    expect(probeCommandIndex).toBeGreaterThanOrEqual(0);
    expect(addHostIndex).toBeLessThan(probeCommandIndex);
    expect(seen.args.join(" ")).toContain("nc -zw7 host.openshell.internal 9090");
  });

  it("does not call a missing Docker network a firewall failure", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectNetworkImpl: () => undefined,
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
    expect(result.detail).toContain("not found");
  });

  it("does not call helper DNS failures firewall failures", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectNetworkImpl: () => ({ subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 1, stderr: "nc: bad address 'host.openshell.internal'" }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("probe_unavailable");
  });

  it("flags tcp_failed only after the OpenShell route was modeled", async () => {
    const result = await isSandboxBridgeGatewayReachable({
      inspectNetworkImpl: () => ({ subnet: "172.19.0.0/16", gatewayIp: "172.19.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: () => ({ status: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tcp_failed");
    expect(result.gatewayIp).toBe("172.19.0.1");
  });
});

describe("formatSandboxBridgeUnreachableMessage", () => {
  it("emits a UFW command only for bridge-gateway TCP failures", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      routeKind: "bridge_gateway",
      networkName: "openshell-docker",
      subnet: "172.19.0.0/16",
      gatewayIp: "172.19.0.1",
    });
    expect(msg).toContain("172.19.0.1:8080");
    expect(msg).toContain("ufw allow from 172.19.0.0/16 to 172.19.0.1 port 8080");
  });

  it("falls back to a subnet-only UFW command when the gateway IP is unavailable", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      routeKind: "bridge_gateway",
      networkName: "openshell-docker",
      subnet: "172.19.0.0/16",
    });
    expect(msg).toContain("ufw allow from 172.19.0.0/16 to any port 8080");
  });

  it("does not emit a UFW command when the probe is unavailable", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "probe_unavailable",
      detail: "Docker network not found",
    });
    expect(msg).toContain("Could not verify sandbox bridge reachability");
    expect(msg).toContain("continuing");
    expect(msg).not.toContain("ufw allow");
  });

  it("does not emit a UFW command for host-gateway routing failures", () => {
    const msg = formatSandboxBridgeUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      routeKind: "host_gateway",
      networkName: "openshell-docker",
      subnet: "172.19.0.0/16",
    });
    expect(msg).toContain("host-gateway");
    expect(msg).not.toContain("ufw allow");
  });
});

describe("tryAutoApplyUfwRule (#4265)", () => {
  type Call = { argv: readonly string[]; status: number; stdout?: string; stderr?: string };

  function makeRunner(calls: Call[]) {
    const recorded: string[][] = [];
    const runImpl = (argv: readonly string[]) => {
      recorded.push([...argv]);
      const idx = recorded.length - 1;
      const c = calls[idx];
      if (!c) return { status: 0, stdout: "", stderr: "" };
      return { status: c.status, stdout: c.stdout ?? "", stderr: c.stderr ?? "" };
    };
    return { runImpl, recorded };
  }

  const reach = {
    ok: false as const,
    reason: "tcp_failed" as const,
    routeKind: "bridge_gateway" as const,
    networkName: "openshell-docker",
    subnet: "172.18.0.0/16",
    gatewayIp: "172.18.0.1",
  };

  it("skips when the operator has not opted in", async () => {
    const { runImpl, recorded } = makeRunner([]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: false });
    expect(result).toEqual({ applied: false, reason: "not_opted_in" });
    expect(recorded).toHaveLength(0);
  });

  it("skips when subnet or gatewayIp is unknown", async () => {
    const { runImpl, recorded } = makeRunner([]);
    const result = await tryAutoApplyUfwRule(
      { ...reach, gatewayIp: undefined },
      { runImpl, optedIn: true },
    );
    expect(result).toEqual({ applied: false, reason: "no_subnet_or_gateway" });
    expect(recorded).toHaveLength(0);
  });

  it("returns sudo_unavailable when passwordless sudo fails", async () => {
    const { runImpl } = makeRunner([{ argv: ["sudo", "-n", "true"], status: 1 }]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: true });
    expect(result.reason).toBe("sudo_unavailable");
  });

  it("returns ufw_missing when ufw is not on PATH", async () => {
    const { runImpl } = makeRunner([
      { argv: ["sudo", "-n", "true"], status: 0 },
      { argv: ["sudo", "-n", "which", "ufw"], status: 1 },
    ]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: true });
    expect(result.reason).toBe("ufw_missing");
  });

  it("returns ufw_inactive when status reports inactive", async () => {
    const { runImpl } = makeRunner([
      { argv: ["sudo", "-n", "true"], status: 0 },
      { argv: ["sudo", "-n", "which", "ufw"], status: 0, stdout: "/usr/sbin/ufw" },
      { argv: ["sudo", "-n", "ufw", "status"], status: 0, stdout: "Status: inactive" },
    ]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: true });
    expect(result.reason).toBe("ufw_inactive");
  });

  it("returns ufw_rule_rejected when ufw exits non-zero on apply", async () => {
    const { runImpl } = makeRunner([
      { argv: ["sudo", "-n", "true"], status: 0 },
      { argv: ["sudo", "-n", "which", "ufw"], status: 0, stdout: "/usr/sbin/ufw" },
      { argv: ["sudo", "-n", "ufw", "status"], status: 0, stdout: "Status: active" },
      { argv: [], status: 1, stderr: "ufw: rule rejected" },
    ]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: true, port: 8080 });
    expect(result.reason).toBe("ufw_rule_rejected");
    expect(result.detail).toContain("rule rejected");
  });

  it("applies the narrow allow rule on the happy path", async () => {
    const { runImpl, recorded } = makeRunner([
      { argv: ["sudo", "-n", "true"], status: 0 },
      { argv: ["sudo", "-n", "which", "ufw"], status: 0, stdout: "/usr/sbin/ufw" },
      { argv: ["sudo", "-n", "ufw", "status"], status: 0, stdout: "Status: active" },
      { argv: [], status: 0, stdout: "Rule added" },
    ]);
    const result = await tryAutoApplyUfwRule(reach, { runImpl, optedIn: true, port: 8080 });
    expect(result).toEqual({ applied: true, reason: "applied", detail: "Rule added" });
    expect(recorded[3]).toEqual([
      "sudo", "-n", "ufw", "allow",
      "from", "172.18.0.0/16",
      "to", "172.18.0.1",
      "port", "8080", "proto", "tcp",
    ]);
  });
});
