// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  canFallbackToDockerGpuCompatibility,
  type DockerGpuRouteConfig,
  type DockerGpuRouteOptions,
  type DockerGpuRoutePlan,
  initialDockerGpuRoute,
  isDockerGpuCompatibilityRoute,
  resolveDockerGpuRoutePlan,
  supportsDockerGpuCompatibility,
} from "./docker-gpu-route";

const GPU_CONFIG = { sandboxGpuEnabled: true };
const LINUX_DOCKER: DockerGpuRouteOptions = {
  dockerDriverGateway: true,
  platform: "linux",
  dockerDesktopWsl: false,
  env: {},
};

describe("resolveDockerGpuRoutePlan", () => {
  const controls = [undefined, "auto", "fallback", "0", "1", "true"] as const;
  const environments = [
    {
      name: "GPU disabled",
      config: { sandboxGpuEnabled: false },
      options: LINUX_DOCKER,
      expected: ["none", "none", "none", "none", "none", "none"],
    },
    {
      name: "non-Docker driver",
      config: GPU_CONFIG,
      options: { ...LINUX_DOCKER, dockerDriverGateway: false },
      expected: [
        "native-only",
        "native-only",
        "native-only",
        "native-only",
        "native-only",
        "native-only",
      ],
    },
    {
      name: "non-Linux host",
      config: GPU_CONFIG,
      options: { ...LINUX_DOCKER, platform: "darwin" as const },
      expected: [
        "native-only",
        "native-only",
        "native-only",
        "native-only",
        "native-only",
        "native-only",
      ],
    },
    {
      name: "ordinary Linux Docker",
      config: GPU_CONFIG,
      options: LINUX_DOCKER,
      expected: [
        "native-only",
        "native-only",
        "native-with-fallback",
        "native-only",
        "compatibility-only",
        "compatibility-only",
      ],
    },
    {
      name: "Docker Desktop WSL",
      config: GPU_CONFIG,
      options: { ...LINUX_DOCKER, dockerDesktopWsl: true, platform: "win32" as const },
      expected: [
        "compatibility-only",
        "compatibility-only",
        "compatibility-only",
        "compatibility-only",
        "compatibility-only",
        "compatibility-only",
      ],
    },
    {
      name: "Jetson/Tegra",
      config: { sandboxGpuEnabled: true, hostGpuPlatform: "jetson" },
      options: LINUX_DOCKER,
      expected: [
        "compatibility-only",
        "compatibility-only",
        "compatibility-only",
        "native-only",
        "compatibility-only",
        "compatibility-only",
      ],
    },
  ] as const;

  const routingMatrix: Array<{
    name: string;
    control: string;
    expected: DockerGpuRoutePlan;
    config: DockerGpuRouteConfig;
    options: DockerGpuRouteOptions;
  }> = environments.flatMap((environment) =>
    controls.map((control, index) => ({
      name: environment.name,
      control: control ?? "unset",
      expected: environment.expected[index],
      config: environment.config,
      options: {
        ...environment.options,
        env: control === undefined ? {} : { NEMOCLAW_DOCKER_GPU_PATCH: control },
        log: vi.fn(),
      },
    })),
  );

  it.each(routingMatrix)(
    "maps $name with control $control to $expected",
    ({ expected, config, options }) => {
      expect(resolveDockerGpuRoutePlan(config, options)).toBe(expected);
    },
  );

  it("covers every environment/control pair and every route-plan outcome (#6110)", () => {
    const matrixByKey = new Map(
      routingMatrix.map((row) => [`${row.name}:${row.control}`, row.expected]),
    );
    expect(routingMatrix).toHaveLength(environments.length * controls.length);
    expect(new Set(routingMatrix.map(({ expected }) => expected))).toEqual(
      new Set(["none", "native-only", "compatibility-only", "native-with-fallback"]),
    );
    expect(matrixByKey.get("Docker Desktop WSL:0")).toBe("compatibility-only");
    expect(matrixByKey.get("Jetson/Tegra:0")).toBe("native-only");
    expect(matrixByKey.get("ordinary Linux Docker:unset")).toBe("native-only");
    expect(matrixByKey.get("ordinary Linux Docker:auto")).toBe("native-only");
    expect(matrixByKey.get("ordinary Linux Docker:fallback")).toBe("native-with-fallback");
    expect(matrixByKey.get("ordinary Linux Docker:true")).toBe("compatibility-only");
    expect(matrixByKey.get("non-Linux host:true")).toBe("native-only");
  });

  it.each(["2", "yes", "on"])(
    "preserves legacy nonzero compatibility routing for $control with a removal warning (#6110)",
    (control) => {
      const log = vi.fn();
      const plan = resolveDockerGpuRoutePlan(GPU_CONFIG, {
        ...LINUX_DOCKER,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: control },
        log,
      });

      expect(plan).toBe("compatibility-only");
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/unrecognized.*compatibility-only/i));
      expect(log).toHaveBeenCalledWith(expect.stringContaining("removed in v0.1.0"));
      expect(initialDockerGpuRoute(plan)).toBe("compatibility");
    },
  );

  it.each([
    ["none", "none", false, false],
    ["native-only", "native", false, false],
    ["compatibility-only", "compatibility", true, false],
    ["native-with-fallback", "native", true, true],
  ] as const)("describes %s", (plan, initialRoute, compatibilitySupported, fallbackSupported) => {
    expect(initialDockerGpuRoute(plan)).toBe(initialRoute);
    expect(supportsDockerGpuCompatibility(plan)).toBe(compatibilitySupported);
    expect(canFallbackToDockerGpuCompatibility(plan)).toBe(fallbackSupported);
  });

  it("identifies only the selected compatibility route", () => {
    expect(isDockerGpuCompatibilityRoute("compatibility")).toBe(true);
    expect(isDockerGpuCompatibilityRoute("native")).toBe(false);
    expect(isDockerGpuCompatibilityRoute("none")).toBe(false);
  });

  it("keeps Docker Desktop WSL on compatibility and explains why zero is ignored", () => {
    const log = vi.fn();
    expect(
      resolveDockerGpuRoutePlan(GPU_CONFIG, {
        ...LINUX_DOCKER,
        dockerDesktopWsl: true,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
        log,
      }),
    ).toBe("compatibility-only");
    expect(log.mock.calls.map(([message]) => message).join("\n")).toMatch(
      /0 ignored on Docker Desktop WSL.*--no-gpu/s,
    );
  });
});
