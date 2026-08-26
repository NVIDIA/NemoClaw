// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const {
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicySetCommand,
} = require("./commands.js") as typeof import("./commands.js");

describe("OpenShell policy command builders", () => {
  it("keeps every sandbox policy operation in an argv-only command", () => {
    expect(buildPolicySetCommand("/tmp/policy.yaml", "alpha").slice(1)).toEqual([
      "policy",
      "set",
      "--policy",
      "/tmp/policy.yaml",
      "--wait",
      "alpha",
    ]);
    expect(buildPolicyGetCommand("alpha").slice(1)).toEqual(["policy", "get", "--base", "alpha"]);
    expect(buildPolicyGetFullCommand("alpha").slice(1)).toEqual([
      "policy",
      "get",
      "--full",
      "alpha",
    ]);
  });

  it("pins policy operations to the selected gateway", () => {
    expect(buildPolicyGetCommand("alpha", "nemoclaw").slice(1)).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--base",
      "alpha",
    ]);
    expect(buildPolicyGetFullCommand("alpha", "nemoclaw").slice(1)).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--full",
      "alpha",
    ]);
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
