// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isLinuxDockerDriverGatewayEnabled } from "../docker-driver-platform";
import { resolveCurrentOpenShellComputePlan, usesManagedDockerGateway } from "./plan";

describe("current OpenShell compute plan", () => {
  it.each([
    {
      label: "Linux x64",
      platform: "linux" as const,
      arch: "x64" as const,
      driverName: "docker",
      gatewayLauncher: "nemoclaw",
    },
    {
      label: "Linux arm64",
      platform: "linux" as const,
      arch: "arm64" as const,
      driverName: "docker",
      gatewayLauncher: "nemoclaw",
    },
    {
      label: "Apple Silicon macOS",
      platform: "darwin" as const,
      arch: "arm64" as const,
      driverName: "docker",
      gatewayLauncher: "nemoclaw",
    },
    {
      label: "Intel macOS",
      platform: "darwin" as const,
      arch: "x64" as const,
      driverName: "kubernetes",
      gatewayLauncher: "openshell",
    },
    {
      label: "Windows x64",
      platform: "win32" as const,
      arch: "x64" as const,
      driverName: "kubernetes",
      gatewayLauncher: "openshell",
    },
  ])("preserves the existing driver and gateway-launch behavior on $label (#7744)", ({
    platform,
    arch,
    driverName,
    gatewayLauncher,
  }) => {
    expect(resolveCurrentOpenShellComputePlan(platform, arch)).toEqual({
      driverName,
      gatewayLauncher,
    });
    expect(isLinuxDockerDriverGatewayEnabled(platform, arch)).toBe(driverName === "docker");
  });

  it.each([
    { driverName: "docker", gatewayLauncher: "nemoclaw", expected: true },
    { driverName: "docker", gatewayLauncher: "openshell", expected: false },
    { driverName: "podman", gatewayLauncher: "nemoclaw", expected: false },
    { driverName: "mxc", gatewayLauncher: "nemoclaw", expected: false },
  ] as const)("reports Docker lifecycle ownership as $expected for $driverName with the $gatewayLauncher launcher (#7744)", ({
    driverName,
    gatewayLauncher,
    expected,
  }) => {
    expect(usesManagedDockerGateway({ driverName, gatewayLauncher })).toBe(expected);
  });
});
