// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  evaluateBrevProvisioningState,
  observeBrevProvisioningProgress,
  parseBrevJsonInventory,
  parseBrevProvisioningAttempts,
} from "../tools/e2e/brev-provisioning.mts";

describe("Brev provisioning state", () => {
  it.each([
    "FAILED",
    "ERROR",
    "OFF",
    "STOPPED",
    "DELETING",
    "TERMINATED",
  ])("stops waiting when the instance reaches %s", (status) => {
    expect(
      evaluateBrevProvisioningState([{ name: "pr-42", status }], "pr-42", 0, true),
    ).toMatchObject({ kind: "terminal", consecutiveMissing: 0 });
  });

  it("requires repeated authoritative absence before failing", () => {
    const first = evaluateBrevProvisioningState([], "pr-42", 0, true);
    const second = evaluateBrevProvisioningState([], "pr-42", first.consecutiveMissing, true);
    const third = evaluateBrevProvisioningState([], "pr-42", second.consecutiveMissing, true);

    expect(first).toEqual({ kind: "continue", consecutiveMissing: 1 });
    expect(second).toEqual({ kind: "continue", consecutiveMissing: 2 });
    expect(third).toMatchObject({ kind: "terminal", consecutiveMissing: 3 });
  });

  it("does not count failed list queries as instance absence", () => {
    expect(evaluateBrevProvisioningState([], "pr-42", 2, false)).toEqual({
      kind: "continue",
      consecutiveMissing: 2,
    });
  });

  it("resets missing observations when the instance reappears", () => {
    expect(
      evaluateBrevProvisioningState([{ name: "pr-42", status: "STARTING" }], "pr-42", 2, true),
    ).toEqual({ kind: "continue", consecutiveMissing: 0 });
  });

  it("inspects on the first and every third SSH failure", () => {
    const inspect = vi.fn(() => ({
      instances: [{ name: "pr-42", status: "STARTING" }],
      authoritative: true,
    }));

    expect(
      observeBrevProvisioningProgress({
        attempt: 1,
        instanceName: "pr-42",
        consecutiveMissing: 2,
        lastSshError: "connection refused",
        cause: new Error("ssh failed"),
        inspect,
      }),
    ).toBe(0);
    expect(
      observeBrevProvisioningProgress({
        attempt: 2,
        instanceName: "pr-42",
        consecutiveMissing: 2,
        lastSshError: "connection refused",
        cause: new Error("ssh failed"),
        inspect,
      }),
    ).toBe(2);
    expect(
      observeBrevProvisioningProgress({
        attempt: 3,
        instanceName: "pr-42",
        consecutiveMissing: 2,
        lastSshError: "connection refused",
        cause: new Error("ssh failed"),
        inspect,
      }),
    ).toBe(0);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when a scheduled inspection finds a terminal state", () => {
    expect(() =>
      observeBrevProvisioningProgress({
        attempt: 3,
        instanceName: "pr-42",
        consecutiveMissing: 0,
        lastSshError: "connection refused",
        cause: new Error("ssh failed"),
        inspect: () => ({
          instances: [{ name: "pr-42", status: "FAILED" }],
          authoritative: true,
        }),
      }),
    ).toThrow(
      'Brev reports terminal status FAILED for instance "pr-42". Last SSH error: connection refused',
    );
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "invalid",
  ])("uses two provisioning attempts for invalid value %s", (value) => {
    expect(parseBrevProvisioningAttempts(value)).toBe(2);
  });

  it.each([
    ["1", 1],
    ["2", 2],
    ["5", 5],
  ])("accepts positive integer provisioning attempt value %s", (value, expected) => {
    expect(parseBrevProvisioningAttempts(value)).toBe(expected);
  });

  it("parses recognized Brev JSON inventory shapes", () => {
    expect(parseBrevJsonInventory([{ workspaceName: "pr-42", state: "starting" }])).toEqual([
      { name: "pr-42", status: "STARTING" },
    ]);
    expect(parseBrevJsonInventory({ workspaces: [] })).toEqual([]);
  });

  it("rejects unrecognized Brev JSON inventory shapes", () => {
    expect(() => parseBrevJsonInventory({})).toThrow(
      "Brev JSON inventory has an unrecognized shape",
    );
  });
});
