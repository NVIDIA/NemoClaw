// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Focused coverage for the plausible-name Docker CUDA proof escape in
// detectGpu() (#9000). Lives outside nim.test.ts because that file is at its
// legacy line budget and cannot grow.

import { describe, expect, it, vi } from "vitest";
import { detectGpu } from "./nim";

const fs = require("fs");

const PLAUSIBLE_NAME = "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU)";

const isNvidiaSmiMemoryQuery = (command: readonly string[]): boolean =>
  command[0] === "nvidia-smi" && command.some((arg) => arg.includes("name,memory.total"));

const makeRunCapture = (smiOutput: string) =>
  vi.fn((command: readonly string[]) => (isNvidiaSmiMemoryQuery(command) ? smiOutput : ""));

const passingProver = () =>
  vi.fn(() => ({ passed: true, timedOut: false, exitCode: 0, diagnostic: "" }));

const failingProver = () =>
  vi.fn(() => ({ passed: false, timedOut: false, exitCode: 1, diagnostic: "proof failed" }));

function withProcessProperty(key: "arch" | "platform", value: string, fn: () => void): void {
  const origDesc = Object.getOwnPropertyDescriptor(process, key) as PropertyDescriptor;
  Object.defineProperty(process, key, { value, configurable: true, writable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, key, origDesc);
  }
}

function withLinuxArch(arch: string, fn: () => void): void {
  withProcessProperty("platform", "linux", () => {
    withProcessProperty("arch", arch, fn);
  });
}

// Generic (non-Spark/Station/Jetson) firmware so firmwareConfirmsNvidia stays
// false and the trust-tier gate is exercised.
function withGenericFirmware(fn: () => void): void {
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = ((p: unknown, ...args: unknown[]) =>
    p === "/sys/class/dmi/id/product_name"
      ? "Virtual Machine"
      : p === "/sys/firmware/devicetree/base/model"
        ? ""
        : origReadFileSync(p, ...args)) as typeof fs.readFileSync;
  try {
    fn();
  } finally {
    fs.readFileSync = origReadFileSync;
  }
}

function withNvidiaKernelInterface(present: boolean, fn: () => void): void {
  const origExistsSync = fs.existsSync;
  fs.existsSync = ((p: unknown) =>
    p === "/proc/driver/nvidia" ? present : origExistsSync(p)) as typeof fs.existsSync;
  try {
    fn();
  } finally {
    fs.existsSync = origExistsSync;
  }
}

function onWsl2Arm64WithoutKernelInterface(fn: () => void): void {
  withLinuxArch("arm64", () => {
    withGenericFirmware(() => {
      withNvidiaKernelInterface(false, fn);
    });
  });
}

describe("detectGpu CUDA proof for a plausible, non-placeholder NVIDIA GPU name (#9000)", () => {
  it("trusts one plausible, non-placeholder NVIDIA GPU name when the bounded CUDA proof passes (#9000)", () => {
    const prover = passingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      const result = detectGpu({
        proveArm64WslDockerDesktopGpu: prover,
        runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
        isWsl: true,
      });
      expect(result).toMatchObject({
        type: "nvidia",
        name: PLAUSIBLE_NAME,
        count: 1,
        totalMemoryMB: 8128,
        computeConstrained: true,
        wslDockerDesktopGpuProofPassed: true,
      });
      expect(prover).toHaveBeenCalledWith([PLAUSIBLE_NAME]);
    });
  });

  it("stays fail-closed for a plausible, non-placeholder NVIDIA GPU name when the CUDA proof fails (#9000)", () => {
    const prover = failingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
          isWsl: true,
        }),
      ).toBeNull();
      expect(prover).toHaveBeenCalledWith([PLAUSIBLE_NAME]);
    });
  });

  it("stays fail-closed for a plausible, non-placeholder NVIDIA GPU name when no prover is available (#9000)", () => {
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: null,
          runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
          isWsl: true,
        }),
      ).toBeNull();
    });
  });

  it("rejects an implausible single-row name without attempting the proof (#9000)", () => {
    const prover = passingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: makeRunCapture("Graphics Device, 8128, 7000\n"),
          isWsl: true,
        }),
      ).toBeNull();
      expect(prover).not.toHaveBeenCalled();
    });
  });

  it("rejects multiple plausible, non-placeholder NVIDIA GPU rows without attempting the proof (#9000)", () => {
    const prover = passingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: makeRunCapture(
            `${PLAUSIBLE_NAME}, 8128, 7000\nNVIDIA GeForce RTX 4090 Laptop GPU, 16376, 15000\n`,
          ),
          isWsl: true,
        }),
      ).toBeNull();
      expect(prover).not.toHaveBeenCalled();
    });
  });

  it("keeps the kernel-interface trust path proof-free when /proc/driver/nvidia exists (#9000)", () => {
    const prover = passingProver();
    withLinuxArch("arm64", () => {
      withGenericFirmware(() => {
        withNvidiaKernelInterface(true, () => {
          const result = detectGpu({
            proveArm64WslDockerDesktopGpu: prover,
            runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
            isWsl: true,
          });
          expect(result).toMatchObject({ type: "nvidia", name: PLAUSIBLE_NAME, count: 1 });
          expect(result?.wslDockerDesktopGpuProofPassed).toBeUndefined();
          expect(prover).not.toHaveBeenCalled();
        });
      });
    });
  });

  it("keeps x64 hosts on the historical trust path without a proof (#9000)", () => {
    const prover = passingProver();
    withLinuxArch("x64", () => {
      withGenericFirmware(() => {
        withNvidiaKernelInterface(false, () => {
          const result = detectGpu({
            proveArm64WslDockerDesktopGpu: prover,
            runCaptureImpl: makeRunCapture("NVIDIA GeForce RTX 4090, 24564, 24000\n"),
            isWsl: false,
          });
          expect(result).toMatchObject({ type: "nvidia", count: 1 });
          expect(prover).not.toHaveBeenCalled();
        });
      });
    });
  });
});

describe("detectGpu trust-gate rejection reasons (#9000)", () => {
  const collectReasons = () => {
    const reasons: string[] = [];
    return { reasons, onTrustGateRejection: (reason: string) => reasons.push(reason) };
  };

  it("reports the absent kernel interface when the CUDA proof fails (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: failingProver(),
          runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(reasons).toEqual(["/proc/driver/nvidia is absent and the bounded CUDA proof failed"]);
  });

  it("reports an unattempted proof when no prover is available (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: null,
          runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(reasons).toEqual([
      "/proc/driver/nvidia is absent and the bounded CUDA proof was not attempted",
    ]);
  });

  it("reports an unrecognized GPU name without attempting the proof (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    const prover = passingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: makeRunCapture("Graphics Device, 8128, 7000\n"),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(prover).not.toHaveBeenCalled();
    expect(reasons).toEqual([
      "nvidia-smi reported a GPU name that is not a recognized NVIDIA product and the bounded CUDA proof was not attempted",
    ]);
  });

  it("reports multiple GPU rows without attempting the proof (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    const prover = passingProver();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: makeRunCapture(
            `${PLAUSIBLE_NAME}, 8128, 7000\nNVIDIA GeForce RTX 4090 Laptop GPU, 16376, 15000\n`,
          ),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(prover).not.toHaveBeenCalled();
    expect(reasons).toEqual([
      "/proc/driver/nvidia is absent and the bounded CUDA proof was not attempted for multiple GPU rows",
    ]);
  });

  it("reports when the product-name filter rejects every GPU row (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    const prover = passingProver();
    withLinuxArch("x64", () => {
      withGenericFirmware(() => {
        expect(
          detectGpu({
            proveArm64WslDockerDesktopGpu: prover,
            runCaptureImpl: makeRunCapture("Graphics Device, 8128, 7000\n"),
            isWsl: false,
            onTrustGateRejection,
          }),
        ).toBeNull();
      });
    });
    expect(reasons).toEqual(["nvidia-smi reported no recognized NVIDIA GPU product names"]);
    expect(prover).not.toHaveBeenCalled();
  });

  it("reports a placeholder name rejected by the names-only fallback without attempting the proof (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    const prover = passingProver();
    const namesOnlyRunCapture = vi.fn((command: readonly string[]) =>
      isNvidiaSmiMemoryQuery(command)
        ? ""
        : command[0] === "nvidia-smi" && command.some((arg) => arg === "--query-gpu=name")
          ? "JMJWOA-Generic-GPU\n"
          : "",
    );
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: prover,
          runCaptureImpl: namesOnlyRunCapture,
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(prover).not.toHaveBeenCalled();
    expect(reasons).toEqual([
      "nvidia-smi reported a placeholder GPU name and the bounded CUDA proof was not attempted",
    ]);
  });

  it("reports the absent kernel interface in the names-only unified-memory check (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    const runCaptureImpl = vi.fn((command: readonly string[]) =>
      isNvidiaSmiMemoryQuery(command)
        ? ""
        : command[0] === "nvidia-smi" && command.some((arg) => arg === "--query-gpu=name")
          ? "NVIDIA Orin\n"
          : "",
    );
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: null,
          runCaptureImpl,
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(reasons).toEqual([
      "/proc/driver/nvidia is absent for the nvidia-smi names-only unified-memory check",
    ]);
  });

  it("reports a placeholder GPU name when its CUDA proof fails (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: failingProver(),
          runCaptureImpl: makeRunCapture("JMJWOA-Generic-GPU, 65471, 65000\n"),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).toBeNull();
    });
    expect(reasons).toEqual([
      "nvidia-smi reported a placeholder GPU name and the bounded CUDA proof failed",
    ]);
  });

  it("emits no rejection reason when the CUDA proof passes (#9000)", () => {
    const { reasons, onTrustGateRejection } = collectReasons();
    onWsl2Arm64WithoutKernelInterface(() => {
      expect(
        detectGpu({
          proveArm64WslDockerDesktopGpu: passingProver(),
          runCaptureImpl: makeRunCapture(`${PLAUSIBLE_NAME}, 8128, 7000\n`),
          isWsl: true,
          onTrustGateRejection,
        }),
      ).not.toBeNull();
    });
    expect(reasons).toEqual([]);
  });
});
