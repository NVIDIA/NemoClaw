// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  cloneSandboxRuntimeSnapshot,
  SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
} from "./runtime-snapshot";

function gpuSnapshot() {
  return {
    schemaVersion: SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    providerId: "mxc",
    providerHandle: "mxc-snapshot:opaque-123",
    lifecycleState: "running",
    lifecycleGeneration: "generation-42",
    runtime: {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "session", handle: "opaque-session-42" },
      acceleration: {
        kind: "gpu",
        vendor: "nvidia",
        devices: ["nvidia.com/gpu=0"],
      },
    },
  } as const;
}

describe("sandbox runtime snapshot normalization", () => {
  it("clones opaque provider and runtime handles without interpreting them", () => {
    const input = gpuSnapshot();
    const normalized = cloneSandboxRuntimeSnapshot(input);

    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(normalized?.runtime).not.toBe(input.runtime);
    expect(normalized?.runtime.acceleration).not.toBe(input.runtime.acceleration);
  });

  it("rejects provider identity drift between the wrapper and runtime receipt", () => {
    expect(
      cloneSandboxRuntimeSnapshot({
        ...gpuSnapshot(),
        providerId: "docker",
      }),
    ).toBeUndefined();
  });

  it.each([
    { lifecycleState: "restarting" },
    { lifecycleGeneration: "" },
    { providerHandle: "" },
    { providerHandle: "opaque\nhandle" },
    { schemaVersion: 2 },
  ])("rejects an unrepresentable persisted wrapper: %j", (change) => {
    expect(cloneSandboxRuntimeSnapshot({ ...gpuSnapshot(), ...change })).toBeUndefined();
  });

  it("rejects malformed or duplicate normalized acceleration devices", () => {
    expect(
      cloneSandboxRuntimeSnapshot({
        ...gpuSnapshot(),
        runtime: {
          ...gpuSnapshot().runtime,
          acceleration: {
            kind: "gpu",
            vendor: "nvidia",
            devices: ["nvidia.com/gpu=0", "nvidia.com/gpu=0"],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("drops unknown persisted keys instead of widening snapshot authority", () => {
    expect(
      cloneSandboxRuntimeSnapshot({
        ...gpuSnapshot(),
        engine: "podman",
        containerName: "must-not-become-authority",
        runtime: {
          ...gpuSnapshot().runtime,
          command: ["delete", "by-name"],
        },
      }),
    ).toEqual(gpuSnapshot());
  });

  it.each([
    {
      label: "runtime control characters",
      runtime: {
        ...gpuSnapshot().runtime,
        runtime: { kind: "session", handle: "opaque\nsession" },
      },
    },
    {
      label: "empty runtime kind",
      runtime: {
        ...gpuSnapshot().runtime,
        runtime: { kind: "", handle: "opaque" },
      },
    },
    {
      label: "empty GPU device inventory",
      runtime: {
        ...gpuSnapshot().runtime,
        acceleration: { kind: "gpu", vendor: "nvidia", devices: [] },
      },
    },
    {
      label: "unknown acceleration kind",
      runtime: {
        ...gpuSnapshot().runtime,
        acceleration: { kind: "tpu", devices: ["all"] },
      },
    },
  ])("rejects $label in the nested provider receipt", ({ runtime }) => {
    expect(cloneSandboxRuntimeSnapshot({ ...gpuSnapshot(), runtime })).toBeUndefined();
  });

  it("accepts a bounded provider-neutral no-acceleration receipt", () => {
    expect(
      cloneSandboxRuntimeSnapshot({
        schemaVersion: 1,
        providerId: "kubernetes",
        providerHandle: "opaque-provider-handle",
        lifecycleState: "stopped",
        lifecycleGeneration: "generation-1",
        runtime: {
          schemaVersion: 1,
          providerId: "kubernetes",
          runtime: { kind: "sandbox", handle: "opaque-runtime-handle" },
          acceleration: { kind: "none" },
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      providerId: "kubernetes",
      providerHandle: "opaque-provider-handle",
      lifecycleState: "stopped",
      lifecycleGeneration: "generation-1",
      runtime: {
        schemaVersion: 1,
        providerId: "kubernetes",
        runtime: { kind: "sandbox", handle: "opaque-runtime-handle" },
        acceleration: { kind: "none" },
      },
    });
  });
});
