// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { refuseApfMutableNameFallbackCleanup } from "./sandbox-gpu-create-flow";
import { assertPolicylessSandboxCreateArgv } from "./sandbox-gpu-create-run-attempt";

describe("APF policyless sandbox create attempts", () => {
  it("accepts create arguments without a caller policy (#9833)", () => {
    expect(() =>
      assertPolicylessSandboxCreateArgv([
        "openshell",
        "sandbox",
        "create",
        "--from",
        "image",
        "--name",
        "alpha",
      ]),
    ).not.toThrow();
  });

  it.each([
    ["separate flag", ["openshell", "sandbox", "create", "--policy", "/tmp/policy.yaml"]],
    ["joined flag", ["openshell", "sandbox", "create", "--policy=/tmp/policy.yaml"]],
  ])("refuses a caller policy passed with the %s form (#9833)", (_label, argv) => {
    expect(() => assertPolicylessSandboxCreateArgv(argv)).toThrow(
      /must not supply a caller policy/u,
    );
  });

  it("does not interpret workload arguments after -- as create options (#9833)", () => {
    expect(() =>
      assertPolicylessSandboxCreateArgv([
        "openshell",
        "sandbox",
        "create",
        "--from",
        "image",
        "--",
        "agent",
        "--policy",
        "workload-value",
      ]),
    ).not.toThrow();
  });

  it("refuses compatibility fallback cleanup that can address only a mutable name (#9833)", () => {
    expect(refuseApfMutableNameFallbackCleanup("alpha")).toEqual({
      safe: false,
      reason:
        "APF-selected sandbox 'alpha' cannot be deleted by mutable name for a compatibility retry",
      deleteStatus: null,
      sandboxPresent: null,
      containerIds: null,
    });
  });
});
