// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { CURRENT_OPEN_SHELL_COMPUTE_PLANS } from "../compute/plan";
import { createPodmanOpenShellWatcherController } from "../compute/podman/sandbox-recreate";
import {
  CURRENT_SANDBOX_CREATE_RUNTIME_PATCH_ADAPTERS,
  createSandboxCreateRuntimePatch,
  type SandboxCreateRuntimePatchAdapterRegistry,
  type SandboxCreateRuntimePatchRequest,
} from "./registry";
import type { SandboxCreateRuntimePatch } from "./types";

function patch(): SandboxCreateRuntimePatch {
  return {
    commitAfterReady: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    ensureApplied: vi.fn(),
    exitOnPatchError: vi.fn(),
    maybeApplyDuringCreate: vi.fn(),
    revalidateBeforeMutation: vi.fn(),
    rollbackManagedStartupAfterCreateFailure: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
  };
}

function request(driverName = "mxc"): SandboxCreateRuntimePatchRequest {
  return {
    driverName,
    lifecycle: {
      deps: {
        runCaptureOpenshell: vi.fn(() => ""),
        runOpenshell: vi.fn(() => ({ status: 0 })),
        sleep: vi.fn(),
      },
      openshellSandboxCommand: ["nemoclaw-start"],
      persistStartupCommand: false,
      requiredUlimits: null,
      sandboxGpuEnabled: false,
      sandboxName: "alpha",
      timeoutSecs: 60,
    },
  };
}

describe("sandbox-create runtime patch registry", () => {
  it("requires exact-socket CDI qualification for a Podman GPU request", () => {
    const base = request("podman");
    const input = {
      ...base,
      lifecycle: {
        ...base.lifecycle,
        sandboxGpuEnabled: true,
        sandboxGpuDevice: "0",
      },
    };
    const runtimeAuthority = {
      cdiDevices: ["nvidia.com/gpu=0"],
      socketAuthority: {
        directoryChain: [],
        device: "8",
        inode: "9",
        ownerUid: "1000",
        socketPath: "/run/user/1000/podman/podman.sock",
      },
      socketPath: "/run/user/1000/podman/podman.sock",
      watcherController: createPodmanOpenShellWatcherController({
        assertStopped() {},
        resumeAndProve() {},
        stopAndProve: () => true,
      }),
    };

    expect(() =>
      createSandboxCreateRuntimePatch({ ...input, runtimeAuthority }),
    ).not.toThrow();
    expect(() =>
      createSandboxCreateRuntimePatch({
        ...input,
        runtimeAuthority: { ...runtimeAuthority, cdiDevices: ["nvidia.com/gpu=all"] },
      }),
    ).toThrow("does not advertise");
  });

  it("covers every current compute driver and preserves Kubernetes direct creation", () => {
    expect(Object.keys(CURRENT_SANDBOX_CREATE_RUNTIME_PATCH_ADAPTERS).sort()).toEqual(
      Object.values(CURRENT_OPEN_SHELL_COMPUTE_PLANS)
        .map(({ driverName }) => driverName)
        .sort(),
    );
    const direct = createSandboxCreateRuntimePatch(request("kubernetes"));

    direct.maybeApplyDuringCreate();
    direct.ensureApplied();
    direct.waitForSupervisorReconnectIfNeeded();
    direct.commitAfterReady();

    expect(direct.createFailureMessage()).toBeNull();
  });

  it("routes a future MXC adapter without changing create orchestration", () => {
    const expected = patch();
    const create = vi.fn(() => expected);
    const adapters: SandboxCreateRuntimePatchAdapterRegistry = {
      mxc: { create, driverName: "mxc" },
    };
    const input = request();

    expect(createSandboxCreateRuntimePatch(input, adapters)).toBe(expected);
    expect(create).toHaveBeenCalledWith(input);
    expect(input).not.toHaveProperty("docker");
  });

  it("rejects managed startup on Kubernetes until a runtime adapter owns it", () => {
    const base = request("kubernetes");
    const input = {
      ...base,
      lifecycle: {
        ...base.lifecycle,
        managedStartupRootApplyRequest: { agent: "openclaw" } as never,
      },
    };
    expect(() => createSandboxCreateRuntimePatch(input)).toThrow(
      "has no managed-startup runtime adapter",
    );
  });

  it("fails closed for an unregistered compute driver", () => {
    expect(() => createSandboxCreateRuntimePatch(request("mxc"), {})).toThrow(
      "has no sandbox-create runtime patch adapter",
    );
  });

  it("rejects a registry key whose adapter claims another driver", () => {
    const adapters: SandboxCreateRuntimePatchAdapterRegistry = {
      mxc: { create: vi.fn(() => patch()), driverName: "other" },
    };
    expect(() => createSandboxCreateRuntimePatch(request("mxc"), adapters)).toThrow(
      "has no sandbox-create runtime patch adapter",
    );
  });
});
