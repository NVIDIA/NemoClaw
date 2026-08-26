// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

const {
  buildGlobalPolicyGetFullJsonArgs,
  buildGlobalPolicyListArgs,
  buildPolicyGetArgs,
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicyGetFullJsonArgs,
  buildPolicyGetFullJsonCommand,
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
    expect(buildPolicyGetFullJsonCommand("alpha").slice(1)).toEqual([
      "policy",
      "get",
      "--full",
      "--output",
      "json",
      "alpha",
    ]);
  });

  it("pins policy authority reads to the selected gateway", () => {
    expect(buildPolicyGetArgs("alpha", "nemoclaw")).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--base",
      "alpha",
    ]);
    expect(buildPolicyGetFullJsonArgs("alpha", "nemoclaw")).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--full",
      "--output",
      "json",
      "alpha",
    ]);
    expect(buildGlobalPolicyGetFullJsonArgs("nemoclaw")).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--global",
      "--full",
      "--output",
      "json",
    ]);
    expect(buildGlobalPolicyListArgs("nemoclaw")).toEqual([
      "policy",
      "list",
      "-g",
      "nemoclaw",
      "--global",
      "--limit",
      "1",
    ]);
  });
});
