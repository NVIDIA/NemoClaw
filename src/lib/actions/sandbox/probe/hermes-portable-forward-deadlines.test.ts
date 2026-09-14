// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createHermesPortableForwardRecoveryFixture as createRecoveryFixture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import type {
  ForwardServiceLaunchOptions,
  ForwardServiceTarget,
} from "../../../adapters/openshell/forward-service";
import { recoverHermesPortableLaunchForwards } from "./hermes-portable-forward-recovery";

describe("Hermes Portable forward recovery deadline", () => {
  it("rejects a backward clock before the next initial probe (#11652)", async () => {
    const fixture = createRecoveryFixture();
    await fixture.input.deps.sleep!(10);
    const capture = fixture.input.deps.captureCurrentList;
    const reachable = vi.fn(() => false);
    Object.assign(fixture.input.deps, {
      captureCurrentList: (args: readonly string[], timeout: number) => {
        fixture.input.deps.sleep!(-1);
        return capture(args, timeout);
      },
      isPortReachable: reachable,
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow();
    expect(fixture.currentCaptureCalls).toHaveLength(1);
    expect(reachable).not.toHaveBeenCalled();
    expect(fixture.forwardServiceLaunches).toHaveLength(0);
  });

  it("caps ownership verification by the recovery allowance (#11652)", async () => {
    const fixture = createRecoveryFixture({ active: [18_789] });
    Object.assign(fixture.input, { operationTimeoutMs: 100 });
    const allowances: number[] = [];
    Object.assign(fixture.input.deps, {
      isForwardServiceOwner: (
        _target: ForwardServiceTarget,
        options?: { remainingMs?: (maximumMs: number) => number },
      ) => {
        const allowance = options?.remainingMs?.(5_000) ?? 5_000;
        allowances.push(allowance);
        fixture.input.deps.sleep!(allowance);
        return true;
      },
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow();
    expect(allowances).toEqual([100]);
    expect(fixture.elapsedMs()).toBe(100);
    expect(fixture.forwardServiceLaunches).toHaveLength(0);
  });

  it("restores an owned child after rejecting a backward operation clock (#11649, #11652)", async () => {
    const fixture = createRecoveryFixture();
    await fixture.input.deps.sleep!(10);
    const now = fixture.input.deps.now!;
    const launch = fixture.input.deps.launchForwardService!;
    let offset = 0;
    Object.assign(fixture.input.deps, {
      now: () => now() + offset,
      launchForwardService: async (
        target: ForwardServiceTarget,
        options: ForwardServiceLaunchOptions,
      ) => {
        await launch(target, options);
        offset = -1;
      },
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(fixture.forwardServiceLaunches).toHaveLength(1);
    expect(fixture.records.has(18_789)).toBe(false);
    expect(fixture.currentMutationCalls).toHaveLength(0);
    expect(fixture.rollbackCaptureCalls).not.toHaveLength(0);
  });

  it("restores an owned child when the final ownership check exhausts the allowance (#11649, #11652)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789] });
    Object.assign(fixture.input, { operationTimeoutMs: 100 });
    const owner = fixture.input.deps.isForwardServiceOwner!;
    let checks = 0;
    Object.assign(fixture.input.deps, {
      isForwardServiceOwner: (target: ForwardServiceTarget) => {
        fixture.input.deps.sleep!(++checks === 2 ? 100 : 0);
        return owner(target);
      },
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(fixture.elapsedMs()).toBe(100);
    expect(fixture.records.has(18_789)).toBe(false);
    expect(fixture.rollbackCaptureCalls).not.toHaveLength(0);
  });

  it("restores owned children after passing the remaining allowance to the second forward (#11649, #11652)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    Object.assign(fixture.input, { operationTimeoutMs: 100 });
    const launch = fixture.input.deps.launchForwardService!;
    const allowances: number[] = [];
    Object.assign(fixture.input.deps, {
      launchForwardService: async (
        target: ForwardServiceTarget,
        options: ForwardServiceLaunchOptions,
      ) => {
        allowances.push(options.timeoutMs!);
        await launch(target, options);
        await fixture.input.deps.sleep!(Math.min(60, options.timeoutMs!));
      },
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(allowances).toEqual([100, 40]);
    expect(fixture.elapsedMs()).toBe(100);
    expect(fixture.records.size).toBe(0);
  });
});
