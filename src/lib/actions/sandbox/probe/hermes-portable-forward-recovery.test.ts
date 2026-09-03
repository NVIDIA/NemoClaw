// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
  verifyHermesPortableLaunchForwards,
  type HermesPortableForwardRecoveryInput,
} from "./hermes-portable-forward-recovery";

function input(reachable: Set<number>): HermesPortableForwardRecoveryInput {
  return {
    intent: "connect-probe-only",
    sandboxName: "hermes",
    gatewayName: "nemoclaw",
    operationTimeoutMs: 30_000,
    ports: [18_789, 8_642],
    probeTimeoutMs: 1_000,
    deps: {
      assertCurrent: vi.fn(),
      assertRollbackCurrent: vi.fn(),
      isReachable: (port) => reachable.has(port),
      launch: (port) => {
        expect(reachable.has(port)).toBe(false);
        reachable.add(port);
      },
      migrateLegacy: vi.fn(),
    },
  };
}

describe("Hermes Portable ForwardTcp recovery", () => {
  it("launches each missing forward through the natural OpenShell lifecycle", () => {
    const reachable = new Set<number>();
    const request = input(reachable);

    expect(recoverHermesPortableLaunchForwards(request)).toEqual({
      kind: "restored",
      restoredPorts: [18_789, 8_642],
    });
    expect(request.deps.migrateLegacy).toHaveBeenCalledWith([18_789, 8_642]);
  });

  it("does not relaunch reachable ports", () => {
    const request = input(new Set([18_789, 8_642]));
    expect(recoverHermesPortableLaunchForwards(request)).toEqual({
      kind: "verified",
      restoredPorts: [],
    });
    expect(request.deps.migrateLegacy).not.toHaveBeenCalled();
  });

  it("verifies reachability without inspecting or signaling a process", () => {
    expect(verifyHermesPortableLaunchForwards(input(new Set([18_789, 8_642])))).toEqual({
      kind: "healthy",
    });
  });

  it("keeps rollback free of process control", () => {
    const request = input(new Set<number>());
    const prepared = prepareHermesPortableLaunchForwards(request);
    prepared.rollback();
    expect(request.deps.assertRollbackCurrent).toHaveBeenCalledOnce();
  });
});
