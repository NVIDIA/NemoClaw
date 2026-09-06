// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildForwardServiceArgs,
  isForwardServiceListenerOwner,
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

  it("proves the exact direct ForwardTcp listener before reuse", () => {
    const expected = [target.executable, ...buildForwardServiceArgs(target)].join(" ");
    const probe = vi.fn((executable: string) =>
      executable === "lsof"
        ? { status: 0, stdout: "4321\n" }
        : { status: 0, stdout: `${expected}\n` },
    );

    expect(isForwardServiceListenerOwner(target, { probe })).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("rejects a listener whose process does not match the direct ForwardTcp target", () => {
    const probe = vi.fn((executable: string) =>
      executable === "lsof"
        ? { status: 0, stdout: "4321\n" }
        : { status: 0, stdout: "/usr/bin/node foreign-listener.js\n" },
    );

    expect(isForwardServiceListenerOwner(target, { probe })).toBe(false);
  });

  it("rejects ambiguous or changing listener ownership", () => {
    const expected = [target.executable, ...buildForwardServiceArgs(target)].join(" ");
    const probe = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "4321\n" })
      .mockReturnValueOnce({ status: 0, stdout: `${expected}\n` })
      .mockReturnValueOnce({ status: 0, stdout: "9876\n" });

    expect(isForwardServiceListenerOwner(target, { probe })).toBe(false);
  });

  it("detaches the OpenShell child and waits for its local port", () => {
    const unref = vi.fn();
    const spawnDetached = vi.fn(() => ({ unref }));
    let probes = 0;

    launchForwardService(target, {
      isReachable: () => ++probes >= 3,
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

  it("fails when the detached service does not bind before the deadline", () => {
    expect(() =>
      launchForwardService(target, {
        isReachable: () => false,
        sleep: () => {},
        spawnDetached: () => ({ unref: () => {} }),
        timeoutMs: 0,
      }),
    ).toThrow(/did not bind/u);
  });
});
