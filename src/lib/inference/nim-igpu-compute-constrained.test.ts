// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import source directly so tests cannot pass against a stale build.
import "./nim";
import { fittableOllamaModelTags, largestFittableOllamaModelTag } from "./ollama-model-registry";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("./nim");
const RUNNER_PATH = require.resolve("../runner");
const fs = require("fs");

// Route the firmware reads detectGpu makes without branching in the test body.
function withFirmwareModel(model: string, fn: () => void): void {
  const orig = fs.readFileSync;
  const overrides: Record<string, string> = {
    "/sys/class/dmi/id/product_name": model,
    "/sys/firmware/devicetree/base/model": "",
  };
  fs.readFileSync = (p: string, ...args: unknown[]) =>
    p in overrides ? overrides[p] : orig(p, ...args);
  try {
    fn();
  } finally {
    fs.readFileSync = orig;
  }
}

// Jetson/Tegra firmware: no DMI product_name, a devicetree model, and the
// /dev/nvhost-gpu node present. Kept branch-free via a lookup table.
function withJetsonFirmware(model: string, fn: () => void): void {
  const origRead = fs.readFileSync;
  const origExists = fs.existsSync;
  const readers: Record<string, () => string> = {
    "/sys/class/dmi/id/product_name": () => {
      throw new Error("ENOENT");
    },
    "/sys/firmware/devicetree/base/model": () => model,
  };
  fs.readFileSync = (p: string, ...args: unknown[]) =>
    p in readers ? readers[p]() : origRead(p, ...args);
  fs.existsSync = (p: string) => p === "/dev/nvhost-gpu" || origExists(p);
  try {
    fn();
  } finally {
    fs.readFileSync = origRead;
    fs.existsSync = origExists;
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

// Answer the `name,memory.total` nvidia-smi query with a fixed row set; every
// other command yields "" (a linear predicate, no branching).
function nvidiaSmiRunner(smiOutput: string): Mock {
  return vi.fn((cmd: string | string[]) =>
    Array.isArray(cmd) &&
    cmd[0] === "nvidia-smi" &&
    cmd.some((a: string) => a.includes("name,memory.total"))
      ? smiOutput
      : "",
  );
}

// Jetson path has no nvidia-smi; memory comes from `free -m`.
function freeMemoryRunner(freeOutput: string): Mock {
  return vi.fn((cmd: string | string[]) => {
    const argv = Array.isArray(cmd) ? cmd : [];
    return `${argv[0] ?? ""} ${argv[1] ?? ""}`.trim() === "free -m" ? freeOutput : "";
  });
}

// #3707: the Windows-ARM N1X iGPU (the denylisted JMJWOA-Generic placeholder
// that clears the bounded Docker CUDA proof) is memory-shared like Jetson and
// cannot serve a computeIntensive model in-loop, so detectGpu tags it
// computeConstrained and the Ollama bootstrap-model selector skips the
// computeIntensive 30B/35B entries. A genuine discrete NVIDIA GPU never reaches
// that path and must stay untagged.
describe("detectGpu computeConstrained tagging (#3707)", () => {
  // detectGpu applies an ARM64-Linux kernel-interface trust gate; pin
  // /proc/driver/nvidia present so genuine discrete GPUs are trusted on the
  // arm64 runner (matches the detectGpu suite default).
  let savedExistsSync: typeof fs.existsSync;
  beforeEach(() => {
    savedExistsSync = fs.existsSync;
    fs.existsSync = (p: string) => (p === "/proc/driver/nvidia" ? true : savedExistsSync(p));
  });
  afterEach(() => {
    fs.existsSync = savedExistsSync;
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

  it("excludes the computeIntensive Ollama defaults for the proof-passed N1X iGPU", () => {
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
        const gpu = nimModule.detectGpu({ proveArm64WslDockerDesktopGpu });
        const fittable = fittableOllamaModelTags(gpu);
        expect(fittable).not.toContain("qwen3.6:35b");
        expect(fittable).not.toContain("nemotron-3-nano:30b");
        expect(largestFittableOllamaModelTag(gpu)).toBe("qwen3.5:9b");
      });
    } finally {
      restore();
    }
  });

  it("marks a Jetson/Tegra GPU computeConstrained", () => {
    const free =
      "              total        used        free      shared  buff/cache   available\n" +
      "Mem:          65536        4096       50000         512       10928       60000\n" +
      "Swap:             0           0           0";
    const { nimModule, restore } = loadNimWithMockedRunner(freeMemoryRunner(free));
    try {
      withJetsonFirmware("NVIDIA Jetson AGX Orin\0", () => {
        expect(nimModule.detectGpu()).toMatchObject({
          type: "nvidia",
          platform: "jetson",
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
