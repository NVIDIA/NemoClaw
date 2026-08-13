// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureNvidiaSmi,
  isDenylistedNvidiaGpuName,
  isPlausibleNvidiaGpuName,
  nvidiaHostLooksGenuine,
  resolveNvidiaSmiCommand,
  WSL_NVIDIA_SMI_PATH,
} from "./gpu-trust";

const originalDescriptors = new Map<"arch" | "platform", PropertyDescriptor | undefined>();
const originalExistsSync = fs.existsSync;

function withProcessProperty<K extends "arch" | "platform">(
  key: K,
  value: K extends "arch" ? NodeJS.Architecture : NodeJS.Platform,
  fn: () => void,
): void {
  if (!originalDescriptors.has(key)) {
    originalDescriptors.set(key, Object.getOwnPropertyDescriptor(process, key));
  }
  Object.defineProperty(process, key, {
    value,
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    const descriptor = originalDescriptors.get(key);
    if (descriptor) Object.defineProperty(process, key, descriptor);
  }
}

function withLinuxArm64(fn: () => void): void {
  withProcessProperty("platform", "linux", () => {
    withProcessProperty("arch", "arm64", fn);
  });
}

function withLinuxX64(fn: () => void): void {
  withProcessProperty("platform", "linux", () => {
    withProcessProperty("arch", "x64", fn);
  });
}

function withNvidiaKernelInterface(present: boolean, fn: () => void): void {
  fs.existsSync = (path: fs.PathLike) => {
    if (path === "/proc/driver/nvidia") return present;
    return originalExistsSync(path);
  };
  try {
    fn();
  } finally {
    fs.existsSync = originalExistsSync;
  }
}

afterEach(() => {
  fs.existsSync = originalExistsSync;
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
  }
  originalDescriptors.clear();
});

describe("GPU trust helpers", () => {
  it("keeps PATH nvidia-smi authoritative and skips the WSL fallback", () => {
    const runCaptureImpl = vi.fn<
      (command: readonly string[], options?: { ignoreError?: boolean }) => string
    >(() => "NVIDIA RTX 5090");

    expect(captureNvidiaSmi(["--query-gpu=name"], { isWsl: true, runCaptureImpl })).toBe(
      "NVIDIA RTX 5090",
    );
    expect(runCaptureImpl).toHaveBeenCalledTimes(1);
    expect(runCaptureImpl.mock.calls[0][0][0]).toBe("nvidia-smi");
  });

  it("resolves the stock WSL driver command for managed vLLM prerequisites (#8794)", () => {
    const runCaptureImpl = vi.fn((command: readonly string[]) =>
      command[4] === WSL_NVIDIA_SMI_PATH ? WSL_NVIDIA_SMI_PATH : "",
    );

    expect(resolveNvidiaSmiCommand({ isWsl: true, runCaptureImpl })).toBe(WSL_NVIDIA_SMI_PATH);
  });

  it("does not probe the WSL driver path outside WSL", () => {
    const runCaptureImpl = vi.fn<
      (command: readonly string[], options?: { ignoreError?: boolean }) => string
    >(() => "");

    expect(captureNvidiaSmi(["--query-gpu=name"], { isWsl: false, runCaptureImpl })).toBe("");
    expect(runCaptureImpl).toHaveBeenCalledTimes(1);
    expect(runCaptureImpl.mock.calls[0][0][0]).toBe("nvidia-smi");
  });

  it("deny-lists JMJWOA generic placeholder GPU names even with NVIDIA prefix", () => {
    expect(isDenylistedNvidiaGpuName("NVIDIA JMJWOA-Generic-GPU")).toBe(true);
    expect(isDenylistedNvidiaGpuName("JMJWOA-Generic-NPU")).toBe(true);
    expect(isPlausibleNvidiaGpuName("NVIDIA JMJWOA-Generic-GPU")).toBe(false);
  });

  it("accepts plausible NVIDIA product names that are not deny-listed", () => {
    expect(isPlausibleNvidiaGpuName("NVIDIA H100 80GB HBM3")).toBe(true);
    expect(isPlausibleNvidiaGpuName("RTX 6000 Ada")).toBe(true);
    expect(isPlausibleNvidiaGpuName("Qualcomm Adreno")).toBe(false);
  });

  it("fails closed on ARM64 Linux generic firmware without NVIDIA kernel interface", () => {
    withLinuxArm64(() => {
      withNvidiaKernelInterface(false, () => {
        expect(nvidiaHostLooksGenuine()).toBe(false);
      });
    });
  });

  it("trusts ARM64 Linux generic firmware only when NVIDIA kernel interface exists", () => {
    withLinuxArm64(() => {
      withNvidiaKernelInterface(true, () => {
        expect(nvidiaHostLooksGenuine()).toBe(true);
      });
    });
  });

  it("keeps historical x86_64 Linux nvidia-smi trust behavior", () => {
    withLinuxX64(() => {
      withNvidiaKernelInterface(false, () => {
        expect(nvidiaHostLooksGenuine()).toBe(true);
      });
    });
  });
});
