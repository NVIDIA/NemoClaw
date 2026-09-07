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

  it("uses the selected OpenShell configuration without exposing credentials (#11084)", () => {
    const spawnDetached = vi.fn(() => ({ unref: vi.fn() }));

    launchForwardService(target, {
      isReachable: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
      sleep: () => {},
      sourceEnvironment: {
        HOME: "/tmp/isolated-home",
        NVIDIA_INFERENCE_API_KEY: "secret-value",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
      },
      spawnDetached,
    });

    expect(spawnDetached).toHaveBeenCalledWith(target.executable, buildForwardServiceArgs(target), {
      HOME: "/tmp/isolated-home",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/selected-openshell-config",
    });
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
