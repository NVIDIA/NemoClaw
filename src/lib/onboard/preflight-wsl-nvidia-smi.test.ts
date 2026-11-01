// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import { assessHost } from "./preflight";

const WSL_NVIDIA_SMI = "/usr/lib/wsl/lib/nvidia-smi";

// The stock WSL driver path answers with `listing`; PATH `nvidia-smi` answers with `pathListing`.
const assessWslHost = (listing: string, pathListing = "") =>
  assessHost({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu" },
    dockerInfoOutput: "",
    commandExistsImpl: () => false,
    runCaptureImpl: (command) => (command[0] === WSL_NVIDIA_SMI ? listing : pathListing),
  });

describe("assessHost NVIDIA GPU detection through the WSL nvidia-smi path", () => {
  it("finds the GPU on WSL when nvidia-smi is not on PATH", () => {
    const result = assessWslHost("GPU 0: NVIDIA RTX Spark N1X (UUID: GPU-1)");

    expect(result.isWsl).toBe(true);
    expect(result.hasNvidiaGpu).toBe(true);
  });

  it("tries the WSL path when PATH nvidia-smi lists no GPU", () => {
    const result = assessWslHost(
      "GPU 0: NVIDIA RTX Spark N1X (UUID: GPU-1)",
      "No devices were found",
    );

    expect(result.hasNvidiaGpu).toBe(true);
  });

  it("keeps placeholder devices so the bounded CUDA proof decides", () => {
    expect(assessWslHost("GPU 0: JMJWOA-Generic-GPU (UUID: GPU-1)").hasNvidiaGpu).toBe(true);
  });

  it.each([
    "No devices were found",
    "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
  ])("does not count the listing %j as a GPU", (listing) => {
    expect(assessWslHost(listing).hasNvidiaGpu).toBe(false);
  });

  it("does not probe the WSL path on a non-WSL host", () => {
    const result = assessHost({
      platform: "linux",
      env: {},
      release: "6.8.0-58-generic",
      readFileImpl: () => "Linux version 6.8.0-58-generic",
      dockerInfoOutput: "",
      commandExistsImpl: () => false,
      runCaptureImpl: (command) =>
        command[0] === WSL_NVIDIA_SMI ? "GPU 0: NVIDIA RTX Spark N1X (UUID: GPU-1)" : "",
    });

    expect(result.isWsl).toBe(false);
    expect(result.hasNvidiaGpu).toBe(false);
  });
});
