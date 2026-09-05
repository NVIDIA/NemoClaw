// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  launchForwardService,
  type ForwardServiceTarget,
} from "./forward-service";

const target: ForwardServiceTarget = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default",
  sandboxName: "demo",
  localHost: "127.0.0.1",
  localPort: 18_789,
  targetHost: "127.0.0.1",
  targetPort: 18_789,
};

describe("OpenShell forward service", () => {
  it("builds the direct ForwardTcp command with explicit gateway authority", () => {
    expect(buildForwardServiceArgs(target)).toEqual([
      "--gateway",
      "nemoclaw",
      "--workspace",
      "default",
      "forward",
      "service",
      "demo",
      "--target-port",
      "18789",
      "--target-host",
      "127.0.0.1",
      "--local",
      "127.0.0.1:18789",
    ]);
  });

  it("builds the direct ForwardTcp command for a selected non-default workspace", () => {
    expect(buildForwardServiceArgs({ ...target, workspace: "review-workspace" })).toContain(
      "review-workspace",
    );
  });

  it("detaches the OpenShell child and waits for its local port", () => {
    const unref = vi.fn();
    const spawnDetached = vi.fn(() => ({ pid: 41, unref }));
    let probes = 0;

    launchForwardService(target, {
      isReachable: () => ++probes >= 3,
      isProcessRunning: () => true,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledWith(
      target.executable,
      buildForwardServiceArgs(target),
      expect.any(Object),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("refuses an occupied port without launching or adopting its listener", () => {
    const spawnDetached = vi.fn();

    expect(() => launchForwardService(target, { isReachable: () => true, spawnDetached })).toThrow(
      /already occupied/u,
    );
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it("reports a running service that remains unbound at the deadline (#11084)", () => {
    const unboundTarget = { ...target, localPort: 18_791, targetPort: 18_791 };
    expect(() =>
      launchForwardService(unboundTarget, {
        describeState: () => "SANDBOX BIND PORT PID STATUS",
        isProcessRunning: () => true,
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ pid: 42, unref: () => {} }),
        timeoutMs: 0,
      }),
    ).toThrow(/remained running but did not bind.*forward list: SANDBOX BIND PORT PID STATUS/u);
  });

  it("retries only after the prior service process exited (#11084)", () => {
    const spawnDetached = vi
      .fn()
      .mockReturnValueOnce({ pid: 51, unref: vi.fn() })
      .mockReturnValueOnce({ pid: 52, unref: vi.fn() });
    launchForwardService(target, {
      isProcessRunning: (pid) => pid === 52,
      isReachable: () => spawnDetached.mock.calls.length === 2,
      retryDelayMs: 0,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 1_000,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate a service that is still settling (#11084)", () => {
    const settlingTarget = { ...target, localPort: 18_790, targetPort: 18_790 };
    const spawnDetached = vi.fn(() => ({ pid: 61, unref: vi.fn() }));
    const options = {
      isProcessRunning: () => true,
      isReachable: () => false,
      sleep: () => {},
      spawnDetached,
      timeoutMs: 0,
    };

    expect(() => launchForwardService(settlingTarget, options)).toThrow(/remained running/u);
    expect(() => launchForwardService(settlingTarget, options)).toThrow(/still settling/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("refuses an unknown listener that appears before a safe retry (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ pid: 71, unref: vi.fn() }));
    let probes = 0;

    expect(() =>
      launchForwardService(target, {
        isProcessRunning: () => false,
        isReachable: () => ++probes >= 3,
        retryDelayMs: 0,
        sleep: () => {},
        spawnDetached,
        timeoutMs: 1_000,
      }),
    ).toThrow(/became occupied.*refusing to adopt/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("does not retry when the service returns no process identity (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    expect(() =>
      launchForwardService(target, {
        describeState: () => {
          throw new Error("forward list failed");
        },
        isReachable: () => false,
        sleep: () => {},
        spawnDetached,
      }),
    ).toThrow(/no process identity.*forward list: <unavailable>/u);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });
});
