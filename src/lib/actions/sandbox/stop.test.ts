// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { type SandboxStopDeps, stopSandbox } from "./stop";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function container(name: string, running: boolean) {
  return { name, status: running ? "Up 5 minutes" : "Exited (0) 2 hours ago", running };
}

function harness(overrides: Partial<SandboxStopDeps> = {}) {
  const getSandbox = vi.fn<NonNullable<SandboxStopDeps["getSandbox"]>>(() => sandbox());
  const isDockerRuntimeDown = vi.fn<NonNullable<SandboxStopDeps["isDockerRuntimeDown"]>>(
    () => false,
  );
  const printDockerRuntimeDownGuidance =
    vi.fn<NonNullable<SandboxStopDeps["printDockerRuntimeDownGuidance"]>>();
  const findLabeledSandboxContainers = vi.fn<
    NonNullable<SandboxStopDeps["findLabeledSandboxContainers"]>
  >(() => [container("openshell-my-sandbox", true)]);
  const stopSandboxChannels = vi.fn<NonNullable<SandboxStopDeps["stopSandboxChannels"]>>();
  const dockerStop = vi.fn<NonNullable<SandboxStopDeps["dockerStop"]>>(() => ({ status: 0 }));
  const log = vi.fn<(message: string) => void>();
  const warn = vi.fn<(message: string) => void>();
  const deps: SandboxStopDeps = {
    getSandbox,
    isDockerRuntimeDown,
    printDockerRuntimeDownGuidance,
    findLabeledSandboxContainers,
    stopSandboxChannels,
    dockerStop,
    log,
    warn,
    ...overrides,
  };
  return {
    deps,
    dockerStop,
    findLabeledSandboxContainers,
    getSandbox,
    isDockerRuntimeDown,
    log,
    printDockerRuntimeDownGuidance,
    stopSandboxChannels,
    warn,
  };
}

describe("stopSandbox", () => {
  it("gracefully stops in-sandbox channels before stopping the container (#6026)", () => {
    const h = harness();

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.stopSandboxChannels).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ info: expect.any(Function), warn: expect.any(Function) }),
    );
    expect(h.dockerStop).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(h.stopSandboxChannels.mock.invocationCallOrder[0]).toBeLessThan(
      h.dockerStop.mock.invocationCallOrder[0],
    );
  });

  it("routes channel-stop reporter lines through the action's log and warn (#6026)", () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation((_name, channelDeps) => {
      channelDeps?.info?.("gateway stopped inside sandbox.");
      channelDeps?.warn?.("could not reach gateway.");
    });

    stopSandbox("my-sandbox", h.deps);

    expect(h.log).toHaveBeenCalledWith("  gateway stopped inside sandbox.");
    expect(h.warn).toHaveBeenCalledWith("  could not reach gateway.");
  });

  it("preserves the registry entry and tells the user how to start again (#6026)", () => {
    const h = harness();

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("Workspace state is preserved");
    expect(output).toContain("nemoclaw my-sandbox start");
  });

  it("succeeds idempotently when the container is already stopped (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([container("openshell-my-sandbox", false)]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).not.toHaveBeenCalled();
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("already stopped");
  });

  it("stops a crash-looping container instead of calling it stopped (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      { name: "openshell-my-sandbox", status: "Restarting (137) 2 seconds ago", running: false },
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
  });

  it("stops a paused container (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      { name: "openshell-my-sandbox", status: "Up 5 minutes (Paused)", running: true },
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(1);
  });

  it("stops every running labeled container, including backup siblings (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      container("openshell-my-sandbox", true),
      container("openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000", true),
    ]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(2);
  });

  it("continues to docker stop when the graceful channel stop throws (#6026)", () => {
    const h = harness();
    h.stopSandboxChannels.mockImplementation(() => {
      throw new Error("gateway unreachable");
    });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerStop).toHaveBeenCalledTimes(1);
    const warned = h.warn.mock.calls.map(([line]) => line).join("\n");
    expect(warned).toContain("gateway unreachable");
  });

  it("names the Docker daemon outage instead of claiming the container was removed (#6026)", () => {
    const h = harness();
    h.isDockerRuntimeDown.mockReturnValue(true);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toBeUndefined();
    expect(h.printDockerRuntimeDownGuidance).toHaveBeenCalledWith("my-sandbox", {
      retryCommand: "stop",
    });
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it("fails with a rebuild hint when no labeled container exists (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([]);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("No Docker container");
    expect(result.message).toContain("rebuild");
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it("refuses an unregistered sandbox (#6026)", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    const result = stopSandbox("ghost", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not registered");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
  });

  it("refuses non-direct drivers instead of guessing at container control (#6026)", () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: "kubernetes" }));

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("kubernetes");
    expect(h.dockerStop).not.toHaveBeenCalled();
  });

  it.each([
    ["null driver", sandbox({ openshellDriver: null })],
    ["docker driver", sandbox({ openshellDriver: "docker" })],
    ["vm driver", sandbox({ openshellDriver: "vm" })],
  ])("allows the %s like privileged exec does (#6026)", (_label, entry) => {
    const h = harness();
    h.getSandbox.mockReturnValue(entry);

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
  });

  it("surfaces a docker stop failure with the container name (#6026)", () => {
    const h = harness();
    h.dockerStop.mockReturnValue({ status: 125 });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("125");
  });

  it("attempts every container and aggregates failures when one stop fails (#6026)", () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      container("openshell-my-sandbox", true),
      container("openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000", true),
    ]);
    // First container fails to stop; the sibling still must be attempted.
    h.dockerStop.mockReturnValueOnce({ status: 137 }).mockReturnValueOnce({ status: 0 });

    const result = stopSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(h.dockerStop).toHaveBeenCalledTimes(2);
    expect(h.dockerStop).toHaveBeenNthCalledWith(
      2,
      "openshell-my-sandbox-nemoclaw-gpu-backup-1700000000000",
      {
        ignoreError: true,
        timeout: 30_000,
      },
    );
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("137");
    expect(result.message).not.toContain("gpu-backup");
  });

  it("never removes containers or touches the registry entry (#6026)", () => {
    const h = harness();

    stopSandbox("my-sandbox", h.deps);

    // The deps surface has no removal lever at all; assert the only docker
    // mutation issued is the stop of the labeled container.
    expect(h.dockerStop.mock.calls).toEqual([
      ["openshell-my-sandbox", { ignoreError: true, timeout: 30_000 }],
    ]);
  });
});
