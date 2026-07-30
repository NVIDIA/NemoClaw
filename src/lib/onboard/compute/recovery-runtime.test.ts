// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ManagedGatewayRuntimeBinding } from "../docker-driver-gateway-config";
import {
  type ManagedGatewayRecoveryAdapterRegistry,
  qualifyManagedGatewayRecoveryRuntime,
  resolveManagedGatewayRecoveryRuntime,
  supportsManagedGatewayRecoveryRuntime,
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
    const qualifyEnvironment = vi.fn(() => ({ endpoint: "qualified" }));
    const adapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: "mxc",
        qualifyEnvironment,
        resolveEnvironment: () => ({ OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" }),
      },
    };
    const runtime = resolveManagedGatewayRecoveryRuntime(
      { driverName: "mxc", environment: {}, stateDir: "/state/mxc" },
      adapters,
      () => binding("mxc", {}),
    );
    expect(runtime).toEqual({
      driverName: "mxc",
      environment: { OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" },
    });
    expect(supportsManagedGatewayRecoveryRuntime("mxc", adapters)).toBe(true);
    expect(qualifyManagedGatewayRecoveryRuntime(runtime, adapters)).toEqual({
      endpoint: "qualified",
    });
    expect(qualifyEnvironment).toHaveBeenCalledExactlyOnceWith(runtime.environment);
  });

  it("rejects a recovery registry entry whose identity does not match its key", () => {
    const adapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: "podman",
        qualifyEnvironment: () => null,
        resolveEnvironment: () => ({}),
      },
    };

    expect(() => supportsManagedGatewayRecoveryRuntime("mxc", adapters)).toThrow(
      "mismatched identity",
    );
  });

  it("fails closed when an injected runtime cannot qualify its recovered environment", () => {
    const qualificationFailure = new Error("MXC endpoint is not reachable");
    const qualifyEnvironment = vi.fn(() => {
      throw qualificationFailure;
    });
    const adapters: ManagedGatewayRecoveryAdapterRegistry = {
      mxc: {
        driverName: "mxc",
        qualifyEnvironment,
        resolveEnvironment: () => ({ OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" }),
      },
    };
    const runtime = resolveManagedGatewayRecoveryRuntime(
      { driverName: "mxc", environment: {}, stateDir: "/state/mxc" },
      adapters,
      () => binding("mxc", {}),
    );

    expect(() => qualifyManagedGatewayRecoveryRuntime(runtime, adapters)).toThrow(
      qualificationFailure,
    );
    expect(qualifyEnvironment).toHaveBeenCalledExactlyOnceWith(runtime.environment);
  });

  it("rejects a malformed runtime adapter without an environment qualifier", () => {
    const adapters = {
      mxc: {
        driverName: "mxc",
        resolveEnvironment: () => ({ OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" }),
      },
    } as unknown as ManagedGatewayRecoveryAdapterRegistry;
    const runtime = {
      driverName: "mxc",
      environment: { OPENSHELL_MXC_ENDPOINT: "unix:///run/mxc.sock" },
    };

    expect(() => supportsManagedGatewayRecoveryRuntime("mxc", adapters)).toThrow(
      "does not implement environment qualification",
    );
    expect(() => qualifyManagedGatewayRecoveryRuntime(runtime, adapters)).toThrow(
      "does not implement environment qualification",
    );
  });
});
