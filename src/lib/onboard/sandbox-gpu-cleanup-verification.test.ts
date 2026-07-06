// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  cleanupNativeGpuAttemptForFallback,
  type NativeGpuFallbackCleanupResult,
} from "./sandbox-gpu-create-attempt";

const SAFE_CLEANUP: NativeGpuFallbackCleanupResult = {
  safe: true,
  reason: null,
  deleteStatus: 0,
  sandboxPresent: false,
  containerIds: [],
};

describe("cleanupNativeGpuAttemptForFallback", () => {
  function openshellWithList(
    listResult: { status: number; stdout?: string; stderr?: string },
    deleteResult: { status: number; stdout?: string; stderr?: string } = { status: 0 },
  ) {
    return vi.fn((args: string[]) => (args[1] === "delete" ? deleteResult : listResult));
  }

  it("requires two stable sandbox and labeled-container absence checks", () => {
    const runOpenshell = openshellWithList({ status: 0, stdout: "" });
    const queryContainers = vi.fn(() => ({ ok: true as const, ids: [] }));

    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      { runOpenshell, queryContainers, sleep: vi.fn() },
      { maxAttempts: 3, stableAbsenceChecks: 2 },
    );

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
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: "alpha Ready" })
      .mockReturnValueOnce({ status: 0, stdout: "alpha Ready" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    const queryContainers = vi
      .fn()
      .mockReturnValueOnce({ ok: true as const, ids: ["container-a"] })
      .mockReturnValueOnce({ ok: true as const, ids: [] })
      .mockReturnValueOnce({ ok: true as const, ids: [] })
      .mockReturnValueOnce({ ok: true as const, ids: [] });
    const sleep = vi.fn();

    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      { runOpenshell, queryContainers, sleep },
      { maxAttempts: 5, stableAbsenceChecks: 2 },
    );

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenCalledTimes(5);
    expect(queryContainers).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("permits fallback after a nonzero delete only when two checks prove complete absence", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList(
          { status: 0, stdout: "" },
          { status: 1, stderr: "delete denied" },
        ),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2, stableAbsenceChecks: 2 },
    );

    expect(result.safe).toBe(true);
    expect(result.deleteStatus).toBe(1);
    expect(result.reason).toBeNull();
  });

  it("permits fallback after a transient gateway list failure recovers to stable absence", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1, stderr: "gateway unavailable" })
      .mockReturnValueOnce({ status: 0, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    const queryContainers = vi.fn(() => ({ ok: true as const, ids: [] }));
    const sleep = vi.fn();

    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      { runOpenshell, queryContainers, sleep },
      { maxAttempts: 3, stableAbsenceChecks: 2 },
    );

    expect(result).toEqual(SAFE_CLEANUP);
    expect(runOpenshell).toHaveBeenCalledTimes(4);
    expect(queryContainers).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("refuses fallback when the OpenShell sandbox query fails", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 1, stderr: "gateway unavailable" }),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.sandboxPresent).toBeNull();
    expect(result.reason).toContain("gateway unavailable");
  });

  it("refuses fallback when the labeled-container query fails", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 0, stdout: "" }),
        queryContainers: () => ({ ok: false, ids: [], error: "docker daemon unavailable" }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.containerIds).toBeNull();
    expect(result.reason).toContain("docker daemon unavailable");
  });

  it("refuses fallback while any labeled container remains", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList(
          { status: 0, stdout: "" },
          { status: 1, stderr: "sandbox was never created" },
        ),
        queryContainers: () => ({ ok: true, ids: ["container-a", "container-b"] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.deleteStatus).toBe(1);
    expect(result.containerIds).toEqual(["container-a", "container-b"]);
    expect(result.reason).toContain("container-a, container-b");
  });

  it("treats an exact sandbox row with no parseable status as present", () => {
    const result = cleanupNativeGpuAttemptForFallback(
      "alpha",
      {
        runOpenshell: openshellWithList({ status: 0, stdout: "alpha" }),
        queryContainers: () => ({ ok: true, ids: [] }),
      },
      { maxAttempts: 2 },
    );

    expect(result.safe).toBe(false);
    expect(result.sandboxPresent).toBe(true);
    expect(result.reason).toContain("still present");
  });
});
