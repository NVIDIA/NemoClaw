// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createHermesPortableForwardRecoveryFixture as createRecoveryFixture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import type {
  ForwardServiceLaunchOptions,
  ForwardServiceTarget,
} from "../../../adapters/openshell/forward-service";
import {
  HermesPortableForwardRecoveryError,
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
} from "./hermes-portable-forward-recovery";

describe("Hermes Portable forward recovery deadline", () => {
  it("verifies both healthy forwards when authority checks take several seconds", async () => {
    const fixture = createRecoveryFixture({ ports: [8_642, 18_789] });
    Object.assign(fixture.input, { operationTimeoutMs: 60_000 });
    const assertCurrent = fixture.input.deps.assertCurrent;
    Object.assign(fixture.input.deps, {
      assertCurrent: () => {
        assertCurrent();
        fixture.input.deps.sleep!(1_500);
      },
    });

    await expect(recoverHermesPortableLaunchForwards(fixture.input)).resolves.toEqual({
      kind: "restored",
      restoredPorts: [8_642, 18_789],
    });
    expect(fixture.elapsedMs()).toBeGreaterThan(30_000);
    expect(fixture.elapsedMs()).toBeLessThan(60_000);
    expect(fixture.records.size).toBe(2);
  });

  it("proves owned-child cleanup when rollback authority checks take several seconds", async () => {
    const fixture = createRecoveryFixture({ ports: [8_642, 18_789] });
    const prepared = await prepareHermesPortableLaunchForwards(fixture.input);
    const assertRollbackCurrent = fixture.input.deps.assertRollbackCurrent;
    Object.assign(fixture.input.deps, {
      assertRollbackCurrent: () => {
        assertRollbackCurrent();
        fixture.input.deps.sleep!(1_500);
      },
    });

    await expect(prepared.rollback()).resolves.toBeUndefined();
    expect(fixture.records.size).toBe(0);
    expect(fixture.currentMutationCalls).toHaveLength(0);
  });

  it("preserves the initiating timeout when rollback cannot be verified", async () => {
    const fixture = createRecoveryFixture();
    const launch = fixture.input.deps.launchForwardService!;
    Object.assign(fixture.input.deps, {
      launchForwardService: async (
        target: ForwardServiceTarget,
        options: ForwardServiceLaunchOptions,
      ) => {
        await launch(target, options);
        fixture.setRollbackAllowed(false);
        throw new HermesPortableForwardRecoveryError("recovery-failed", {
          cause: "forward-settlement-timed-out",
        });
      },
    });

    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toMatchObject({
      failure: "restoration-unproved",
      context: { cause: "forward-settlement-timed-out" },
    });
    expect(fixture.records.size).toBe(1);
    expect(fixture.currentMutationCalls).toHaveLength(0);
  });

  it("rejects cleanup evidence collected after its observation allowance expires", async () => {
    const fixture = createRecoveryFixture();
    const prepared = await prepareHermesPortableLaunchForwards(fixture.input);
    Object.assign(fixture.input.deps, {
      isPortReachable: () => {
        fixture.input.deps.sleep!(31_000);
        return false;
      },
    });

    await expect(prepared.rollback()).rejects.toMatchObject({ failure: "restoration-unproved" });
    expect(fixture.records.size).toBe(0);
    expect(fixture.rollbackCaptureCalls).toHaveLength(1);
  });

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

  it("restores owned children after concurrent forwards share the recovery allowance (#11649, #11652)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    Object.assign(fixture.input, { operationTimeoutMs: 100 });
    const launch = fixture.input.deps.launchForwardService!;
    const allowances: number[] = [];
    const launchWithDelay = async (
      target: ForwardServiceTarget,
      options: ForwardServiceLaunchOptions,
    ) => {
      allowances.push(options.timeoutMs!);
      await launch(target, options);
      await fixture.input.deps.sleep!(options.timeoutMs!);
    };
    const launchWithoutDelay = async (
      target: ForwardServiceTarget,
      options: ForwardServiceLaunchOptions,
    ) => {
      allowances.push(options.timeoutMs!);
      await launch(target, options);
    };
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn()
        .mockImplementationOnce(launchWithDelay)
        .mockImplementationOnce(launchWithoutDelay),
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(allowances).toEqual([100, 100]);
    expect(fixture.elapsedMs()).toBe(100);
    expect(fixture.records.size).toBe(0);
  });
});
