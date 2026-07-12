// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  cleanupNativeGpuAttemptForFallback,
  type NativeGpuFallbackCleanupResult,
} from "./sandbox-gpu-create-attempt";
import {
  CLEANUP_POLL_INTERVAL_MS,
  MAX_CLEANUP_ATTEMPTS,
  STABLE_ABSENCE_CHECKS,
} from "./sandbox-gpu-fallback-constants";

const SAFE_CLEANUP: NativeGpuFallbackCleanupResult = {
  safe: true,
  reason: null,
  deleteStatus: 0,
  sandboxPresent: false,
  containerIds: [],
};

type CleanupDeps = Parameters<typeof cleanupNativeGpuAttemptForFallback>[1];
type CleanupOptions = Parameters<typeof cleanupNativeGpuAttemptForFallback>[2];
type CommandResult = ReturnType<CleanupDeps["runOpenshell"]>;
type ContainerResult = ReturnType<NonNullable<CleanupDeps["queryContainers"]>>;

const ABSENT = { ok: true as const, ids: [] };

function sequence<T>(input: T | T[]) {
  const values = Array.isArray(input) ? [...input] : [input];
  const last = values.at(-1) as T;
  return () => values.shift() ?? last;
}

function scenario({
  list,
  containers = ABSENT,
  deletion = { status: 0 },
  options,
}: {
  list: CommandResult | CommandResult[];
  containers?: ContainerResult | ContainerResult[];
  deletion?: CommandResult;
  options?: CleanupOptions;
}) {
  const nextList = sequence(list);
  const nextContainers = sequence(containers);
  const runOpenshell = vi.fn((args: string[]) => (args[1] === "delete" ? deletion : nextList()));
  const queryContainers = vi.fn(nextContainers);
  const sleep = vi.fn();
  const result = cleanupNativeGpuAttemptForFallback(
    "alpha",
    { runOpenshell, queryContainers, sleep },
    options,
  );
  return { queryContainers, result, runOpenshell, sleep };
}

describe("cleanupNativeGpuAttemptForFallback", () => {
  it("uses the documented fail-closed cleanup limits by default", () => {
    const { result, runOpenshell, sleep } = scenario({
      list: { status: 0, stdout: "alpha Ready" },
    });

    expect(result.safe).toBe(false);
    expect(MAX_CLEANUP_ATTEMPTS).toBe(5);
    expect(STABLE_ABSENCE_CHECKS).toBe(2);
    expect(CLEANUP_POLL_INTERVAL_MS).toBe(1_000);
    expect(runOpenshell.mock.calls.filter(([args]) => args[1] === "list")).toHaveLength(
      MAX_CLEANUP_ATTEMPTS,
    );
    expect(sleep).toHaveBeenCalledTimes(MAX_CLEANUP_ATTEMPTS - 1);
    expect(sleep).toHaveBeenCalledWith(CLEANUP_POLL_INTERVAL_MS / 1_000);
  });

  it("requires two stable sandbox and labeled-container absence checks", () => {
    const { result, runOpenshell, queryContainers } = scenario({
      list: { status: 0, stdout: "" },
      options: { maxAttempts: 3, stableAbsenceChecks: 2 },
    });

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell.mock.calls.filter(([args]) => args[1] === "list")).toHaveLength(2);
    expect(queryContainers).toHaveBeenCalledTimes(2);
  });

  it("waits through propagated presence before proving two stable absence checks", () => {
    const { result, runOpenshell, queryContainers, sleep } = scenario({
      list: [
        { status: 0, stdout: "alpha Ready" },
        { status: 0, stdout: "alpha Ready" },
        { status: 0, stdout: "" },
        { status: 0, stdout: "" },
      ],
      containers: [{ ok: true, ids: ["container-a"] }, ABSENT, ABSENT, ABSENT],
      options: { maxAttempts: 5, stableAbsenceChecks: 2 },
    });

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenCalledTimes(5);
    expect(queryContainers).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("permits fallback after a nonzero delete only when two checks prove complete absence", () => {
    const { result } = scenario({
      list: { status: 0, stdout: "" },
      deletion: { status: 1, stderr: "delete denied" },
      options: { maxAttempts: 2, stableAbsenceChecks: 2 },
    });

    expect(result.safe).toBe(true);
    expect(result.deleteStatus).toBe(1);
    expect(result.reason).toBeNull();
  });

  it("permits fallback after a transient gateway list failure recovers to stable absence", () => {
    const { result, runOpenshell, queryContainers, sleep } = scenario({
      list: [
        { status: 1, stderr: "gateway unavailable" },
        { status: 0, stdout: "" },
        { status: 0, stdout: "" },
      ],
      options: { maxAttempts: 3, stableAbsenceChecks: 2 },
    });

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenCalledTimes(4);
    expect(queryContainers).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("exhausts the fixed poll bound when gateway absence cannot be proven", () => {
    const { result, runOpenshell, queryContainers, sleep } = scenario({
      list: { status: 1, stderr: "gateway unavailable" },
    });

    expect(result).toMatchObject({
      safe: false,
      sandboxPresent: null,
      containerIds: [],
      reason: "gateway unavailable",
    });
    expect(runOpenshell.mock.calls.filter(([args]) => args[1] === "list")).toHaveLength(
      MAX_CLEANUP_ATTEMPTS,
    );
    expect(queryContainers).toHaveBeenCalledTimes(MAX_CLEANUP_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(MAX_CLEANUP_ATTEMPTS - 1);
  });

  it.each([
    [
      "refuses fallback when the OpenShell sandbox query fails",
      { list: { status: 1, stderr: "gateway unavailable" } },
      { sandboxPresent: null },
      "gateway unavailable",
    ],
    [
      "refuses fallback when the labeled-container query fails",
      {
        list: { status: 0, stdout: "" },
        containers: { ok: false as const, ids: [] as [], error: "docker daemon unavailable" },
      },
      { containerIds: null },
      "docker daemon unavailable",
    ],
    [
      "refuses fallback while any labeled container remains",
      {
        list: { status: 0, stdout: "" },
        deletion: { status: 1, stderr: "sandbox was never created" },
        containers: { ok: true as const, ids: ["container-a", "container-b"] as string[] },
      },
      { deleteStatus: 1, containerIds: ["container-a", "container-b"] },
      "container-a, container-b",
    ],
    [
      "treats an exact sandbox row with no parseable status as present",
      { list: { status: 0, stdout: "alpha" } },
      { sandboxPresent: true },
      "still present",
    ],
  ] as const)("%s (fail-closed cleanup)", (_title, input, expected, reason) => {
    const { result } = scenario({ ...input, options: { maxAttempts: 2 } });

    expect(result).toMatchObject({ safe: false, ...expected });
    expect(result.reason).toContain(reason);
  });
});
