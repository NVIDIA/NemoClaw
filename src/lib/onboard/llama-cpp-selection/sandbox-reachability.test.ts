// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/docker/run", () => ({
  dockerRun: vi.fn(),
  dockerCapture: vi.fn(),
}));

import { PORTABLE_HOST_GATEWAY_IP } from "../experimental/portable-profile";
import { prepareNativePodmanGatewayHostRuntime } from "../runtime-provider/podman-runtime-surfaces";
import {
  formatLlamaCppSandboxUnreachableMessage,
  probeLlamaCppSandboxReachability,
} from "./sandbox-reachability";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("probeLlamaCppSandboxReachability", () => {
  it("delegates a TCP probe on port 8081 (#11626)", async () => {
    const result = await probeLlamaCppSandboxReachability({
      inspectNetworkImpl: () => ({ subnet: "172.18.0.0/16", gatewayIp: "172.18.0.1" }),
      usesHostGatewayRouteImpl: () => false,
      runImpl: (args) => {
        expect(args.at(-1)).toBe("8081");
        return { status: 1, stderr: "nc: connect failed" };
      },
    });
    expect(result.reason).toBe("tcp_failed");
    expect(result.port).toBe(8081);
  });

  it("reports a portable route TCP failure as conclusive (#11626)", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const credential = "secret-portable-credential";
    const result = await probeLlamaCppSandboxReachability({
      inspectNetworkImpl: () => ({ subnet: "10.87.0.0/24" }),
      runImpl: () => ({ status: 1, stderr: `nc: connect failed: ${credential}` }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "tcp_failed",
      sandboxHostAddress: PORTABLE_HOST_GATEWAY_IP,
      usesHostGatewayRoute: false,
    });
    expect(result.detail).not.toContain(credential);
  });

  it("reports a native Podman route TCP failure as conclusive (#11626)", async () => {
    const gatewayRuntime = prepareNativePodmanGatewayHostRuntime({
      environment: {},
      platform: "linux",
      socketPath: "/run/user/1000/podman/podman.sock",
    });
    const result = await probeLlamaCppSandboxReachability({
      gatewayRuntime,
      platform: "linux",
      inspectNetworkImpl: () => ({ subnet: "10.88.0.0/16", gatewayIp: "10.88.0.1" }),
      runImpl: () => ({ status: 1, stderr: "nc: connect failed" }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "tcp_failed",
      sandboxHostAddress: PORTABLE_HOST_GATEWAY_IP,
      usesHostGatewayRoute: false,
      runtimeProviderId: "podman",
    });
  });

  it("reports a runtime host-gateway TCP failure as conclusive (#11626)", async () => {
    const gatewayRuntime = {
      ...prepareNativePodmanGatewayHostRuntime({
        environment: {},
        platform: "linux",
        socketPath: "/run/user/1000/podman/podman.sock",
      }),
      providerId: "docker",
      sandboxHostAddress: null,
    };
    const result = await probeLlamaCppSandboxReachability({
      gatewayRuntime,
      platform: "linux",
      inspectNetworkImpl: () => ({ subnet: "192.168.65.0/24", gatewayIp: "192.168.65.1" }),
      usesHostGatewayRouteImpl: () => true,
      runImpl: () => ({ status: 1, stderr: "nc: connect failed" }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "tcp_failed",
      sandboxHostAddress: null,
      usesHostGatewayRoute: true,
      runtimeProviderId: "docker",
    });
  });
});

describe("formatLlamaCppSandboxUnreachableMessage", () => {
  it("names loopback-only Docker publish and the dual bind (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
      subnet: "172.18.0.0/16",
      gatewayIp: "172.18.0.1",
    });
    expect(message).toContain("host.openshell.internal:8081");
    expect(message).toContain("-p 127.0.0.1:8081:8081");
    expect(message).toContain("-p 172.18.0.1:8081:8081");
    expect(message).toContain(
      "sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 8081 proto tcp",
    );
    expect(message).toContain("If the server runs in Docker");
    expect(message).toContain("If you run llama-server on the host");
    expect(message).toContain("keep 127.0.0.1:8081 reachable");
    expect(message).toContain("firewall rule alone cannot make a loopback-only listener reachable");
    expect(message).not.toContain("0.0.0.0");
  });

  it("keeps a placeholder gateway bind when inspect did not return an IP (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
    });
    expect(message).toContain("-p <docker-gateway-ip>:8081:8081");
    expect(message).toContain("docker network inspect openshell");
    expect(message).not.toContain("0.0.0.0");
  });

  it("names a non-bridge sandbox host and omits Docker publish guidance (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
      subnet: "10.88.0.0/16",
      gatewayIp: "10.88.0.1",
      sandboxHostAddress: "10.88.0.1",
      runtimeProviderId: "podman",
    });
    expect(message).toContain("host.openshell.internal:8081");
    expect(message).toContain("10.88.0.1:8081");
    expect(message).toContain("Keep 127.0.0.1:8081 reachable");
    expect(message).toContain("firewall rule alone cannot make a loopback-only listener reachable");
    expect(message).not.toContain("docker");
    expect(message).not.toContain("Docker");
    expect(message).not.toContain("-p 127.0.0.1:8081:8081");
  });

  it("uses the sandbox host address for a portable Docker-provider route (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
      subnet: "10.87.0.0/24",
      gatewayIp: "10.87.0.1",
      sandboxHostAddress: PORTABLE_HOST_GATEWAY_IP,
      runtimeProviderId: "docker",
    });
    expect(message).toContain(`${PORTABLE_HOST_GATEWAY_IP}:8081`);
    expect(message).toContain("Keep 127.0.0.1:8081 reachable");
    expect(message).toContain("firewall rule alone cannot make a loopback-only listener reachable");
    expect(message).not.toContain("docker run");
    expect(message).not.toContain("-p 127.0.0.1:8081:8081");
  });

  it("uses runtime host-gateway guidance without a UFW command (#11626)", () => {
    const message = formatLlamaCppSandboxUnreachableMessage({
      ok: false,
      reason: "tcp_failed",
      networkName: "openshell",
      subnet: "192.168.65.0/24",
      gatewayIp: "192.168.65.1",
      sandboxHostAddress: null,
      usesHostGatewayRoute: true,
      runtimeProviderId: "docker",
    });

    expect(message).toContain("runtime host-gateway mapping");
    expect(message).toContain("Keep 127.0.0.1:8081 reachable");
    expect(message).toContain("firewall rule alone cannot make a loopback-only listener reachable");
    expect(message).not.toContain("ufw");
    expect(message).not.toContain("Docker bridge IP");
    expect(message).not.toContain("-p 127.0.0.1:8081:8081");
  });
});
