// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import { assessHost } from "./preflight";

const WSL_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";

// `nvidia-smi` is off PATH; only the stock WSL driver path answers.
const runCaptureOnlyWslNvidiaSmi = (command: readonly string[]) =>
  command[0] === WSL_NVIDIA_SMI ? "GPU 0: NVIDIA RTX Spark N1X (UUID: GPU-1)" : "";

describe("assessHost NVIDIA GPU detection through the WSL nvidia-smi path", () => {
  it("finds the GPU on WSL when nvidia-smi is not on PATH", () => {
    const result = assessHost({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      dockerInfoOutput: "",
      commandExistsImpl: () => false,
      runCaptureImpl: runCaptureOnlyWslNvidiaSmi,
    });

    expect(result.isWsl).toBe(true);
    expect(result.hasNvidiaGpu).toBe(true);
  });

  it("does not probe the WSL path on a non-WSL host", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      dockerInfoOutput: "",
      commandExistsImpl: () => false,
      runCaptureImpl: runCaptureOnlyWslNvidiaSmi,
    });

    expect(result.isWsl).toBe(false);
    expect(result.hasNvidiaGpu).toBe(false);
  });
});
