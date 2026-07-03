// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import source directly so tests cannot pass against a stale build.
import "./nim";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("./nim");
const RUNNER_PATH = require.resolve("../runner");
const fs = require("fs");

function withFirmwareModel(model: string, fn: () => void): void {
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (p: string, ...args: unknown[]) => {
    if (p === "/sys/class/dmi/id/product_name") return model;
    if (p === "/sys/firmware/devicetree/base/model") return "";
    return origReadFileSync(p, ...args);
  };
  try {
    fn();
  } finally {
    fs.readFileSync = origReadFileSync;
  }
}

function loadNimWithMockedRunner(runCapture: Mock) {
  const runner = require(RUNNER_PATH);
  const originalRun = runner.run;
  const originalRunCapture = runner.runCapture;

  delete require.cache[NIM_DIST_PATH];
  runner.run = vi.fn();
  runner.runCapture = runCapture;
  const nimModule = require(NIM_DIST_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_DIST_PATH];
      runner.run = originalRun;
      runner.runCapture = originalRunCapture;
    },
  };
}

function nvidiaSmiRunner(smiOutput: string): Mock {
  return vi.fn((cmd: string | string[]) => {
    if (!Array.isArray(cmd)) throw new Error("expected argv array");
    if (cmd[0] === "nvidia-smi" && cmd.some((a: string) => a.includes("name,memory.total"))) {
      return smiOutput;
    }
    return "";
  });
}

// #3707: the Windows-ARM N1X iGPU (the denylisted JMJWOA-Generic placeholder
// that clears the bounded Docker CUDA proof) is memory-shared like Jetson and
// cannot serve a computeIntensive model in-loop, so detectGpu tags it
// computeConstrained. A genuine discrete NVIDIA GPU never reaches that path and
// must stay untagged.
describe("detectGpu computeConstrained tagging (#3707)", () => {
  // detectGpu applies an ARM64-Linux kernel-interface trust gate. Pin
  // /proc/driver/nvidia present so genuine discrete GPUs are trusted on the
  // arm64 CI runner (matches the detectGpu suite's default).
  let origExistsSync: typeof fs.existsSync | undefined;
  beforeEach(() => {
    origExistsSync = fs.existsSync;
    fs.existsSync = (p: string) =>
      p === "/proc/driver/nvidia" ? true : (origExistsSync as typeof fs.existsSync)(p);
  });
  afterEach(() => {
    if (origExistsSync) {
      fs.existsSync = origExistsSync;
      origExistsSync = undefined;
    }
  });

  it("marks the proof-passed N1X iGPU computeConstrained", () => {
    const { nimModule, restore } = loadNimWithMockedRunner(
      nvidiaSmiRunner("JMJWOA-Generic-GPU, 65471, 65000\n"),
    );
    const proveArm64WslDockerDesktopGpu = vi.fn(() => ({
      passed: true,
      timedOut: false,
      exitCode: 0,
      diagnostic: "",
    }));
    try {
      withFirmwareModel("Microsoft Corporation Virtual Machine", () => {
        expect(nimModule.detectGpu({ proveArm64WslDockerDesktopGpu })).toMatchObject({
          type: "nvidia",
          name: "JMJWOA-Generic-GPU",
          wslDockerDesktopGpuProofPassed: true,
          computeConstrained: true,
        });
      });
    } finally {
      restore();
    }
  });

  it("leaves a genuine discrete NVIDIA GPU unconstrained", () => {
    const { nimModule, restore } = loadNimWithMockedRunner(
      nvidiaSmiRunner("NVIDIA H100 80GB HBM3, 81920, 81000\n"),
    );
    try {
      const gpu = nimModule.detectGpu();
      expect(gpu).toMatchObject({ type: "nvidia", name: "NVIDIA H100 80GB HBM3" });
      expect(gpu).not.toHaveProperty("computeConstrained");
      expect(gpu).not.toHaveProperty("wslDockerDesktopGpuProofPassed");
    } finally {
      restore();
    }
  });
});
