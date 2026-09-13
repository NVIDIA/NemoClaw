// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHermesPortableForwardRecoveryFixture as createRecoveryFixture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import type {
  ForwardServiceLaunchOptions,
  ForwardServiceTarget,
} from "../../../adapters/openshell/forward-service";
import { recoverHermesPortableLaunchForwards } from "./hermes-portable-forward-recovery";

describe("Hermes Portable forward recovery deadline", () => {
  it("rejects settlement when the final ownership check exhausts the allowance (#11652)", async () => {
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
      "restoration-unproved",
    );
    expect(fixture.elapsedMs()).toBe(100);
    expect(fixture.rollbackCaptureCalls).not.toHaveLength(0);
  });

  it("passes the remaining transaction allowance to the second forward (#11652)", async () => {
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
      "restoration-unproved",
    );
    expect(allowances).toEqual([100, 40]);
    expect(fixture.elapsedMs()).toBe(100);
  });
});
