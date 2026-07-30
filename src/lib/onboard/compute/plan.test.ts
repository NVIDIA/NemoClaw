// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isLinuxDockerDriverGatewayEnabled } from "../docker-driver-platform";
import {
  CURRENT_OPEN_SHELL_COMPUTE_PLANS,
  type OpenShellComputeCapabilitiesRegistry,
  type OpenShellComputePlan,
  type OpenShellComputePlanRegistry,
  OpenShellComputeSelectionError,
  resolveCurrentOpenShellComputePlan,
  resolveOpenShellComputeCapabilities,
  resolveOpenShellComputeSelection,
  resolvePersistedOpenShellComputeDriver,
  usesManagedDockerGateway,
} from "./plan";

const AUTO_DOCKER_PLAN: OpenShellComputePlan = {
  driverName: "docker",
  gatewayLauncher: "nemoclaw",
};

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

  it("resolves an internal Podman request without exposing public wiring (#7744)", () => {
    expect(
      resolveOpenShellComputeSelection({
        requestedDriver: "podman",
        autoPlan: AUTO_DOCKER_PLAN,
      }),
    ).toEqual({
      driverName: "podman",
      gatewayLauncher: "nemoclaw",
    });
  });

  it("keeps auto deterministic and preserves a persisted driver (#7744)", () => {
    expect(
      resolveOpenShellComputeSelection({
        requestedDriver: "auto",
        persistedDriver: "podman",
        autoPlan: AUTO_DOCKER_PLAN,
      }),
    ).toEqual({
      driverName: "podman",
      gatewayLauncher: "nemoclaw",
    });
    expect(
      resolveOpenShellComputeSelection({
        requestedDriver: "auto",
        autoPlan: AUTO_DOCKER_PLAN,
      }),
    ).toEqual(AUTO_DOCKER_PLAN);
  });

  it("collapses matching durable driver evidence and rejects drift (#7744)", () => {
    expect(
      resolvePersistedOpenShellComputeDriver([
        { source: "onboarding session", driverName: " podman " },
        { source: "sandbox registry", driverName: "podman" },
        { source: "empty legacy record", driverName: null },
      ]),
    ).toBe("podman");

    expect(() =>
      resolvePersistedOpenShellComputeDriver([
        { source: "onboarding session", driverName: "docker" },
        { source: "sandbox registry", driverName: "podman" },
      ]),
    ).toThrow(
      "Conflicting persisted OpenShell compute drivers: onboarding session='docker', sandbox registry='podman'.",
    );
  });

  it("rejects an explicit driver that differs from persisted identity (#7744)", () => {
    expect(() =>
      resolveOpenShellComputeSelection({
        requestedDriver: "podman",
        persistedDriver: "docker",
        autoPlan: AUTO_DOCKER_PLAN,
      }),
    ).toThrow(
      "Requested OpenShell compute driver 'podman' does not match existing sandbox driver 'docker'.",
    );
  });

  it("fails an unknown driver closed (#7744)", () => {
    expect(() =>
      resolveOpenShellComputeSelection({
        requestedDriver: "future-runtime",
        autoPlan: AUTO_DOCKER_PLAN,
      }),
    ).toThrow(OpenShellComputeSelectionError);
  });

  it("accepts an injected MXC-shaped plan without inheriting Podman lifecycle (#7744)", () => {
    const plans: OpenShellComputePlanRegistry = {
      ...CURRENT_OPEN_SHELL_COMPUTE_PLANS,
      mxc: {
        driverName: "mxc",
        gatewayLauncher: "openshell",
      },
    };

    expect(
      resolveOpenShellComputeSelection(
        {
          requestedDriver: "mxc",
          autoPlan: AUTO_DOCKER_PLAN,
        },
        plans,
      ),
    ).toEqual({
      driverName: "mxc",
      gatewayLauncher: "openshell",
    });

    const capabilities: OpenShellComputeCapabilitiesRegistry = {
      mxc: { hostLocalInference: false },
    };
    expect(resolveOpenShellComputeCapabilities({ driverName: "mxc" }, capabilities)).toEqual({
      hostLocalInference: false,
    });
  });

  it("keeps compute capabilities independent from gateway ownership", () => {
    expect(resolveOpenShellComputeCapabilities(CURRENT_OPEN_SHELL_COMPUTE_PLANS.docker)).toEqual({
      hostLocalInference: true,
    });
    expect(resolveOpenShellComputeCapabilities(CURRENT_OPEN_SHELL_COMPUTE_PLANS.podman)).toEqual({
      hostLocalInference: true,
    });
    expect(
      resolveOpenShellComputeCapabilities(CURRENT_OPEN_SHELL_COMPUTE_PLANS.kubernetes),
    ).toEqual({
      hostLocalInference: true,
    });
  });

  it("fails an unregistered compute capability profile closed", () => {
    expect(() => resolveOpenShellComputeCapabilities({ driverName: "mxc" })).toThrow(
      "has no registered capability profile",
    );
  });
});
