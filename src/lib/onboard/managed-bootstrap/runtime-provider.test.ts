// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ManagedBootstrapAdapter } from "./adapter";
import {
  type ManagedBootstrapRuntimeProvider,
  resolveManagedBootstrapRuntimeProvider,
} from "./runtime-provider";
import {
  CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS,
  resolveCurrentManagedBootstrapRuntimeProvider,
  resolvePersistedManagedBootstrapRuntimeProvider,
} from "./runtime-providers";

const REPLACEMENT_INTENT = {
  acceleration: {
    strategy: "cdi",
    label: "--device nvidia.com/gpu=all",
    device: "nvidia.com/gpu=all",
    arguments: ["--device", "nvidia.com/gpu=all"],
  },
  limits: [{ name: "nofile", soft: 1024, hard: 2048 }],
  supplementaryGroupIds: ["44", "109"],
} as const;

describe("managed bootstrap runtime providers", () => {
  it("routes Docker through the registered adapter and option translator", () => {
    const provider = resolveCurrentManagedBootstrapRuntimeProvider("docker");

    expect(Object.keys(CURRENT_MANAGED_BOOTSTRAP_RUNTIME_PROVIDERS)).toEqual(["docker"]);
    expect(provider.driverId).toBe("docker");
    expect(Object.keys(provider.createAdapter()).sort()).toEqual([
      "awaitBootstrap",
      "cleanupIncompleteCreate",
      "createHeldWorkload",
      "discoverHeldWorkload",
      "finalizeBootstrap",
      "inspectHeldWorkload",
      "replaceForBootstrap",
    ]);
    expect(provider.createReplacementOptions(REPLACEMENT_INTENT)).toEqual({
      values: {
        gpuModeArgs: ["--device", "nvidia.com/gpu=all"],
        gpuModeDevice: "nvidia.com/gpu=all",
        gpuModeKind: "cdi",
        gpuModeLabel: "--device nvidia.com/gpu=all",
        requiredUlimits: ["nofile=1024:2048"],
        extraGroupGids: ["44", "109"],
      },
    });
  });

  it.each([
    "podman",
    "mxc",
    "future-runtime",
  ])("fails closed for unregistered driver '%s'", (driverName) => {
    expect(() => resolveCurrentManagedBootstrapRuntimeProvider(driverName)).toThrow(
      `driver '${driverName}' is not registered`,
    );
  });

  it("canonicalizes legacy persisted Docker identities without registering new drivers", () => {
    expect(resolvePersistedManagedBootstrapRuntimeProvider("vm").driverId).toBe("docker");
    expect(resolvePersistedManagedBootstrapRuntimeProvider("docker").driverId).toBe("docker");
    expect(resolvePersistedManagedBootstrapRuntimeProvider(undefined).driverId).toBe("docker");
    expect(resolvePersistedManagedBootstrapRuntimeProvider(null).driverId).toBe("docker");
    expect(() => resolvePersistedManagedBootstrapRuntimeProvider("podman")).toThrow(
      "driver 'podman' is not registered",
    );
    expect(() => resolvePersistedManagedBootstrapRuntimeProvider("mxc")).toThrow(
      "driver 'mxc' is not registered",
    );
  });

  it("resolves a new driver only after an explicit matching registration", () => {
    const adapter = {} as ManagedBootstrapAdapter;
    const provider: ManagedBootstrapRuntimeProvider = {
      driverId: "podman",
      createAdapter: vi.fn(() => adapter),
      createReplacementOptions: vi.fn(() => ({ values: {} })),
      createCreateLifecycle: vi.fn(() => {
        throw new Error("not used");
      }),
      createOnboardRouting: vi.fn(() => {
        throw new Error("not used");
      }),
    };

    expect(resolveManagedBootstrapRuntimeProvider("podman", { podman: provider })).toBe(provider);
    expect(() =>
      resolveManagedBootstrapRuntimeProvider("podman", {
        podman: { ...provider, driverId: "mxc" },
      }),
    ).toThrow("registry key 'podman' does not match provider 'mxc'");
  });
});
