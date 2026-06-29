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

function fakeCapture(output: string): (args: readonly string[]) => string {
  return () => output;
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
  it("reports recovered with via=started-running-original", () => {
    const start = vi.fn(fakeStart(0));
    const result = recoverDockerDriverSandbox("e2e-x", {
      dockerCapture: fakeCapture("openshell-e2e-x\tUp 5 minutes\n"),
      dockerStart: start,
    });
    expect(result).toEqual({
      recovered: true,
      via: "started-running-original",
      containerName: "openshell-e2e-x",
    });
    expect(start).not.toHaveBeenCalled();
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
