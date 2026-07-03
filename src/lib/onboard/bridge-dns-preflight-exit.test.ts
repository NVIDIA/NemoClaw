// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({
  probeContainerDns: vi.fn(),
  probeDockerBridgeContainerStart: vi.fn(),
  probeHostDns: vi.fn(),
}));

vi.mock("./preflight", () => ({
  BUSYBOX_PROBE_IMAGE: "busybox@sha256:test",
  DEFAULT_HOST_DNS_PROBE_HOSTNAME: "integrate.api.nvidia.com",
  DOCKER_DESKTOP_WSL_INTEGRATION_HINT: "enable Docker Desktop WSL integration",
  getDockerBridgeGatewayIp: vi.fn(() => null),
  isFatalContainerDnsProbeFailure: vi.fn(() => true),
  isFatalHostDnsProbeFailure: vi.fn(() => true),
  probeContainerDns: probes.probeContainerDns,
  probeDockerBridgeContainerStart: probes.probeDockerBridgeContainerStart,
  probeHostDns: probes.probeHostDns,
}));

import { assertDockerBridgeAndContainerDnsHealthy } from "./bridge-dns-preflight";

const proxyKeys = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
const savedEnv = new Map(proxyKeys.map((key) => [key, process.env[key]]));
const savedProvider = process.env.NEMOCLAW_PROVIDER;
const savedSkip = process.env.NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT;

function restoreEnv(name: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, value === undefined ? {} : { [name]: value });
}

afterEach(() => {
  for (const key of proxyKeys) {
    restoreEnv(key, savedEnv.get(key));
  }
  restoreEnv("NEMOCLAW_PROVIDER", savedProvider);
  restoreEnv("NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT", savedSkip);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bridge and DNS fatal exit injection", () => {
  it("forwards the injected exit boundary through the host DNS gate", () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.NEMOCLAW_PROVIDER = "build";
    delete process.env.NEMOCLAW_SKIP_HOST_DNS_PREFLIGHT;
    probes.probeDockerBridgeContainerStart.mockReturnValue({ ok: true });
    probes.probeHostDns.mockReturnValue({
      ok: false,
      hostname: "integrate.api.nvidia.com",
      reason: "resolution_failed",
      details: "ENOTFOUND",
      timedOut: false,
    });
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`host DNS exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      assertDockerBridgeAndContainerDnsHealthy(
        {
          platform: "linux",
          isWsl: false,
          systemctlAvailable: true,
        } as Parameters<typeof assertDockerBridgeAndContainerDnsHealthy>[0],
        true,
        exitProcess,
      ),
    ).toThrow("host DNS exit:1");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(probes.probeContainerDns).not.toHaveBeenCalled();
  });
});
