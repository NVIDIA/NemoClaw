// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RuntimeProviderCommandCapture, RuntimeProviderQuarantineInput } from "./contract";
import { createDockerRuntimeProviderQuarantineSurface } from "./quarantine";

const CONTAINER_ID = "a".repeat(64);
const REPLACEMENT_ID = "b".repeat(64);
const LIVE_IDENTITY = "c".repeat(64);

function input(): RuntimeProviderQuarantineInput {
  return {
    environment: {},
    log: vi.fn(),
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "registry-generation-1",
    liveIdentityFingerprint: LIVE_IDENTITY,
    sandbox: {
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "registry-generation-1",
      lifecycleLiveIdentityFingerprint: LIVE_IDENTITY,
    },
  };
}

function runtimeSnapshot(containerId = CONTAINER_ID) {
  return {
    ok: true as const,
    imageId: `sha256:${"d".repeat(64)}`,
    bookkeepingImageRef: "nemoclaw:test",
    stateError: "",
    deviceRequests: null,
    devices: null,
    runtime: "runc",
    nvidiaVisibleDevices: null,
    nativeGpuAttachmentState: "absent" as const,
    containerId,
  };
}

function lifecycleCapture(
  state: "running" | "stopped",
  containerId = CONTAINER_ID,
): RuntimeProviderCommandCapture {
  return {
    status: 0,
    stdout: JSON.stringify([
      containerId,
      state === "running" ? "running" : "exited",
      false,
      "2026-08-25T04:00:00.000000000Z",
      state === "running" ? "0001-01-01T00:00:00Z" : "2026-08-25T04:01:00.000000000Z",
      0,
    ]),
    stderr: "",
  };
}

function supportedSurface(
  overrides: {
    queryRuntimeSnapshot?: () => ReturnType<typeof runtimeSnapshot> | { ok: false; error: string };
    captureHostCommand?: () => RuntimeProviderCommandCapture;
    stopContainer?: () => { status?: number | null };
    observeSandbox?: () => {
      state: "ready" | "not_ready" | "missing";
      liveIdentityFingerprint: string | null;
    };
  } = {},
) {
  const stopContainer = vi.fn(overrides.stopContainer ?? (() => ({ status: 0 })));
  const surface = createDockerRuntimeProviderQuarantineSurface("docker", {
    captureHostCommand: overrides.captureHostCommand ?? (() => lifecycleCapture("running")),
    queryRuntimeSnapshot: overrides.queryRuntimeSnapshot ?? (() => runtimeSnapshot()),
    stopContainer,
    observeSandbox:
      overrides.observeSandbox ??
      (() => ({ state: "ready", liveIdentityFingerprint: LIVE_IDENTITY })),
  });
  expect(surface.supported).toBe(true);
  return {
    surface: surface as Extract<typeof surface, { readonly supported: true }>,
    stopContainer,
  };
}

describe("Docker runtime provider quarantine authority", () => {
  it("stops only the immutable container ID captured by prepare (#10140)", () => {
    const test = supportedSurface();
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toEqual({ outcome: "succeeded" });
    expect(test.stopContainer).toHaveBeenCalledOnce();
    expect(test.stopContainer).toHaveBeenCalledWith(CONTAINER_ID, {
      ignoreError: true,
      timeout: 30_000,
    });
  });

  it("rejects duplicate labeled targets before any stop mutation (#10140)", () => {
    const queryRuntimeSnapshot = vi
      .fn()
      .mockReturnValueOnce(runtimeSnapshot())
      .mockReturnValueOnce({ ok: false, error: "expected one labeled sandbox container, found 2" });
    const test = supportedSurface({ queryRuntimeSnapshot });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it("rejects a replacement container before any stop mutation (#10140)", () => {
    const queryRuntimeSnapshot = vi
      .fn()
      .mockReturnValueOnce(runtimeSnapshot())
      .mockReturnValueOnce(runtimeSnapshot(REPLACEMENT_ID));
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce(lifecycleCapture("running"))
      .mockReturnValueOnce(lifecycleCapture("running", REPLACEMENT_ID));
    const test = supportedSurface({ queryRuntimeSnapshot, captureHostCommand });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it("rejects a replacement OpenShell identity before any stop mutation (#10140)", () => {
    const observeSandbox = vi
      .fn()
      .mockReturnValueOnce({ state: "ready", liveIdentityFingerprint: LIVE_IDENTITY })
      .mockReturnValueOnce({
        state: "ready",
        liveIdentityFingerprint: "f".repeat(64),
      });
    const test = supportedSurface({ observeSandbox });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it.each([
    ["gateway", { gatewayName: "replacement" }],
    ["registry lifecycle generation", { lifecycleGeneration: "registry-generation-2" }],
  ])("rejects %s drift before any stop mutation (#10140)", (_case, sandboxOverride) => {
    const test = supportedSurface();
    const original = input();
    const authority = test.surface.prepare(original);
    const changed: RuntimeProviderQuarantineInput = {
      ...original,
      sandbox: { ...original.sandbox, ...sandboxOverride },
    };

    expect(test.surface.stop(changed, authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it("rejects provider lifecycle-generation drift before any stop mutation (#10140)", () => {
    const changedLifecycle = {
      ...lifecycleCapture("running"),
      stdout: JSON.stringify([
        CONTAINER_ID,
        "running",
        false,
        "2026-08-25T05:00:00.000000000Z",
        "0001-01-01T00:00:00Z",
        1,
      ]),
    };
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce(lifecycleCapture("running"))
      .mockReturnValueOnce(changedLifecycle);
    const test = supportedSurface({ captureHostCommand });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it("does not retry a timed-out stop transport (#10140)", () => {
    const test = supportedSurface({ stopContainer: () => ({ status: null }) });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toMatchObject({ outcome: "failed" });
    expect(test.stopContainer).toHaveBeenCalledOnce();
  });

  it("treats an exact already-stopped runtime as an idempotent no-op (#10140)", () => {
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce(lifecycleCapture("running"))
      .mockReturnValueOnce(lifecycleCapture("stopped"));
    const test = supportedSurface({ captureHostCommand });
    const authority = test.surface.prepare(input());

    expect(test.surface.stop(input(), authority)).toEqual({ outcome: "succeeded" });
    expect(test.stopContainer).not.toHaveBeenCalled();
  });

  it("independently confirms provider execution and OpenShell access after stop (#10140)", () => {
    const test = supportedSurface({
      captureHostCommand: () => lifecycleCapture("stopped"),
      observeSandbox: () => ({
        state: "not_ready",
        liveIdentityFingerprint: LIVE_IDENTITY,
      }),
    });
    const authority = test.surface.prepare(input());

    expect(test.surface.observe(input(), authority)).toEqual({
      execution: { outcome: "succeeded" },
      sandboxAccess: { outcome: "succeeded" },
    });
  });
});
