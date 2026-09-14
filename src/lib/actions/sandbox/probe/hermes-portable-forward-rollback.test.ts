// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { type AddressInfo, createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { createHermesPortableForwardRecoveryFixture as createRecoveryFixture } from "../../../../../test/support/hermes-portable-forward-recovery-fixture";
import {
  prepareHermesPortableLaunchForwards,
  recoverHermesPortableLaunchForwards,
} from "./hermes-portable-forward-recovery";
import {
  launchForwardService,
  terminateForwardServiceProcessTree,
  type ForwardServiceTarget,
  type ForwardServiceLaunchOptions,
} from "../../../adapters/openshell/forward-service";
import { probeLocalForwardListener } from "../../../adapters/openshell/local-forward-listener";

describe("Hermes Portable rollback ownership", () => {
  it("rejects a ready launcher that omits rollback ownership (#11649)", async () => {
    const fixture = createRecoveryFixture();
    const launch = fixture.input.deps.launchForwardService!;
    Object.assign(fixture.input.deps, {
      launchForwardService: (target: ForwardServiceTarget, options: ForwardServiceLaunchOptions) =>
        launch(target, { ...options, retainOwnership: undefined }),
    });

    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      expect.objectContaining({ failure: "restoration-unproved" }),
    );
    expect(fixture.records.has(18_789)).toBe(true);
    expect(fixture.currentMutationCalls).toEqual([]);
  });

  it("rolls back only the retained first child when the second launch fails (#11649)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    const launch = fixture.input.deps.launchForwardService!;
    const terminate = vi.fn(() => {
      fixture.records.delete(18_789);
    });
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn()
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          options.retainOwnership?.({ terminate });
        })
        .mockImplementationOnce(() => {
          throw new Error("second launch failed before spawn");
        }),
    });
    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(terminate).toHaveBeenCalledOnce();
    expect([...fixture.records.keys()]).toEqual([]);
    expect(fixture.currentMutationCalls).toEqual([]);
  });

  it("retains rollback ownership until cleanup succeeds and permits a safe retry (#11649)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789] });
    const launch = fixture.input.deps.launchForwardService!;
    const terminate = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("temporary cleanup failure");
      })
      .mockImplementationOnce(() => fixture.records.delete(18_789));
    Object.assign(fixture.input.deps, {
      launchForwardService: (
        target: ForwardServiceTarget,
        options: ForwardServiceLaunchOptions,
      ) => {
        launch(target, options);
        options.retainOwnership?.({ terminate });
      },
    });
    const prepared = await prepareHermesPortableLaunchForwards(fixture.input);
    await expect(prepared.rollback()).rejects.toThrow("restoration-unproved");
    await expect(prepared.rollback()).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect([...fixture.records.keys()]).toEqual([]);
  });

  it("terminates the retained child when its listener disappears before rollback (#11649)", async () => {
    const fixture = createRecoveryFixture({ ports: [18_789, 8_642] });
    const launch = fixture.input.deps.launchForwardService!;
    const terminate = vi.fn(() => {
      fixture.records.delete(18_789);
    });
    Object.assign(fixture.input.deps, {
      launchForwardService: vi
        .fn()
        .mockImplementationOnce((target, options) => {
          launch(target, options);
          options.retainOwnership?.({ terminate });
          fixture.records.get(18_789)!.reachable = false;
        })
        .mockImplementationOnce(() => {
          throw new Error("second launch failed before spawn");
        }),
    });

    await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
      "recovery-failed",
    );
    expect(terminate).toHaveBeenCalledOnce();
    expect([...fixture.records.keys()]).toEqual([]);
    expect(fixture.currentMutationCalls).toEqual([]);
  });
});

describe("Hermes Portable rollback observation failures", () => {
  it.each([
    { label: "failed capture", capture: () => ({ status: 1, output: "" }) },
    { label: "invalid list", capture: () => ({ status: 0, output: "invalid" }) },
    {
      label: "throwing capture",
      capture: () => {
        throw new Error("rollback capture failed");
      },
    },
  ])("terminates its retained child before a $label (#11649)", async ({ capture }) => {
    const fixture = createRecoveryFixture();
    const launch = fixture.input.deps.launchForwardService!;
    const terminate = vi.fn(() => {
      fixture.records.delete(18_789);
    });
    Object.assign(fixture.input.deps, {
      launchForwardService: (
        target: ForwardServiceTarget,
        options: ForwardServiceLaunchOptions,
      ) => {
        launch(target, options);
        options.retainOwnership?.({ terminate });
      },
      captureRollbackList: capture,
    });
    const prepared = await prepareHermesPortableLaunchForwards(fixture.input);

    await expect(prepared.rollback()).rejects.toThrow("restoration-unproved");
    expect(terminate).toHaveBeenCalledOnce();
    expect(fixture.records.has(18_789)).toBe(false);
    expect(fixture.currentMutationCalls).toEqual([]);
  });
});

describe("Hermes Portable forward rollback with a real child", () => {
  it("rolls back the real adapter child after the second forward fails (#11649)", async () => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    const secondPort = port === 65_535 ? port - 1 : port + 1;
    const fixture = createRecoveryFixture({ ports: [port, secondPort] });
    Object.assign(fixture.input.forwardService, { executablePath: process.execPath });
    let child: ChildProcess | undefined;
    let closed: Promise<unknown[]> | undefined;
    const launch = vi
      .fn<(target: ForwardServiceTarget, options: ForwardServiceLaunchOptions) => Promise<void>>()
      .mockImplementationOnce((target, options) => {
        // Exercise the production ownership producer and consumer; only replace the executable.
        return launchForwardService(target, {
          ...options,
          spawnDetached: () => {
            child = spawn(
              process.execPath,
              ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1")`],
              { detached: true, stdio: "ignore" },
            );
            closed = once(child, "close");
            return child;
          },
        });
      })
      .mockImplementationOnce(() => {
        expect(probeLocalForwardListener(port, 100)).toBe(true);
        throw new Error("second forward failed before spawn");
      });
    Object.assign(fixture.input.deps, {
      launchForwardService: launch,
      isPortReachable: (candidate: number) =>
        candidate === port && probeLocalForwardListener(candidate, 100),
      // The disposable Node listener does not have the OpenShell command line.
      isForwardServiceOwner: (target: ForwardServiceTarget) =>
        target.localPort === port && probeLocalForwardListener(port, 100),
    });
    try {
      await expect(recoverHermesPortableLaunchForwards(fixture.input)).rejects.toThrow(
        "recovery-failed",
      );
      expect(launch.mock.calls.map(([target]) => target.localPort)).toEqual([port, secondPort]);
      expect(probeLocalForwardListener(port, 100)).toBe(false);
      await vi.waitFor(
        () => expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true),
        { timeout: 5_000 },
      );
      await closed;
      expect(fixture.currentMutationCalls).toEqual([]);
    } finally {
      child?.exitCode === null &&
        child.signalCode === null &&
        terminateForwardServiceProcessTree(child);
      await closed;
    }
  }, 10_000);
});
