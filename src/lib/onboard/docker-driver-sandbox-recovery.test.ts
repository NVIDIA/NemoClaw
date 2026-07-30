// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  findLabeledSandboxContainers,
  recoverDockerDriverSandbox,
} from "./docker-driver-sandbox-recovery";

interface FakeRunResult {
  status: number;
}

function fakeStart(status = 0): (name: string, opts?: Record<string, unknown>) => FakeRunResult {
  return () => ({ status });
}

function fakeRename(
  status = 0,
): (oldName: string, newName: string, opts?: Record<string, unknown>) => FakeRunResult {
  return () => ({ status });
}

function fakeCapture(
  output: string,
  inspectOutputs: string[] = ["running\thealthy"],
  onInspect: (opts?: Record<string, unknown>) => void = () => undefined,
): (args: readonly string[], opts?: Record<string, unknown>) => string {
  let inspectIndex = 0;
  return (args, opts) => {
    switch (args[0]) {
      case "inspect": {
        onInspect(opts);
        const index = Math.min(inspectIndex, inspectOutputs.length - 1);
        inspectIndex += 1;
        return inspectOutputs[index] ?? "";
      }
      default:
        return output;
    }
  };
}

describe("findLabeledSandboxContainers", () => {
  it("parses the OpenShell-labeled container list and detects running state", () => {
    const containers = findLabeledSandboxContainers("e2e-x", {
      dockerCapture: fakeCapture(
        "openshell-e2e-x\tUp 2 hours\n" +
          "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited (0) 10 minutes ago\n",
      ),
    });
    expect(containers).toEqual([
      { name: "openshell-e2e-x", status: "Up 2 hours", running: true },
      {
        name: "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000",
        status: "Exited (0) 10 minutes ago",
        running: false,
      },
    ]);
  });

  it("returns an empty array when docker ps has no labeled rows", () => {
    expect(findLabeledSandboxContainers("e2e-x", { dockerCapture: fakeCapture("") })).toEqual([]);
  });

  it("ignores blank lines and trims whitespace", () => {
    const containers = findLabeledSandboxContainers("e2e-x", {
      dockerCapture: fakeCapture("\n  openshell-e2e-x\tCreated\n\n"),
    });
    expect(containers).toEqual([{ name: "openshell-e2e-x", status: "Created", running: false }]);
  });
});

describe("recoverDockerDriverSandbox — running original (no-op)", () => {
  it("waits for an already-running container to become healthy without starting it", () => {
    const start = vi.fn(fakeStart(0));
    const sleep = vi.fn();
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tUp 5 seconds\n", [
        "running\tstarting",
        "running\thealthy",
      ]),
      dockerStart: start,
      sleep,
    });
    expect(result).toEqual({
      recovered: true,
      via: "started-running-original",
      containerName: "openshell-e2e-x",
    });
    expect(start).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
  });
});

describe("recoverDockerDriverSandbox — paused original (unpause)", () => {
  it("unpauses a paused container and reports via=unpaused-original (not started-running-original)", () => {
    const start = vi.fn(fakeStart(0));
    const unpause = vi.fn(fakeStart(0));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tUp 3 hours (Paused)\n"),
      dockerStart: start,
      dockerUnpause: unpause,
    });
    expect(result).toEqual({
      recovered: true,
      via: "unpaused-original",
      containerName: "openshell-e2e-x",
    });
    expect(unpause).toHaveBeenCalledTimes(1);
    expect(unpause).toHaveBeenCalledWith(
      "openshell-e2e-x",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("reports recovered=false with a detail when docker unpause fails", () => {
    const unpause = vi.fn(fakeStart(1));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tUp 3 hours (Paused)\n"),
      dockerStart: vi.fn(fakeStart(0)),
      dockerUnpause: unpause,
    });
    expect(result.recovered).toBe(false);
    expect(result.via).toBeNull();
    expect(result.detail).toContain("docker unpause");
    expect(unpause).toHaveBeenCalledTimes(1);
  });

  it("does not report recovery when an unpaused container reaches a terminal state", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tUp 3 hours (Paused)\n", ["dead\tunhealthy"]),
      dockerUnpause: fakeStart(0),
      sleep: vi.fn(),
    });

    expect(result).toMatchObject({
      recovered: false,
      via: null,
      containerName: "openshell-e2e-x",
      detail: expect.stringContaining("runtime=dead, health=unhealthy"),
    });
  });
});

describe("recoverDockerDriverSandbox — stopped original (start)", () => {
  it("starts the labeled container and reports started-stopped-original", () => {
    const start = vi.fn(fakeStart(0));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (137) 30 seconds ago\n"),
      dockerStart: start,
    });
    expect(result).toEqual({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-e2e-x",
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      "openshell-e2e-x",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("surfaces docker start failure as recovered=false with detail", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (1) 1 minute ago\n"),
      dockerStart: fakeStart(125),
    });
    expect(result.recovered).toBe(false);
    expect(result.via).toBeNull();
    expect(result.detail).toMatch(/docker start openshell-e2e-x failed.*125/);
  });

  it("waits for Docker health to become ready before reporting recovery", () => {
    const sleep = vi.fn();
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (137) 30 seconds ago\n", [
        "running\tstarting",
        "running\tstarting",
        "running\thealthy",
      ]),
      dockerStart: fakeStart(0),
      sleep,
    });

    expect(result).toEqual({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-e2e-x",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("accepts a running container whose image has no Docker health check", () => {
    const sleep = vi.fn();
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (137) 30 seconds ago\n", [
        "running\tnone",
      ]),
      dockerStart: fakeStart(0),
      sleep,
    });

    expect(result).toEqual({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-e2e-x",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    "dead",
    "exited",
    "removing",
  ])("does not report recovery when the restarted container reaches terminal state %s", (runtimeState) => {
    const sleep = vi.fn();
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (137) 30 seconds ago\n", [
        `${runtimeState}\tnone`,
      ]),
      dockerStart: fakeStart(0),
      sleep,
    });

    expect(result).toEqual({
      recovered: false,
      via: null,
      containerName: "openshell-e2e-x",
      detail:
        "docker container openshell-e2e-x did not become ready after recovery " +
        `(runtime=${runtimeState}, health=none)`,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("enforces the readiness deadline with an advancing clock", () => {
    let currentMs = 0;
    const inspectStartTimes: number[] = [];
    const inspectTimeouts: number[] = [];
    const capture = fakeCapture(
      "openshell-e2e-x\tExited (137) 30 seconds ago\n",
      ["running\tstarting"],
      (opts) => {
        inspectStartTimes.push(currentMs);
        const timeout = Number(opts?.timeout);
        inspectTimeouts.push(timeout);
        currentMs += Math.min(4_900, timeout);
      },
    );
    const sleep = vi.fn((ms: number) => {
      currentMs += ms;
    });
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: capture,
      dockerStart: fakeStart(0),
      now: () => currentMs,
      sleep,
    });

    expect(result.recovered).toBe(false);
    expect(result.via).toBeNull();
    expect(result.detail).toContain("runtime=running, health=starting");
    expect(currentMs).toBe(90_000);
    expect(inspectStartTimes.every((startedAt) => startedAt < 90_000)).toBe(true);
    expect(inspectTimeouts.at(-1)).toBe(1_500);
  });

  it("fails closed when Docker inspect returns malformed readiness output", () => {
    let currentMs = 0;
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tExited (137) 30 seconds ago\n", [
        "not-a-docker-state",
      ]),
      dockerStart: fakeStart(0),
      now: () => currentMs,
      sleep: (ms) => {
        currentMs += ms;
      },
    });

    expect(result).toMatchObject({
      recovered: false,
      via: null,
      detail: expect.stringContaining("runtime=not-a-docker-state"),
    });
    expect(currentMs).toBe(90_000);
  });
});

describe("recoverDockerDriverSandbox — backup-only (rename + start)", () => {
  it("renames the backup sibling back to the original name and starts it", () => {
    const rename = vi.fn(fakeRename(0));
    const start = vi.fn(fakeStart(0));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture(
        "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited (0) 5 minutes ago\n",
      ),
      dockerRename: rename,
      dockerStart: start,
    });
    expect(result).toEqual({
      recovered: true,
      via: "renamed-and-started-backup",
      containerName: "openshell-e2e-x",
    });
    expect(rename).toHaveBeenCalledWith(
      "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000",
      "openshell-e2e-x",
      expect.objectContaining({ ignoreError: true }),
    );
    expect(start).toHaveBeenCalledWith(
      "openshell-e2e-x",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("picks the most recent backup when several siblings exist", () => {
    const rename = vi.fn(fakeRename(0));
    const start = vi.fn(fakeStart(0));
    recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture(
        "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited\n" +
          "openshell-e2e-x-nemoclaw-gpu-backup-1717290000000\tExited\n",
      ),
      dockerRename: rename,
      dockerStart: start,
    });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith(
      "openshell-e2e-x-nemoclaw-gpu-backup-1717290000000",
      "openshell-e2e-x",
      expect.anything(),
    );
  });

  it("surfaces docker rename failure as recovered=false", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited\n"),
      dockerRename: fakeRename(125),
    });
    expect(result.recovered).toBe(false);
    expect(result.detail).toMatch(/docker rename .* failed.*125/);
  });

  it("surfaces docker start failure after successful rename", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited\n"),
      dockerRename: fakeRename(0),
      dockerStart: fakeStart(1),
    });
    expect(result.recovered).toBe(false);
    expect(result.detail).toMatch(/after backup rename failed.*1/);
  });

  it("does not report a renamed backup recovered before Docker readiness", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited\n", [
        "running\tstarting",
        "removing\tnone",
      ]),
      dockerRename: fakeRename(0),
      dockerStart: fakeStart(0),
      sleep: vi.fn(),
    });

    expect(result).toMatchObject({
      recovered: false,
      via: null,
      containerName: "openshell-e2e-x",
      detail: expect.stringContaining("runtime=removing, health=none"),
    });
  });
});

describe("recoverDockerDriverSandbox — collision and missing cases", () => {
  it("prefers the labeled original over a backup sibling when both exist", () => {
    const start = vi.fn(fakeStart(0));
    const rename = vi.fn(fakeRename(0));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture(
        "openshell-e2e-x\tExited (137) 2 minutes ago\n" +
          "openshell-e2e-x-nemoclaw-gpu-backup-1717280000000\tExited\n",
      ),
      dockerStart: start,
      dockerRename: rename,
    });
    expect(result.via).toBe("started-stopped-original");
    expect(rename).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith("openshell-e2e-x", expect.anything());
  });

  it("returns recovered=false when no labeled container exists at all", () => {
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture(""),
    });
    expect(result.recovered).toBe(false);
    expect(result.via).toBeNull();
    expect(result.detail).toMatch(/no Docker container labeled/);
  });
});
