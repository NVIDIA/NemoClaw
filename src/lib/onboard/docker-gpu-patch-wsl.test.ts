// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDockerGpuModeCandidates } from "./docker-gpu-patch";

describe("buildDockerGpuModeCandidates on Docker Desktop WSL (#5512)", () => {
  it("skips the CDI mode on Docker Desktop WSL even when CDI is advertised", () => {
    // Docker Desktop WSL advertises CDI dirs but has no usable nvidia.com/gpu
    // spec, so CDI fails the real recreate; the patch must use --gpus instead.
    const modes = buildDockerGpuModeCandidates("all", {
      cdiAvailable: true,
      dockerDesktopWsl: true,
    });
    expect(modes.map((mode) => mode.kind)).not.toContain("cdi");
    expect(modes[0]?.kind).toBe("gpus");
    expect(modes[0]?.args).toEqual(["--gpus", "all"]);
  });

  it("keeps CDI first on a non-Docker-Desktop-WSL host that advertises CDI", () => {
    const modes = buildDockerGpuModeCandidates("all", {
      cdiAvailable: true,
      dockerDesktopWsl: false,
    });
    expect(modes[0]?.kind).toBe("cdi");
    expect(modes[0]?.args).toEqual(["--device", "nvidia.com/gpu=all"]);
  });
});
