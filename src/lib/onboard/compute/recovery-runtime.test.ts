// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
import {
  type ManagedGatewayRecoveryAdapterRegistry,
  resolveManagedGatewayRecoveryRuntime,
} from "./recovery-runtime";

function binding(
  driverName = "podman",
  values: ManagedGatewayRuntimeBinding["values"] = {
    network_name: "openshell-custom",
    socket_path: "/run/user/1000/podman/custom.sock",
    supervisor_image: "ghcr.io/nvidia/openshell/supervisor@sha256:abc",
  },
): ManagedGatewayRuntimeBinding {
  return {
    version: 1,
    driverName,
    configSha256: "a".repeat(64),
    values,
  };
}

describe("managed gateway recovery runtime", () => {
  it("recovers the exact persisted Podman socket, network, and supervisor image", () => {
    expect(
      resolveManagedGatewayRecoveryRuntime(
        {
          driverName: "podman",
          environment: {},
          stateDir: "/state/podman",
        },
        undefined,
        () => binding(),
      ),
    ).toEqual({
      driverName: "podman",
      environment: {
        OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/custom.sock",
        OPENSHELL_PODMAN_NETWORK_NAME: "openshell-custom",
        OPENSHELL_SUPERVISOR_IMAGE: "ghcr.io/nvidia/openshell/supervisor@sha256:abc",
      },
    });
  });

  it("rejects ambient runtime identity that conflicts with the protected binding", () => {
    expect(() =>
      resolveManagedGatewayRecoveryRuntime(
        {
          driverName: "podman",
          environment: {
            OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/other.sock",
          },
          stateDir: "/state/podman",
        },
        undefined,
        () => binding(),
      ),
    ).toThrow("OPENSHELL_PODMAN_SOCKET does not match");
  });

  it("fails closed on a missing or wrong-driver runtime binding", () => {
    expect(() =>
      resolveManagedGatewayRecoveryRuntime(
        { driverName: "podman", stateDir: "/state/missing" },
        undefined,
        () => null,
      ),
    ).toThrow("Managed runtime binding is missing");
    expect(() =>
      resolveManagedGatewayRecoveryRuntime(
        { driverName: "podman", stateDir: "/state/docker" },
        undefined,
        () => binding("docker"),
      ),
    ).toThrow("does not match requested recovery driver");
  });

  it("accepts an independently registered future runtime adapter", () => {
    const adapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: "mxc",
        resolveEnvironment: () => ({ OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" }),
      },
    };
    expect(
      resolveManagedGatewayRecoveryRuntime(
        { driverName: "mxc", environment: {}, stateDir: "/state/mxc" },
        adapters,
        () => binding("mxc", {}),
      ),
    ).toEqual({
      driverName: "mxc",
      environment: { OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" },
    });
  });
});
