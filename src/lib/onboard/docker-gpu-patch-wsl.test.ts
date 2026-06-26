// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildDockerGpuModeCandidates,
  shouldApplyDockerGpuPatch,
} from "../../../dist/lib/onboard/docker-gpu-patch";

describe("shouldApplyDockerGpuPatch on Docker Desktop WSL", () => {
  it("ignores NEMOCLAW_DOCKER_GPU_PATCH=0 on Docker Desktop WSL where the patch is required", () => {
    const logs: string[] = [];
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        {
          env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
          platform: "linux",
          dockerDriverGateway: true,
          dockerDesktopWsl: true,
          log: (message) => {
            logs.push(message);
          },
        },
      ),
    ).toBe(true);
    expect(logs.some((line) => /NEMOCLAW_DOCKER_GPU_PATCH=0 ignored/i.test(line))).toBe(true);
    expect(logs.some((line) => /NEMOCLAW_SANDBOX_GPU=0/.test(line))).toBe(true);
  });

  it("still honors NEMOCLAW_DOCKER_GPU_PATCH=0 when not on Docker Desktop WSL", () => {
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        {
          env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
          platform: "linux",
          dockerDriverGateway: true,
          dockerDesktopWsl: false,
        },
      ),
    ).toBe(false);
  });

  it("defaults the driver-gateway path on for Docker Desktop WSL", () => {
    expect(
      shouldApplyDockerGpuPatch(
        { sandboxGpuEnabled: true },
        {
          env: {},
          platform: "darwin",
          dockerDesktopWsl: true,
        },
      ),
    ).toBe(true);
  });
});

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
