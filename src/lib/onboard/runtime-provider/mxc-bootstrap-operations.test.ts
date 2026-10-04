// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { RuntimeProviderNativeArtifactBootstrapPlan } from "./contract";
import {
  createMxcNativeArtifactBootstrapOperations,
  MxcNativeArtifactControlPlaneError,
  type MxcNativeArtifactControlPlane,
} from "./mxc-bootstrap-operations";

const PLAN = Object.freeze({
  providerId: "mxc",
}) as unknown as RuntimeProviderNativeArtifactBootstrapPlan;

function controlPlane(): MxcNativeArtifactControlPlane {
  return {
    contractVersion: 1,
    providerId: "mxc",
    verifyAndCreate: vi.fn(async () => ({ status: "unknown" as const })),
    verifyReadiness: vi.fn(async () => {
      throw new Error("readiness unavailable");
    }),
    recoverCreate: vi.fn(async () => ({ status: "absent" as const })),
  };
}

describe("inactive MXC native-artifact control-plane adapter", () => {
  it("binds one provider-owned control plane before a caller can replace its methods (#8178)", async () => {
    const providerControlPlane = controlPlane();
    const originalVerifyAndCreate = providerControlPlane.verifyAndCreate;
    const replacementVerifyAndCreate = vi.fn(async () => ({ status: "created" as const }));
    const operations = createMxcNativeArtifactBootstrapOperations(providerControlPlane);

    Reflect.set(providerControlPlane, "verifyAndCreate", replacementVerifyAndCreate);
    const outcome = await operations.verifyAndCreate(PLAN);

    expect(outcome).toEqual({ status: "unknown" });
    expect(originalVerifyAndCreate).toHaveBeenCalledOnce();
    expect(replacementVerifyAndCreate).not.toHaveBeenCalled();
    expect(Object.isFrozen(operations)).toBe(true);
  });

  it.each([
    {
      label: "provider identity drift",
      mutate: (value: MxcNativeArtifactControlPlane) => ({ ...value, providerId: "docker" }),
      message: /provider identity/u,
    },
    {
      label: "contract version drift",
      mutate: (value: MxcNativeArtifactControlPlane) => ({ ...value, contractVersion: 2 }),
      message: /contract version/u,
    },
    {
      label: "missing atomic operation",
      mutate: (value: MxcNativeArtifactControlPlane) => ({
        ...value,
        verifyAndCreate: undefined,
      }),
      message: /atomic verify-and-create/u,
    },
    {
      label: "missing readiness operation",
      mutate: (value: MxcNativeArtifactControlPlane) => ({
        ...value,
        verifyReadiness: undefined,
      }),
      message: /readiness, and recovery operations/u,
    },
    {
      label: "missing recovery operation",
      mutate: (value: MxcNativeArtifactControlPlane) => ({
        ...value,
        recoverCreate: undefined,
      }),
      message: /readiness, and recovery operations/u,
    },
  ])("rejects $label before the bundle can run (#8178)", ({ mutate, message }) => {
    expect(() =>
      createMxcNativeArtifactBootstrapOperations(
        mutate(controlPlane()) as unknown as MxcNativeArtifactControlPlane,
      ),
    ).toThrow(MxcNativeArtifactControlPlaneError);
    expect(() =>
      createMxcNativeArtifactBootstrapOperations(
        mutate(controlPlane()) as unknown as MxcNativeArtifactControlPlane,
      ),
    ).toThrow(message);
  });
});
