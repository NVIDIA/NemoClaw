// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  captureHostCommand,
  collectDoctorHostRuntimeCheck,
  type DoctorHostRuntimeAdapterRegistry,
  resolveDoctorHostRuntimeAdapter,
} from "./doctor-host-command";

describe("captureHostCommand", () => {
  it("treats signal-terminated processes as failed", () => {
    const result = captureHostCommand(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);

    expect(result.status).not.toBe(0);
  });

  it("routes an injected MXC driver to only its registered doctor adapter", () => {
    const inspect = vi.fn(() => ({
      group: "Host" as const,
      label: "MXC runtime",
      status: "ok" as const,
      detail: "connected to the injected MXC control plane",
    }));
    const adapters: DoctorHostRuntimeAdapterRegistry = {
      mxc: {
        driverName: "mxc",
        inspect,
      },
    };

    expect(
      collectDoctorHostRuntimeCheck(
        {
          driverName: "mxc",
          managedGatewayStateDirectory: "/state/mxc",
        },
        adapters,
      ),
    ).toEqual({
      group: "Host",
      label: "MXC runtime",
      status: "ok",
      detail: "connected to the injected MXC control plane",
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      {
        driverName: "mxc",
        managedGatewayStateDirectory: "/state/mxc",
      },
      {
        captureHostCommand: expect.any(Function),
      },
    );
  });

  it("preserves the Docker adapter only for empty legacy driver metadata", () => {
    const inspect = vi.fn(() => ({
      group: "Host" as const,
      label: "legacy Docker",
      status: "ok" as const,
      detail: "legacy",
    }));
    const adapters: DoctorHostRuntimeAdapterRegistry = {
      docker: { driverName: "docker", inspect },
    };

    expect(
      collectDoctorHostRuntimeCheck(
        { driverName: null, managedGatewayStateDirectory: null },
        adapters,
      ),
    ).toMatchObject({ label: "legacy Docker" });
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      {
        driverName: "docker",
        managedGatewayStateDirectory: null,
      },
      {
        captureHostCommand: expect.any(Function),
      },
    );
  });

  it("requires Podman doctor checks to recover the exact managed runtime binding", () => {
    expect(
      collectDoctorHostRuntimeCheck({
        driverName: "podman",
        managedGatewayStateDirectory: null,
      }),
    ).toMatchObject({
      group: "Host",
      label: "Podman service",
      status: "fail",
      detail: expect.stringContaining(
        "Podman runtime socket recovery requires a managed gateway state directory",
      ),
    });
  });

  it("does not let an unknown future driver inherit Docker or Podman checks", () => {
    const dockerInspect = vi.fn();
    const podmanInspect = vi.fn();
    const adapters: DoctorHostRuntimeAdapterRegistry = {
      docker: {
        driverName: "docker",
        inspect: dockerInspect,
      },
      podman: {
        driverName: "podman",
        inspect: podmanInspect,
      },
    };

    expect(
      collectDoctorHostRuntimeCheck(
        {
          driverName: "mxc",
          managedGatewayStateDirectory: "/state/mxc",
        },
        adapters,
      ),
    ).toBeNull();
    expect(dockerInspect).not.toHaveBeenCalled();
    expect(podmanInspect).not.toHaveBeenCalled();
  });

  it("rejects a registry entry whose adapter claims another driver identity", () => {
    expect(() =>
      resolveDoctorHostRuntimeAdapter("mxc", {
        mxc: {
          driverName: "docker",
          inspect: () => ({
            group: "Host",
            label: "wrong",
            status: "ok",
            detail: "wrong",
          }),
        },
      }),
    ).toThrow("does not match its registered driver identity");
  });
});
