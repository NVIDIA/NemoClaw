// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { GpuDetection } from "../inference/nim";
import { getResumeSandboxGpuOverrides, resolveSandboxGpuConfig } from "./sandbox-gpu-mode";

function gpu(overrides: Partial<GpuDetection> = {}): GpuDetection {
  return {
    type: "nvidia",
    count: 1,
    totalMemoryMB: 24_000,
    perGpuMB: 24_000,
    nimCapable: true,
    ...overrides,
  };
}

describe("sandbox GPU mode helpers", () => {
  it("resolves sandbox GPU auto/force/disable modes", () => {
    const detectedGpu = gpu();
    expect(resolveSandboxGpuConfig(detectedGpu, { env: {} }).sandboxGpuEnabled).toBe(true);
    expect(
      resolveSandboxGpuConfig(detectedGpu, {
        env: { NEMOCLAW_SANDBOX_GPU: "0" },
      }).sandboxGpuEnabled,
    ).toBe(false);
    const forced = resolveSandboxGpuConfig(null, {
      flag: "enable",
      env: {},
    });
    expect(forced.mode).toBe("1");
    expect(forced.errors.join("\n")).toContain("no NVIDIA GPU");

    const disabled = resolveSandboxGpuConfig(detectedGpu, {
      flag: "disable",
      env: { NEMOCLAW_SANDBOX_GPU: "1", NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(disabled.mode).toBe("0");
    expect(disabled.sandboxGpuEnabled).toBe(false);
    expect(disabled.sandboxGpuDevice).toBeNull();
    expect(disabled.errors.join("\n")).toContain("requires sandbox GPU mode 1");
  });

  it("requires explicit sandbox GPU enablement before honoring a device selector", () => {
    const deviceOnlyWithGpu = resolveSandboxGpuConfig(gpu(), {
      env: { NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(deviceOnlyWithGpu.sandboxGpuDevice).toBeNull();
    expect(deviceOnlyWithGpu.errors.join("\n")).toContain("requires sandbox GPU mode 1");

    const deviceOnlyWithoutGpu = resolveSandboxGpuConfig(null, {
      env: { NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(deviceOnlyWithoutGpu.sandboxGpuEnabled).toBe(false);
    expect(deviceOnlyWithoutGpu.sandboxGpuDevice).toBeNull();
    expect(deviceOnlyWithoutGpu.errors.join("\n")).toContain("requires sandbox GPU mode 1");

    const envDisableWithDevice = resolveSandboxGpuConfig(gpu(), {
      env: { NEMOCLAW_SANDBOX_GPU: "0", NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(envDisableWithDevice.sandboxGpuEnabled).toBe(false);
    expect(envDisableWithDevice.sandboxGpuDevice).toBeNull();
    expect(envDisableWithDevice.errors.join("\n")).toContain("requires sandbox GPU mode 1");

    const explicitEnable = resolveSandboxGpuConfig(gpu(), {
      env: { NEMOCLAW_SANDBOX_GPU: "1", NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(explicitEnable.sandboxGpuEnabled).toBe(true);
    expect(explicitEnable.sandboxGpuDevice).toBe("nvidia.com/gpu=0");
    expect(explicitEnable.errors).toEqual([]);

    const explicitFlagEnable = resolveSandboxGpuConfig(gpu(), {
      flag: "enable",
      device: "nvidia.com/gpu=1",
      env: {},
    });
    expect(explicitFlagEnable.sandboxGpuEnabled).toBe(true);
    expect(explicitFlagEnable.sandboxGpuDevice).toBe("nvidia.com/gpu=1");
    expect(explicitFlagEnable.errors).toEqual([]);
  });

  it("defaults to CPU sandbox on Jetson when NEMOCLAW_SANDBOX_GPU is unset", () => {
    const jetson = gpu({ platform: "jetson" });
    expect(resolveSandboxGpuConfig(jetson, { env: {} }).sandboxGpuEnabled).toBe(false);
    const jetsonDeviceOnly = resolveSandboxGpuConfig(jetson, {
      env: { NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(jetsonDeviceOnly.sandboxGpuEnabled).toBe(false);
    expect(jetsonDeviceOnly.sandboxGpuDevice).toBeNull();
    expect(jetsonDeviceOnly.errors.join("\n")).toContain("requires sandbox GPU mode 1");
    const jetsonExplicitEnable = resolveSandboxGpuConfig(jetson, {
      env: { NEMOCLAW_SANDBOX_GPU: "1", NEMOCLAW_SANDBOX_GPU_DEVICE: "nvidia.com/gpu=0" },
    });
    expect(jetsonExplicitEnable.sandboxGpuEnabled).toBe(true);
    expect(jetsonExplicitEnable.sandboxGpuDevice).toBe("nvidia.com/gpu=0");
    expect(resolveSandboxGpuConfig(jetson, { flag: "enable", env: {} }).mode).toBe("1");
  });

  it("resumes sandbox GPU auto mode without turning CPU fallback into explicit opt-out", () => {
    const resumedAuto = getResumeSandboxGpuOverrides(
      { sandboxGpuMode: "auto", sandboxGpuDevice: null },
      false,
    );
    expect(resumedAuto).toEqual({ flag: null, device: null });
    expect(
      resolveSandboxGpuConfig(gpu(), { ...resumedAuto, env: {} }).sandboxGpuEnabled,
    ).toBe(true);

    const resumedDisabled = getResumeSandboxGpuOverrides(
      { sandboxGpuMode: "0", sandboxGpuDevice: null },
      false,
    );
    expect(
      resolveSandboxGpuConfig(gpu(), { ...resumedDisabled, env: {} }).sandboxGpuEnabled,
    ).toBe(false);

    const legacyGpuSession = getResumeSandboxGpuOverrides(null, true);
    expect(legacyGpuSession.flag).toBe("enable");
  });
});
