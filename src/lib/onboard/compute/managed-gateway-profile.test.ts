// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
  requiresHostSandboxBinaryForInstall,
  resolveManagedGatewayDriverProfile,
  resolveManagedGatewayRuntimeAdapter,
} from "./managed-gateway-profile";

describe("managed gateway driver profiles", () => {
  it("keeps Podman host-only and free of Docker cleanup capabilities", () => {
    const profile = resolveManagedGatewayDriverProfile({
      driverName: "podman",
      gatewayLauncher: "nemoclaw",
    });
    expect(profile).toMatchObject({
      driverName: "podman",
      launchPolicy: "host-only",
      capabilities: {
        containerizedGatewayCompat: false,
        legacyDockerGatewayCleanup: false,
        legacyDockerVolumeCleanup: false,
        localSupervisorBinary: false,
      },
    });
  });

  it("does not impose a managed host lifecycle on an OpenShell-owned MXC plan", () => {
    expect(
      resolveManagedGatewayDriverProfile({
        driverName: "mxc",
        gatewayLauncher: "openshell",
      }),
    ).toBeNull();
  });

  it("derives the host sandbox binary requirement from the active runtime profile", () => {
    expect(
      requiresHostSandboxBinaryForInstall(CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES.docker, {
        explicitSandboxBinary: false,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      requiresHostSandboxBinaryForInstall(CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES.podman, {
        explicitSandboxBinary: false,
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      requiresHostSandboxBinaryForInstall(CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES.podman, {
        explicitSandboxBinary: true,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      requiresHostSandboxBinaryForInstall(null, {
        explicitSandboxBinary: false,
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("accepts an independently registered NemoClaw-managed MXC profile", () => {
    expect(
      resolveManagedGatewayDriverProfile(
        { driverName: "mxc", gatewayLauncher: "nemoclaw" },
        {
          ...CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
          mxc: {
            allowWildcardBind: false,
            driverName: "mxc",
            displayName: "MXC",
            incompatibleRuntimeEnvironmentKeys: [],
            launchPolicy: "host-only",
            runtimeMarkerPolicy: "process-env",
            runtimeEnvironmentKeys: ["MXC_ENDPOINT"],
            sandboxReachability: "driver-native",
            capabilities: {
              containerizedGatewayCompat: false,
              legacyDockerGatewayCleanup: false,
              legacyDockerVolumeCleanup: false,
              localSupervisorBinary: false,
              packageManagedService: false,
            },
          },
        },
      ),
    ).toMatchObject({ driverName: "mxc" });
  });

  it("fails a NemoClaw-owned driver without a matching profile", () => {
    expect(() =>
      resolveManagedGatewayDriverProfile({
        driverName: "mxc",
        gatewayLauncher: "nemoclaw",
      }),
    ).toThrow("requires a registered NemoClaw managed-gateway profile");
  });

  it("resolves an independently injected runtime adapter by driver identity", () => {
    const profile = {
      allowWildcardBind: false,
      driverName: "mxc",
      displayName: "MXC",
      incompatibleRuntimeEnvironmentKeys: [],
      launchPolicy: "host-only",
      runtimeMarkerPolicy: "process-env",
      runtimeEnvironmentKeys: ["MXC_ENDPOINT"],
      sandboxReachability: "driver-native",
      capabilities: {
        containerizedGatewayCompat: false,
        legacyDockerGatewayCleanup: false,
        legacyDockerVolumeCleanup: false,
        localSupervisorBinary: false,
        packageManagedService: false,
      },
    } as const;
    const adapter = {
      driverName: "mxc",
      launchPolicy: "host-only",
      runtimeMarkerPolicy: "process-env",
      sandboxReachability: "driver-native",
      build: () => "mxc-runtime",
    } as const;
    expect(resolveManagedGatewayRuntimeAdapter(profile, { mxc: adapter })).toBe(adapter);
  });

  it("fails before launch when a managed profile has no matching runtime adapter", () => {
    expect(() =>
      resolveManagedGatewayRuntimeAdapter(CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES.podman, {
        docker: {
          driverName: "docker",
          launchPolicy: "docker-compat",
          runtimeMarkerPolicy: "docker-compat-v1",
          sandboxReachability: "docker-bridge",
        },
      }),
    ).toThrow("requires a matching runtime adapter");
  });

  it("rejects an adapter that would inherit another runtime's lifecycle", () => {
    expect(() =>
      resolveManagedGatewayRuntimeAdapter(CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES.podman, {
        podman: {
          driverName: "podman",
          launchPolicy: "docker-compat",
          runtimeMarkerPolicy: "docker-compat-v1",
          sandboxReachability: "docker-bridge",
        },
      }),
    ).toThrow("does not match its registered lifecycle profile");
  });
});
