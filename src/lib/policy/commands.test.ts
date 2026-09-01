// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildGlobalPolicyGetFullJsonArgs,
  buildGlobalPolicyListArgs,
  buildPolicyGetArgs,
  buildPolicyGetCommand,
  buildPolicyGetFullCommand,
  buildPolicyGetFullJsonArgs,
  buildPolicyGetRevisionArgs,
  buildPolicySetCommand,
} from "./commands";

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

  it("pins policy requirements reads to the selected gateway", () => {
    expect(buildPolicyGetArgs("alpha", "nemoclaw")).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--base",
      "alpha",
    ]);
    expect(buildPolicyGetRevisionArgs("alpha", "nemoclaw", 7)).toEqual([
      "policy",
      "get",
      "-g",
      "nemoclaw",
      "--rev",
      "7",
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
