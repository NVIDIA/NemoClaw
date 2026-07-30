// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { DCODE_MANAGED_RUNTIME_ULIMITS } from "../../../onboard/compute/managed-startup-runtime-requirements";
import { createPodmanOpenShellWatcherController } from "../../../onboard/compute/podman/sandbox-recreate";
import type { SandboxCreateRuntimePatchRequest } from "../../../onboard/sandbox-create-runtime/registry";
import type { SandboxCreateRuntimePatch } from "../../../onboard/sandbox-create-runtime/types";
import type { SandboxEntry } from "../../../state/registry";
import {
  createManagedSnapshotRuntimePatch,
  runAuthorizedManagedSnapshotDestinationDelete,
} from "./runtime-patch";

function patch(): SandboxCreateRuntimePatch {
  return {
    maybeApplyDuringCreate: vi.fn(),
    createFailureMessage: vi.fn(() => null),
    exitOnPatchError: vi.fn(),
    rollbackManagedStartupAfterCreateFailure: vi.fn(),
    ensureApplied: vi.fn(),
    revalidateBeforeMutation: vi.fn(),
    waitForSupervisorReconnectIfNeeded: vi.fn(),
    commitAfterReady: vi.fn(),
  };
}

function lifecycle() {
  return {
    deps: {
      runCaptureOpenshell: vi.fn(() => ""),
      runOpenshell: vi.fn(() => ({ status: 0 })),
      sleep: vi.fn(),
    },
    openshellSandboxCommand: ["nemoclaw-start"],
    sandboxName: "beta",
    timeoutSecs: 30,
  };
}

function sourceEntry(openshellDriver?: string | null, agent?: string): SandboxEntry {
  return {
    name: "alpha",
    ...(openshellDriver !== undefined ? { openshellDriver } : {}),
    ...(agent ? { agent } : {}),
  };
}

describe("managed snapshot runtime patch selection", () => {
  it("revalidates after preparation and prevents forced destination deletion on drift", () => {
    const selected = patch();
    const deleteDestination = vi.fn();
    vi.mocked(selected.revalidateBeforeMutation).mockImplementation(() => {
      throw new Error("Podman socket authority changed before destination delete");
    });

    expect(() =>
      runAuthorizedManagedSnapshotDestinationDelete(selected, deleteDestination),
    ).toThrow("socket authority changed");
    expect(selected.revalidateBeforeMutation).toHaveBeenCalledOnce();
    expect(deleteDestination).not.toHaveBeenCalled();
  });

  it.each([
    ["an unrecorded legacy source", undefined],
    ["an explicit Docker source", "docker"],
    ["a legacy VM source", "vm"],
  ])("preserves the Docker patch path for %s", (_label, openshellDriver) => {
    const selected = patch();
    const createRuntimePatch = vi.fn(() => selected);
    const runtimeLifecycle = lifecycle();

    expect(
      createManagedSnapshotRuntimePatch(
        {
          destinationSandboxName: "beta",
          lifecycle: runtimeLifecycle,
          sourceEntry: sourceEntry(openshellDriver),
        },
        { createRuntimePatch },
      ),
    ).toBe(selected);
    expect(createRuntimePatch).toHaveBeenCalledWith({
      driverName: "docker",
      lifecycle: {
        ...runtimeLifecycle,
        persistStartupCommand: false,
        requiredUlimits: null,
        sandboxGpuEnabled: false,
      },
      runtimeAuthority: undefined,
    });
  });

  it("injects exact Podman runtime authority into the shared patch factory", () => {
    const selected = patch();
    const createRuntimePatch = vi.fn(() => selected);
    const watcherController = createPodmanOpenShellWatcherController({
      assertStopped: vi.fn(),
      resumeAndProve: vi.fn(),
      stopAndProve: vi.fn(() => ({ owner: "gateway" })),
    });
    const runtimeAuthority = {
      socketPath: "/run/user/1000/podman/podman.sock",
      watcherController,
    };
    const resolveRuntimeAuthority = vi.fn(() => runtimeAuthority);
    const source = sourceEntry("podman");
    const runtimeLifecycle = lifecycle();

    expect(
      createManagedSnapshotRuntimePatch(
        {
          destinationSandboxName: "beta",
          lifecycle: runtimeLifecycle,
          sourceEntry: source,
        },
        { createRuntimePatch, resolveRuntimeAuthority },
      ),
    ).toBe(selected);
    expect(resolveRuntimeAuthority).toHaveBeenCalledWith("podman", {
      destinationSandboxName: "beta",
      sourceEntry: source,
    });
    expect(createRuntimePatch).toHaveBeenCalledWith({
      driverName: "podman",
      lifecycle: {
        ...runtimeLifecycle,
        persistStartupCommand: false,
        requiredUlimits: null,
        sandboxGpuEnabled: false,
      },
      runtimeAuthority,
    });
  });

  it("carries DCode's exact persistence and ulimits into a Podman snapshot clone", () => {
    const selected = patch();
    const createRuntimePatch = vi.fn(() => selected);
    const runtimeAuthority = {
      socketPath: "/run/user/1000/podman/podman.sock",
      watcherController: createPodmanOpenShellWatcherController({
        assertStopped: vi.fn(),
        resumeAndProve: vi.fn(),
        stopAndProve: vi.fn(() => ({ owner: "gateway" })),
      }),
    };
    const runtimeLifecycle = lifecycle();

    expect(
      createManagedSnapshotRuntimePatch(
        {
          destinationSandboxName: "beta",
          lifecycle: runtimeLifecycle,
          sourceEntry: sourceEntry("podman", "langchain-deepagents-code"),
        },
        {
          createRuntimePatch,
          resolveRuntimeAuthority: () => runtimeAuthority,
        },
      ),
    ).toBe(selected);
    expect(createRuntimePatch).toHaveBeenCalledWith({
      driverName: "podman",
      lifecycle: {
        ...runtimeLifecycle,
        persistStartupCommand: true,
        requiredUlimits: DCODE_MANAGED_RUNTIME_ULIMITS,
        sandboxGpuEnabled: false,
      },
      runtimeAuthority,
    });
  });

  it("fails closed before factory dispatch without Podman lifecycle authority", () => {
    expect(() =>
      createManagedSnapshotRuntimePatch({
        destinationSandboxName: "beta",
        lifecycle: lifecycle(),
        sourceEntry: sourceEntry("podman"),
      }),
    ).toThrow("requires its qualified socket and watcher controller");
  });

  it("rejects a managed Kubernetes snapshot clone before destination mutation", () => {
    expect(() =>
      createManagedSnapshotRuntimePatch({
        destinationSandboxName: "beta",
        lifecycle: {
          ...lifecycle(),
          managedStartupRootApplyRequest: { agent: "openclaw" } as never,
        },
        sourceEntry: sourceEntry("kubernetes", "openclaw"),
      }),
    ).toThrow("has no managed-startup runtime adapter");
  });

  it("delegates future runtime authority and patch adapters without coordinator changes", () => {
    const selected = patch();
    const createRuntimePatch = vi.fn((_request: SandboxCreateRuntimePatchRequest) => selected);
    const runtimeAuthority = { endpoint: "unix:///run/mxc.sock" };
    const resolveRuntimeAuthority = vi.fn(() => runtimeAuthority);
    const runtimeRequirements = {
      persistStartupCommand: true,
      requiredUlimits: [{ name: "nofile", soft: 8192, hard: 8192 }],
    } as const;
    const resolveRuntimeRequirements = vi.fn(() => runtimeRequirements);
    const source = sourceEntry("mxc", "hermes");
    const runtimeLifecycle = lifecycle();

    expect(
      createManagedSnapshotRuntimePatch(
        {
          destinationSandboxName: "beta",
          lifecycle: runtimeLifecycle,
          sourceEntry: source,
        },
        { createRuntimePatch, resolveRuntimeAuthority, resolveRuntimeRequirements },
      ),
    ).toBe(selected);
    expect(resolveRuntimeAuthority).toHaveBeenCalledWith("mxc", {
      destinationSandboxName: "beta",
      sourceEntry: source,
    });
    expect(resolveRuntimeRequirements).toHaveBeenCalledWith(
      "mxc",
      {
        destinationSandboxName: "beta",
        sourceEntry: source,
      },
      { managedGatewayOwned: true },
    );
    const [request] = createRuntimePatch.mock.calls[0] ?? [];
    expect(request).toEqual({
      driverName: "mxc",
      lifecycle: {
        ...runtimeLifecycle,
        ...runtimeRequirements,
        sandboxGpuEnabled: false,
      },
      runtimeAuthority,
    });
    expect(request).not.toHaveProperty("docker");
  });
});
