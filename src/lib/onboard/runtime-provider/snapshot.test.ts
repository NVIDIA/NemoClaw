// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry/types";
import type { OpenShellDockerSandboxRuntimeSnapshotQuery } from "../openshell-docker-sandbox-containers";
import type {
  RuntimeProviderManagedProfileRestoreAuthority,
  RuntimeProviderRuntimeReceipt,
  RuntimeProviderSnapshotPreflightReceipt,
} from "./contract";
import {
  createDockerRuntimeProviderSnapshotSurface,
  createRuntimeProviderSnapshotSurface,
  observeDockerRuntimeSnapshot,
  observeOpenShellRuntimeSnapshot,
  type RuntimeProviderSnapshotObservation,
} from "./snapshot";

const managedProfile = {
  agent: "openclaw",
  profileFingerprint: "f".repeat(64),
} as const satisfies RuntimeProviderManagedProfileRestoreAuthority;

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "mxc",
    gatewayName: "nemoclaw-18080",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    sandboxGpuEnabled: false,
    sandboxGpuMode: "0",
    sandboxGpuDevice: null,
    ...overrides,
  };
}

function observation(
  providerId = "mxc",
  overrides: Partial<RuntimeProviderSnapshotObservation> = {},
): RuntimeProviderSnapshotObservation {
  return {
    lifecycleState: "running",
    lifecycleGeneration: "generation-1",
    runtime: {
      schemaVersion: 1,
      providerId,
      runtime: { kind: "session", handle: "opaque-mxc-session" },
      acceleration: { kind: "none" },
    },
    ...overrides,
  };
}

function surfaceDriver(
  observe: () => RuntimeProviderSnapshotObservation,
  restoreManagedProfile = vi.fn(() => "provider-restore-proof"),
) {
  return { observe, restoreManagedProfile };
}

function snapshotSource(
  preflight: RuntimeProviderSnapshotPreflightReceipt,
  runtime: RuntimeProviderRuntimeReceipt,
) {
  return {
    schemaVersion: 1 as const,
    providerId: preflight.providerId,
    providerHandle: preflight.providerHandle,
    lifecycleState: preflight.lifecycleState,
    lifecycleGeneration: preflight.lifecycleGeneration,
    runtime,
  };
}

function requireSupportedSurface<T extends { readonly supported: boolean }>(
  surface: T,
): Extract<T, { readonly supported: true }> {
  expect(surface.supported).toBe(true);
  return surface as Extract<T, { readonly supported: true }>;
}

describe("runtime provider snapshot surface", () => {
  it("binds the full runtime and lifecycle generation into opaque backup authority", () => {
    const observe = vi.fn(() => observation());
    const surface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface("mxc", surfaceDriver(observe)),
    );

    const preflight = surface.preflight("backup", sandbox());
    const receipt = surface.capture(sandbox(), preflight);

    expect(preflight).toMatchObject({
      lifecycleGeneration: "generation-1",
      lifecycleState: "running",
    });
    expect(preflight.providerHandle).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.providerHandle).not.toContain("opaque-mxc-session");
    expect(receipt.runtime.handle).toBe("opaque-mxc-session");
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("invokes the owning provider restore facet and returns managed profile/runtime proof", () => {
    const restoreManagedProfile = vi.fn(() => "provider-restore-proof");
    const surface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => observation(), restoreManagedProfile),
      ),
    );
    const target = sandbox();
    const preflight = surface.preflight("restore", target);

    const receipt = surface.restore(
      target,
      preflight,
      snapshotSource(preflight, observation().runtime),
      managedProfile,
    );

    expect(restoreManagedProfile).toHaveBeenCalledWith(
      target,
      managedProfile,
      observation().runtime,
    );
    expect(receipt).toMatchObject({
      providerId: "mxc",
      sandboxName: "alpha",
      lifecycleGeneration: "generation-1",
      runtime: { providerId: "mxc", runtime: { handle: "opaque-mxc-session" } },
      managedProfile,
    });
    expect(receipt.providerHandle).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("restores after a runtime restart and binds proof to current runtime plus source provenance", () => {
    const target = sandbox();
    const current = observation("mxc", {
      lifecycleGeneration: "current-generation",
      runtime: {
        ...observation().runtime,
        runtime: { kind: "session", handle: "current-session" },
      },
    });
    const restoreFrom = (
      targetObservation: RuntimeProviderSnapshotObservation,
      sourceGeneration: string,
      sourceHandle: string,
    ) => {
      const sourceObservation = observation("mxc", {
        lifecycleGeneration: sourceGeneration,
        runtime: {
          ...observation().runtime,
          runtime: { kind: "session", handle: sourceHandle },
        },
      });
      const sourceSurface = requireSupportedSurface(
        createRuntimeProviderSnapshotSurface(
          "mxc",
          surfaceDriver(() => sourceObservation),
        ),
      );
      const sourcePreflight = sourceSurface.preflight("backup", target);
      const source = snapshotSource(
        sourcePreflight,
        sourceSurface.capture(target, sourcePreflight),
      );
      const targetSurface = requireSupportedSurface(
        createRuntimeProviderSnapshotSurface(
          "mxc",
          surfaceDriver(() => targetObservation),
        ),
      );
      const targetPreflight = targetSurface.preflight("restore", target);
      return targetSurface.restore(target, targetPreflight, source, managedProfile);
    };

    const first = restoreFrom(current, "source-generation-1", "source-session-1");
    const changedSource = restoreFrom(current, "source-generation-2", "source-session-2");
    const changedCurrent = restoreFrom(
      observation("mxc", {
        lifecycleGeneration: "next-current-generation",
        runtime: {
          ...observation().runtime,
          runtime: { kind: "session", handle: "next-current-session" },
        },
      }),
      "source-generation-1",
      "source-session-1",
    );

    expect(first).toMatchObject({
      lifecycleGeneration: "current-generation",
      runtime: { runtime: { handle: "current-session" } },
    });
    expect(changedSource.providerHandle).not.toBe(first.providerHandle);
    expect(changedCurrent.providerHandle).not.toBe(first.providerHandle);
  });

  it.each([
    {
      label: "before managed-profile proof",
      observations: [
        observation(),
        observation("mxc", {
          lifecycleGeneration: "changed-generation",
          runtime: {
            ...observation().runtime,
            runtime: { kind: "session", handle: "changed-session" },
          },
        }),
      ],
      expectedRestoreCalls: 0,
    },
    {
      label: "after managed-profile proof",
      observations: [
        observation(),
        observation(),
        observation("mxc", {
          lifecycleGeneration: "changed-generation",
          runtime: {
            ...observation().runtime,
            runtime: { kind: "session", handle: "changed-session" },
          },
        }),
      ],
      expectedRestoreCalls: 1,
    },
  ])("rejects current-runtime changes $label", ({ observations, expectedRestoreCalls }) => {
    const restoreManagedProfile = vi.fn(() => "provider-restore-proof");
    const observe = vi.fn<() => RuntimeProviderSnapshotObservation>();
    observations.forEach((value) => {
      observe.mockReturnValueOnce(value);
    });
    const surface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface("mxc", surfaceDriver(observe, restoreManagedProfile)),
    );
    const target = sandbox();
    const preflight = surface.preflight("restore", target);
    const source = snapshotSource(preflight, observation().runtime);

    expect(() => surface.restore(target, preflight, source, managedProfile)).toThrow(
      /runtime changed after snapshot preflight/u,
    );
    expect(restoreManagedProfile).toHaveBeenCalledTimes(expectedRestoreCalls);
  });

  it("fails before provider restore when the target cannot represent source acceleration", () => {
    const restoreManagedProfile = vi.fn(() => "provider-restore-proof");
    const targetSurface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => observation(), restoreManagedProfile),
      ),
    );
    const sourceObservation = observation("mxc", {
      runtime: {
        ...observation().runtime,
        acceleration: { kind: "gpu", vendor: "nvidia", devices: ["live-device-0"] },
      },
    });
    const sourceSurface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => sourceObservation),
      ),
    );
    const target = sandbox();
    const sourcePreflight = sourceSurface.preflight("backup", target);
    const source = snapshotSource(sourcePreflight, sourceSurface.capture(target, sourcePreflight));
    const preflight = targetSurface.preflight("restore", target);

    expect(() => targetSurface.restore(target, preflight, source, managedProfile)).toThrow(
      /cannot represent the snapshot acceleration state/u,
    );
    expect(restoreManagedProfile).not.toHaveBeenCalled();
  });

  it("fails before provider restore when the target cannot represent source lifecycle", () => {
    const restoreManagedProfile = vi.fn(() => "provider-restore-proof");
    const targetSurface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => observation(), restoreManagedProfile),
      ),
    );
    const stopped = observation("mxc", { lifecycleState: "stopped" });
    const sourceSurface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => stopped),
      ),
    );
    const target = sandbox();
    const sourcePreflight = sourceSurface.preflight("backup", target);
    const source = snapshotSource(sourcePreflight, sourceSurface.capture(target, sourcePreflight));
    const targetPreflight = targetSurface.preflight("restore", target);

    expect(() => targetSurface.restore(target, targetPreflight, source, managedProfile)).toThrow(
      /cannot represent the snapshot lifecycle state/u,
    );
    expect(restoreManagedProfile).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "runtime identity/lifecycle",
      changed: observation("mxc", {
        lifecycleState: "paused",
        runtime: {
          ...observation().runtime,
          runtime: { kind: "session", handle: "replacement-session" },
        },
      }),
    },
    {
      label: "acceleration",
      changed: observation("mxc", {
        runtime: {
          ...observation().runtime,
          acceleration: {
            kind: "gpu",
            vendor: "nvidia",
            devices: ["nvidia.com/gpu=0"],
          },
        },
      }),
    },
    {
      label: "lifecycle generation",
      changed: observation("mxc", { lifecycleGeneration: "generation-2" }),
    },
  ])("rejects a $label race after preflight", ({ changed }) => {
    const observe = vi
      .fn<() => RuntimeProviderSnapshotObservation>()
      .mockReturnValueOnce(observation())
      .mockReturnValueOnce(changed);
    const surface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface("mxc", surfaceDriver(observe)),
    );
    const target = sandbox();
    const preflight = surface.preflight("backup", target);

    expect(() => surface.capture(target, preflight)).toThrow(/runtime changed after/u);
  });

  it("rejects a preflight receipt from another operation or sandbox", () => {
    const surface = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => observation()),
      ),
    );
    const target = sandbox();
    const restorePreflight = surface.preflight("restore", target);
    const otherTarget = sandbox({ name: "other" });

    expect(() => surface.capture(target, restorePreflight)).toThrow(
      /stale snapshot preflight authority/u,
    );
    expect(() =>
      surface.restore(
        otherTarget,
        restorePreflight,
        snapshotSource(restorePreflight, observation().runtime),
        managedProfile,
      ),
    ).toThrow(/stale snapshot preflight authority/u);
  });

  it("rejects invalid runtime receipts, restore authority, and provider proof", () => {
    const invalidRuntime = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(() => observation("other-provider")),
      ),
    );
    expect(() => invalidRuntime.preflight("backup", sandbox())).toThrow(/invalid runtime receipt/u);

    const invalidProof = requireSupportedSurface(
      createRuntimeProviderSnapshotSurface(
        "mxc",
        surfaceDriver(
          () => observation(),
          vi.fn(() => "proof\ninjection"),
        ),
      ),
    );
    const preflight = invalidProof.preflight("restore", sandbox());
    const source = snapshotSource(preflight, observation().runtime);
    expect(() => invalidProof.restore(sandbox(), preflight, source, managedProfile)).toThrow(
      /invalid managed profile restore proof/u,
    );

    expect(() =>
      invalidProof.restore(
        sandbox(),
        preflight,
        {
          ...source,
          runtime: {
            ...source.runtime,
            acceleration: { kind: "gpu", vendor: "nvidia", devices: ["tampered-device"] },
          },
        },
        managedProfile,
      ),
    ).toThrow(/does not match its provider handle/u);
  });
});

describe("OpenShell snapshot observation", () => {
  const liveAcceleration = {
    kind: "gpu",
    vendor: "nvidia",
    devices: ["provider-live-device-0"],
  } as const satisfies RuntimeProviderRuntimeReceipt["acceleration"];

  it("requires exact live identity, lifecycle generation, and provider acceleration", () => {
    const capture = vi.fn(() => ({
      status: 0,
      output: "Name: alpha\nId: openshell-alpha-id\nState: Ready\nGeneration: live-generation-7\n",
      stdout: "",
      stderr: "",
    }));
    const observeAcceleration = vi.fn(() => liveAcceleration);

    expect(
      observeOpenShellRuntimeSnapshot(
        sandbox({
          // Contradictory durable fields must not influence the live receipt.
          sandboxGpuEnabled: false,
          sandboxGpuMode: "0",
          sandboxGpuDevice: null,
        }),
        "mxc",
        { capture: capture as never, observeAcceleration },
      ),
    ).toEqual({
      lifecycleState: "running",
      lifecycleGeneration: "live-generation-7",
      runtime: {
        schemaVersion: 1,
        providerId: "mxc",
        runtime: { kind: "openshell-sandbox", handle: "openshell-alpha-id" },
        acceleration: liveAcceleration,
      },
    });
    expect(observeAcceleration).toHaveBeenCalledWith(
      expect.objectContaining({ name: "alpha" }),
      "openshell-alpha-id",
    );
  });

  it("rejects durable identity and acceleration fallbacks", () => {
    const result = {
      status: 0,
      output: "alpha Ready\nGeneration: live-generation-7\n",
      stdout: "",
      stderr: "",
    };
    expect(() =>
      observeOpenShellRuntimeSnapshot(
        sandbox({
          lifecycleLiveIdentityFingerprint: "a".repeat(64),
          sandboxGpuEnabled: true,
          sandboxGpuMode: "1",
          sandboxGpuDevice: "all",
        }),
        "mxc",
        {
          capture: (() => result) as never,
          observeAcceleration: () => ({ kind: "none" }),
        },
      ),
    ).toThrow(/exact live runtime identity/u);

    expect(() =>
      observeOpenShellRuntimeSnapshot(sandbox(), "mxc", {
        capture: (() => ({
          ...result,
          output: "Id: sandbox-id\nState: Ready\nGeneration: live-generation-7\n",
        })) as never,
      }),
    ).toThrow(/did not supply live acceleration evidence/u);
  });

  it.each([
    ["Paused", "paused"],
    ["Stopped", "stopped"],
    ["Exited", "stopped"],
    ["Created", "stopped"],
  ] as const)("normalizes the OpenShell %s lifecycle as %s", (state, expected) => {
    expect(
      observeOpenShellRuntimeSnapshot(sandbox(), "mxc", {
        capture: (() => ({
          status: 0,
          output: `Id: sandbox-id\nState: ${state}\nGeneration: generation-1\n`,
          stdout: "",
          stderr: "",
        })) as never,
        observeAcceleration: () => ({ kind: "none" }),
      }).lifecycleState,
    ).toBe(expected);
  });

  it.each([
    { status: 1, output: "not found", stdout: "", stderr: "" },
    {
      status: 0,
      signal: "SIGTERM",
      output: "Id: sandbox-id\nState: Ready\nGeneration: generation-1\n",
      stdout: "",
      stderr: "",
    },
  ])(
    "rejects mismatched provider, failed inspection, or missing generation [case %#]",
    (result) => {
      const capture = vi.fn();
      expect(() =>
        observeOpenShellRuntimeSnapshot(sandbox({ openshellDriver: "docker" }), "mxc", {
          capture: capture as never,
        }),
      ).toThrow(/belongs to another runtime provider/u);
      expect(capture).not.toHaveBeenCalled();

      expect(() =>
        observeOpenShellRuntimeSnapshot(sandbox(), "mxc", {
          capture: (() => result) as never,
          observeAcceleration: () => ({ kind: "none" }),
        }),
      ).toThrow(/runtime identity could not be inspected/u);

      expect(() =>
        observeOpenShellRuntimeSnapshot(sandbox(), "mxc", {
          capture: (() => ({
            status: 0,
            output: "Id: sandbox-id\nState: Ready\n",
            stdout: "",
            stderr: "",
          })) as never,
          observeAcceleration: () => ({ kind: "none" }),
        }),
      ).toThrow(/lifecycle generation cannot be represented/u);
    },
  );
});

function dockerSnapshot(
  overrides: Partial<Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>> = {},
): Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }> {
  return {
    ok: true,
    imageId: `sha256:${"b".repeat(64)}`,
    bookkeepingImageRef: "managed@example",
    stateError: "",
    deviceRequests: null,
    devices: null,
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent",
    containerId: "c".repeat(64),
    ...overrides,
  };
}

function dockerLifecycleCapture(
  containerId = "c".repeat(64),
  overrides: { status?: string; paused?: boolean; restartCount?: number } = {},
) {
  return vi.fn((_command: string, _args: string[], _timeout?: number) => ({
    status: 0,
    stdout: JSON.stringify([
      containerId,
      overrides.status ?? "running",
      overrides.paused ?? false,
      "2026-07-30T12:00:00Z",
      "0001-01-01T00:00:00Z",
      overrides.restartCount ?? 0,
    ]),
    stderr: "",
  }));
}

function dockerRestoreCapture(
  restoreResult: {
    status: number;
    stdout: string;
    stderr: string;
    error?: Error;
  } = {
    status: 0,
    stdout: "[managed-startup] verified profile completion\n",
    stderr: "",
  },
) {
  const lifecycleCapture = dockerLifecycleCapture();
  return vi.fn((command: string, args: string[], timeout?: number) =>
    args[0] === "exec" ? restoreResult : lifecycleCapture(command, args, timeout),
  );
}

describe("Docker provider snapshot evidence", () => {
  it("normalizes Docker's explicit paused status", () => {
    const observed = observeDockerRuntimeSnapshot(
      sandbox({ openshellDriver: "docker" }),
      "docker",
      {
        captureHostCommand: dockerLifecycleCapture(undefined, { status: "paused", paused: true }),
        queryRuntimeSnapshot: () => dockerSnapshot(),
      },
    );

    expect(observed.lifecycleState).toBe("paused");
  });

  it("captures exact live container, lifecycle, and device selectors", () => {
    const queryRuntimeSnapshot = vi.fn(() =>
      dockerSnapshot({
        deviceRequests: [
          {
            Driver: "nvidia",
            Count: 0,
            DeviceIDs: ["GPU-live-0"],
            Capabilities: [["gpu"]],
            Options: null,
          },
        ],
        nativeGpuAttachmentState: "present",
        runtime: "nvidia",
        nvidiaVisibleDevices: "GPU-live-0",
      }),
    );
    const observed = observeDockerRuntimeSnapshot(
      sandbox({
        openshellDriver: "docker",
        sandboxGpuEnabled: false,
        sandboxGpuMode: "0",
        sandboxGpuDevice: null,
      }),
      "docker",
      { captureHostCommand: dockerLifecycleCapture(), queryRuntimeSnapshot },
    );

    expect(observed).toMatchObject({
      lifecycleState: "running",
      lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/u),
      runtime: {
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "c".repeat(64) },
        acceleration: {
          kind: "gpu",
          vendor: "nvidia",
          devices: ["docker-device-id:GPU-live-0", "docker-nvidia-visible-device:GPU-live-0"],
        },
      },
    });
  });

  it.each(
    Array.from(
      [
        dockerSnapshot({
          deviceRequests: null,
          nativeGpuAttachmentState: "present",
          runtime: "nvidia",
          nvidiaVisibleDevices: null,
        }),
        dockerSnapshot({
          deviceRequests: [
            {
              Driver: "nvidia",
              Count: 1,
              DeviceIDs: null,
              Capabilities: [["gpu"]],
              Options: null,
            },
          ],
          nativeGpuAttachmentState: "present",
          runtime: "nvidia",
        }),
        dockerSnapshot({ nativeGpuAttachmentState: "unknown", runtime: "custom-runtime" }),
      ],
      (value) => [value],
    ),
  )(
    "accepts Docker's explicit count=-1 selector but rejects inferred or ambiguous GPU state [case %#]",
    (snapshot) => {
      const allDevices = observeDockerRuntimeSnapshot(
        sandbox({ openshellDriver: "docker" }),
        "docker",
        {
          captureHostCommand: dockerLifecycleCapture(),
          queryRuntimeSnapshot: () =>
            dockerSnapshot({
              deviceRequests: [
                {
                  Driver: "nvidia",
                  Count: -1,
                  DeviceIDs: null,
                  Capabilities: [["gpu"]],
                  Options: null,
                },
              ],
              nativeGpuAttachmentState: "present",
              runtime: "nvidia",
              nvidiaVisibleDevices: "all",
            }),
        },
      );
      expect(allDevices.runtime.acceleration).toMatchObject({
        devices: ["docker-device-request:nvidia:count=-1", "docker-nvidia-visible-devices:all"],
      });

      expect(() =>
        observeDockerRuntimeSnapshot(sandbox({ openshellDriver: "docker" }), "docker", {
          captureHostCommand: dockerLifecycleCapture(),
          queryRuntimeSnapshot: () => snapshot,
        }),
      ).toThrow(/acceleration|exact live device selectors/u);
    },
  );

  it("captures the NVIDIA Container Runtime selector used by Jetson", () => {
    const observed = observeDockerRuntimeSnapshot(
      sandbox({ openshellDriver: "docker" }),
      "docker",
      {
        captureHostCommand: dockerLifecycleCapture(),
        queryRuntimeSnapshot: () =>
          dockerSnapshot({
            deviceRequests: null,
            devices: null,
            nativeGpuAttachmentState: "present",
            runtime: "nvidia",
            nvidiaVisibleDevices: "0,GPU-live-1",
          }),
      },
    );

    expect(observed.runtime.acceleration).toEqual({
      kind: "gpu",
      vendor: "nvidia",
      devices: ["docker-nvidia-visible-device:0", "docker-nvidia-visible-device:GPU-live-1"],
    });
  });

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "runs the exact-container %s profile verifier and fails closed on refusal",
    (agent) => {
      const authority = {
        agent,
        profileFingerprint: managedProfile.profileFingerprint,
      };
      const captureHostCommand = dockerRestoreCapture({
        status: 0,
        stdout: `[managed-startup] verified ${agent} profile completion\n`,
        stderr: "",
      });
      const queryRuntimeSnapshot = vi.fn(() => dockerSnapshot());
      const dependencies = {
        captureHostCommand,
        queryRuntimeSnapshot,
      };
      const surface = requireSupportedSurface(
        createDockerRuntimeProviderSnapshotSurface("docker", dependencies),
      );
      const target = sandbox({ agent, openshellDriver: "docker" });
      const preflight = surface.preflight("restore", target);
      const source = snapshotSource(preflight, {
        schemaVersion: 1,
        providerId: "docker",
        runtime: { kind: "docker-container", handle: "c".repeat(64) },
        acceleration: { kind: "none" },
      });
      const receipt = surface.restore(target, preflight, source, authority);
      expect(receipt.managedProfile).toEqual(authority);
      expect(queryRuntimeSnapshot).toHaveBeenCalledTimes(3);
      expect(captureHostCommand).toHaveBeenCalledWith(
        "docker",
        [
          "exec",
          "--user",
          "root",
          "c".repeat(64),
          "/usr/bin/env",
          "-i",
          "HOME=/root",
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "/usr/local/bin/node",
          "/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs",
          "--verify-completion",
          "--agent",
          agent,
          "--profile-fingerprint",
          authority.profileFingerprint,
        ],
        15_000,
      );

      const denied = requireSupportedSurface(
        createDockerRuntimeProviderSnapshotSurface("docker", {
          ...dependencies,
          captureHostCommand: dockerRestoreCapture({
            status: 1,
            stdout: "",
            stderr: "profile mismatch",
          }),
        }),
      );
      const deniedPreflight = denied.preflight("restore", target);
      const deniedSource = snapshotSource(deniedPreflight, source.runtime);
      expect(() => denied.restore(target, deniedPreflight, deniedSource, authority)).toThrow(
        /managed profile restoration could not be proven \(status=1; output=profile mismatch\)/u,
      );
    },
  );

  it("sanitizes verifier failure diagnostics", () => {
    const denied = requireSupportedSurface(
      createDockerRuntimeProviderSnapshotSurface("docker", {
        captureHostCommand: dockerRestoreCapture({
          status: 1,
          stdout: "",
          stderr: "\u001b]0;unsafe\u0007profile \u001b[31mmismatch\u001b[0m\u0000",
          error: new Error("\u009b31mspawn\u009b0m\u0001 failed"),
        }),
        queryRuntimeSnapshot: () => dockerSnapshot(),
      }),
    );
    const target = sandbox({ openshellDriver: "docker" });
    const preflight = denied.preflight("restore", target);
    const source = snapshotSource(preflight, {
      schemaVersion: 1,
      providerId: "docker",
      runtime: { kind: "docker-container", handle: "c".repeat(64) },
      acceleration: { kind: "none" },
    });

    expect(() => denied.restore(target, preflight, source, managedProfile)).toThrow(
      /status=1; error=spawn failed; output=profile mismatch\)/u,
    );
  });
});
