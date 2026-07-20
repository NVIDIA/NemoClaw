// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evaluateBrevProvisioningState } from "../tools/e2e/brev-provisioning.mts";

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
});
