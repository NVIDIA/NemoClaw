// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildPolicySetCommand } from "./commands";

describe("OpenShell policy command builders", () => {
  it("keeps sandbox policy writes in an argv-only command", () => {
    expect(buildPolicySetCommand("/tmp/policy.yaml", "alpha").slice(1)).toEqual([
      "policy",
      "set",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
  });

  it("pins sandbox policy writes to the selected gateway", () => {
    expect(buildPolicySetCommand("/tmp/policy.yaml", "alpha", "nemoclaw").slice(1)).toEqual([
      "policy",
      "set",
      "-g",
      "nemoclaw",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
  });
});
