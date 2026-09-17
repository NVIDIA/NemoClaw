// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  ForwardServiceStartupCleanupError,
} from "../../../adapters/openshell/forward-service";
import { createHermesPortableForwardRecoveryFixture as createRecoveryFixture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import { recoverHermesPortableLaunchForwards } from "./hermes-portable-forward-recovery";

describe("Hermes Portable concurrent forward recovery", () => {
  it("starts independent missing forwards concurrently before one joint settlement observation (#10926)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    const launch = fixture.input.deps.launchForwardService!;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstLaunch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondLaunch = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn(launch)
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          return firstLaunch;
        })
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          return secondLaunch;
        }),
    });
    const recovery = recoverHermesPortableLaunchForwards(fixture.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fixture.forwardServiceLaunches.map((target) => target.localPort)).toEqual([
      18_789, 8_642,
    ]);
    releaseFirst();
    releaseSecond();

    expect(await recovery).toEqual({
      kind: "restored",
      restoredPorts: [18_789, 8_642],
    });
    expect(fixture.forwardServiceLaunches.map(buildForwardServiceArgs)).toEqual([
      [
        "--gateway",
        "nemoclaw",
        "--gateway-endpoint",
        "https://127.0.0.1:8080",
        "--workspace",
        "default",
        "forward",
        "service",
        "alpha",
        "--target-port",
        "18789",
        "--target-host",
        "127.0.0.1",
        "--local",
        "127.0.0.1:18789",
      ],
      [
        "--gateway",
        "nemoclaw",
        "--gateway-endpoint",
        "https://127.0.0.1:8080",
        "--workspace",
        "default",
        "forward",
        "service",
        "alpha",
        "--target-port",
        "8642",
        "--target-host",
        "127.0.0.1",
        "--local",
        "127.0.0.1:8642",
      ],
    ]);
    expect(fixture.currentCalls.filter((args) => args[1] === "stop")).toEqual([]);
    expect(fixture.currentCalls.filter((args) => args[1] === "list")).toHaveLength(2);
    expect(fixture.currentCaptureCalls.every((args) => args[1] === "list")).toBe(true);
    expect(fixture.currentMutationCalls).toEqual([]);
    expect(fixture.rollbackCalls).toEqual([]);
    expect([...fixture.records.keys()]).toEqual([18_789, 8_642]);
  });

  it("waits for every concurrent launch before rolling back a failed batch", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    const launch = fixture.input.deps.launchForwardService!;
    let releaseSecond!: () => void;
    const secondLaunch = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn(launch)
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          throw new Error("first launch failure canary");
        })
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          return secondLaunch;
        }),
    });

    const recovery = recoverHermesPortableLaunchForwards(fixture.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect([...fixture.records.keys()]).toEqual([18_789, 8_642]);
    expect(fixture.rollbackCaptureCalls).toEqual([]);

    releaseSecond();
    await expect(recovery).rejects.toThrow("recovery-failed");
    expect([...fixture.records.keys()]).toEqual([]);
    expect(fixture.rollbackCaptureCalls).toHaveLength(2);
  });

  it("does not hide unproved cleanup behind an ordinary concurrent launch failure", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn()
        .mockRejectedValueOnce(new Error("ordinary launch failure canary"))
        .mockRejectedValueOnce(
          new ForwardServiceStartupCleanupError(
            new Error("forward did not bind"),
            new Error("process group termination failed"),
          ),
        ),
    });

    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toMatchObject({
      failure: "restoration-unproved",
    });
    expect([...fixture.records.keys()]).toEqual([]);
  });
});
