// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type DockerGpuRoutePlan,
  resolveDockerGpuSandboxCreatePlan,
} from "./docker-gpu-sandbox-create";

describe("resolveDockerGpuSandboxCreatePlan", () => {
  type RouteCase = {
    label: string;
    gpuEnabled?: boolean;
    hostGpuPlatform?: string;
    control?: string;
    dockerDriverGateway?: boolean;
    dockerDesktopWsl?: boolean;
    platform?: NodeJS.Platform;
    expected: DockerGpuRoutePlan;
  };

  it.each<RouteCase>([
    { label: "GPU disabled", gpuEnabled: false, expected: "none" },
    { label: "ordinary Linux default", expected: "native-only" },
    {
      label: "ordinary Linux auto",
      control: "auto",
      expected: "native-only",
    },
    {
      label: "ordinary Linux explicit fallback",
      control: "fallback",
      expected: "native-with-fallback",
    },
    { label: "ordinary Linux opt-out", control: "0", expected: "native-only" },
    {
      label: "ordinary Linux forced compatibility",
      control: "1",
      expected: "compatibility-only",
    },
    {
      label: "ordinary Linux legacy nonzero",
      control: "2",
      expected: "compatibility-only",
    },
    {
      label: "non-Docker driver",
      dockerDriverGateway: false,
      expected: "native-only",
    },
    {
      label: "non-Linux Docker driver",
      platform: "darwin",
      expected: "native-only",
    },
    {
      label: "Docker Desktop WSL default",
      dockerDesktopWsl: true,
      expected: "compatibility-only",
    },
    {
      label: "Jetson default",
      hostGpuPlatform: "jetson",
      expected: "compatibility-only",
    },
    {
      label: "Jetson auto",
      hostGpuPlatform: "jetson",
      control: "auto",
      expected: "compatibility-only",
    },
    {
      label: "Jetson opt-out",
      hostGpuPlatform: "jetson",
      control: "0",
      expected: "native-only",
    },
  ])("resolves $label to $expected", (testCase) => {
    const log = vi.fn();
    const result = resolveDockerGpuSandboxCreatePlan(
      {
        sandboxGpuEnabled: testCase.gpuEnabled ?? true,
        hostGpuPlatform: testCase.hostGpuPlatform,
      },
      {
        dockerDriverGateway: testCase.dockerDriverGateway ?? true,
        dockerDesktopWsl: testCase.dockerDesktopWsl ?? false,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: testCase.control },
        platform: testCase.platform ?? "linux",
        log,
      },
    );

    expect(result.gpuRoutePlan).toBe(testCase.expected);
  });

  it("ignores opt-out on Docker Desktop WSL", () => {
    const log = vi.fn();

    const result = resolveDockerGpuSandboxCreatePlan(
      { sandboxGpuEnabled: true },
      {
        dockerDriverGateway: true,
        dockerDesktopWsl: true,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
        platform: "linux",
        log,
      },
    );

    expect(result.gpuRoutePlan).toBe("compatibility-only");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ignored on Docker Desktop WSL"));
  });

  it("forwards the legacy nonzero warning through the create-plan boundary", () => {
    const log = vi.fn();

    const result = resolveDockerGpuSandboxCreatePlan(
      { sandboxGpuEnabled: true },
      {
        dockerDriverGateway: true,
        dockerDesktopWsl: false,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "true" },
        platform: "linux",
        log,
      },
    );

    expect(result.gpuRoutePlan).toBe("compatibility-only");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unrecognized.*compatibility-only/i));
  });
});
