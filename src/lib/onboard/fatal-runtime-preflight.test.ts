// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertCdiNvidiaGpuSpecPresent: vi.fn(),
  assertDockerBridgeAndContainerDnsHealthy: vi.fn(),
  assessHost: vi.fn(),
  detectGpu: vi.fn(),
  isLinuxDockerDriverGatewayEnabled: vi.fn(() => true),
  planHostRemediation: vi.fn(() => []),
  printRemediationActions: vi.fn(),
  resolveSandboxGpuConfig: vi.fn(),
  resolveSandboxGpuFlagFromOptions: vi.fn(),
  validateSandboxGpuPreflight: vi.fn(),
  warnIfHostProxyMissesLoopback: vi.fn(),
}));

vi.mock("../inference/nim", () => ({ detectGpu: mocks.detectGpu }));
vi.mock("./branding", () => ({ cliDisplayName: () => "NemoClaw" }));
vi.mock("./bridge-dns-preflight", () => ({
  assertDockerBridgeAndContainerDnsHealthy: mocks.assertDockerBridgeAndContainerDnsHealthy,
}));
vi.mock("./docker-driver-platform", () => ({
  isLinuxDockerDriverGatewayEnabled: mocks.isLinuxDockerDriverGatewayEnabled,
}));
vi.mock("./http-proxy-preflight", () => ({
  warnIfHostProxyMissesLoopback: mocks.warnIfHostProxyMissesLoopback,
}));
vi.mock("./preflight", () => ({
  assertCdiNvidiaGpuSpecPresent: mocks.assertCdiNvidiaGpuSpecPresent,
  assessHost: mocks.assessHost,
  planHostRemediation: mocks.planHostRemediation,
}));
vi.mock("./remediation", () => ({ printRemediationActions: mocks.printRemediationActions }));
vi.mock("./sandbox-gpu-mode", () => ({
  resolveSandboxGpuConfig: mocks.resolveSandboxGpuConfig,
}));
vi.mock("./sandbox-gpu-preflight", () => ({
  resolveSandboxGpuFlagFromOptions: mocks.resolveSandboxGpuFlagFromOptions,
  validateSandboxGpuPreflight: mocks.validateSandboxGpuPreflight,
}));

import { runFatalOnboardRuntimePreflight } from "./fatal-runtime-preflight";

const host = {
  dockerReachable: true,
  runtime: "docker",
  notes: [],
  cdiNvidiaGpuSpecMissing: false,
  cdiNvidiaGpuSpecNeedsRepair: false,
};
const gpu = { type: "nvidia", platform: "linux" };
const sandboxGpuConfig = {
  mode: "0",
  hostGpuDetected: true,
  hostGpuPlatform: "linux",
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assessHost.mockReturnValue(host);
  mocks.detectGpu.mockReturnValue(gpu);
  mocks.resolveSandboxGpuFlagFromOptions.mockReturnValue("disable");
  mocks.resolveSandboxGpuConfig.mockReturnValue(sandboxGpuConfig);
  mocks.isLinuxDockerDriverGatewayEnabled.mockReturnValue(true);
});

describe("fatal onboard runtime preflight", () => {
  it("sanitizes ambient GPU variables for an authoritative rebuild", () => {
    const env = {
      KEEP_ME: "yes",
      NEMOCLAW_SANDBOX_GPU: "1",
      NEMOCLAW_SANDBOX_GPU_DEVICE: "hostile-device",
    };
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit:${code}`);
    });

    runFatalOnboardRuntimePreflight(
      { authoritativeResumeConfig: true, sandboxGpu: "disable", sandboxGpuDevice: null },
      { nonInteractive: true, exitProcess, env },
    );

    const gpuOptions = mocks.resolveSandboxGpuConfig.mock.calls[0]?.[1];
    expect(gpuOptions.env).toEqual({ KEEP_ME: "yes" });
    expect(env.NEMOCLAW_SANDBOX_GPU).toBe("1");
    expect(env.NEMOCLAW_SANDBOX_GPU_DEVICE).toBe("hostile-device");
    expect(mocks.resolveSandboxGpuFlagFromOptions).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxGpu: "disable" }),
      exitProcess,
    );
    expect(mocks.assertCdiNvidiaGpuSpecPresent).toHaveBeenCalledWith(
      host,
      false,
      "linux",
      exitProcess,
    );
    expect(mocks.assertDockerBridgeAndContainerDnsHealthy).toHaveBeenCalledWith(
      host,
      true,
      exitProcess,
    );
    expect(mocks.validateSandboxGpuPreflight).toHaveBeenCalledWith(
      sandboxGpuConfig,
      {},
      exitProcess,
    );
  });

  it("preserves ambient GPU variables for ordinary onboarding", () => {
    const env = {
      NEMOCLAW_SANDBOX_GPU: "1",
      NEMOCLAW_SANDBOX_GPU_DEVICE: "0",
    };

    runFatalOnboardRuntimePreflight({}, { nonInteractive: false, env });

    expect(mocks.resolveSandboxGpuConfig.mock.calls[0]?.[1].env).toBe(env);
  });

  it("turns downstream fatal exits into throws through the injected boundary", () => {
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`fatal runtime exit:${code}`);
    });
    mocks.assertDockerBridgeAndContainerDnsHealthy.mockImplementation(
      (_host, _nonInteractive, exit) => exit(1),
    );

    expect(() =>
      runFatalOnboardRuntimePreflight(
        { authoritativeResumeConfig: true },
        { nonInteractive: true, exitProcess },
      ),
    ).toThrow("fatal runtime exit:1");
    expect(exitProcess).toHaveBeenCalledWith(1);
  });

  it("uses the injected fatal boundary when Docker is unreachable", () => {
    mocks.assessHost.mockReturnValue({ ...host, dockerReachable: false });
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`docker exit:${code}`);
    });

    expect(() =>
      runFatalOnboardRuntimePreflight({}, { nonInteractive: true, exitProcess }),
    ).toThrow("docker exit:1");
    expect(mocks.detectGpu).not.toHaveBeenCalled();
  });
});
