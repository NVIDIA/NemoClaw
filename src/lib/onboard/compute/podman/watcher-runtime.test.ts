// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  capturePodmanGatewayListenerPids,
  createPodmanProductionWatcherController,
} from "./watcher-runtime";

describe("Podman production watcher runtime", () => {
  it("leases and resumes the exact standalone launch slot", () => {
    let listenerPids = [101];
    const starts = new Map<number, string>([[101, "1001"]]);
    const stop = vi.fn((pid: number) => {
      listenerPids = [];
      starts.delete(pid);
    });
    const resume = vi.fn(() => {
      listenerPids = [202];
      starts.set(202, "2002");
      return 202;
    });
    const controller = createPodmanProductionWatcherController({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      getRuntimeDrift: vi.fn(() => null),
      isGatewayHealthy: vi.fn(() => true),
      standalone: {
        launchIdentity: "standalone-launch",
        ownerIdentity: "standalone-owner",
        readOwnedPid: () => listenerPids[0] ?? null,
        resume,
        stop,
      },
      deps: {
        captureListenerPids: () => listenerPids,
        captureProcessStartIdentity: (pid) => starts.get(pid) ?? null,
      },
      readiness: { now: () => 0, sleep: vi.fn() },
    });

    const lease = controller.quiesceAndProve();
    lease.assertStillStopped();
    lease.resumeAndProve();

    expect(stop).toHaveBeenCalledWith(101);
    expect(resume).toHaveBeenCalledOnce();
    expect(listenerPids).toEqual([202]);
  });

  it("binds a package-managed service across a new process generation", () => {
    type Receipt = { pid: number; start: string };
    let active = true;
    let receipt: Receipt = { pid: 303, start: "3003" };
    let listenerPids = [303];
    const lifecycle = {
      assertInactive: vi.fn(() => {
        if (active) throw new Error("still active");
      }),
      captureActive: vi.fn(() => receipt),
      describe: vi.fn((value: Receipt) => ({
        launchIdentity: "service-launch",
        ownerIdentity: "service-owner",
        pid: value.pid,
        processStartIdentity: value.start,
      })),
      resumeAndProve: vi.fn(() => {
        active = true;
        receipt = { pid: 404, start: "4004" };
        listenerPids = [404];
        return receipt;
      }),
      stopAndProveInactive: vi.fn(() => {
        active = false;
        listenerPids = [];
      }),
    };
    const controller = createPodmanProductionWatcherController({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      getRuntimeDrift: vi.fn(() => null),
      isGatewayHealthy: vi.fn(() => true),
      service: lifecycle,
      standalone: {
        launchIdentity: "unused",
        ownerIdentity: "unused",
        readOwnedPid: () => null,
        resume: vi.fn(() => 0),
        stop: vi.fn(),
      },
      deps: {
        captureListenerPids: () => listenerPids,
        captureProcessStartIdentity: (pid) =>
          pid === receipt.pid && active ? receipt.start : null,
      },
      readiness: { now: () => 0, sleep: vi.fn() },
    });

    const lease = controller.quiesceAndProve();
    lease.assertStillStopped();
    lease.resumeAndProve();

    expect(lifecycle.stopAndProveInactive).toHaveBeenCalledWith({
      pid: 303,
      start: "3003",
    });
    expect(lifecycle.resumeAndProve).toHaveBeenCalledOnce();
    expect(listenerPids).toEqual([404]);
  });

  it("fails before stop when the exact listener has runtime drift", () => {
    const stop = vi.fn();
    const controller = createPodmanProductionWatcherController({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      getRuntimeDrift: vi.fn(() => ({ reason: "environment changed" })),
      isGatewayHealthy: vi.fn(() => true),
      standalone: {
        launchIdentity: "standalone-launch",
        ownerIdentity: "standalone-owner",
        readOwnedPid: () => 101,
        resume: vi.fn(() => 202),
        stop,
      },
      deps: {
        captureListenerPids: () => [101],
        captureProcessStartIdentity: () => "1001",
      },
    });

    expect(() => controller.quiesceAndProve()).toThrow("runtime identity drifted");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("Podman gateway listener scan", () => {
  it("returns every unique listener PID from a complete lsof scan", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "22\n11\n22\n" }));
    expect(capturePodmanGatewayListenerPids(8080, { run })).toEqual([11, 22]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("accepts an empty lsof scan only after an independent free-port proof", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    expect(capturePodmanGatewayListenerPids(8080, { run })).toEqual([]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete listener visibility", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "hidden" })
      .mockReturnValueOnce({ status: 1 });
    expect(() => capturePodmanGatewayListenerPids(8080, { run })).toThrow(
      "could not completely enumerate",
    );
  });
});
