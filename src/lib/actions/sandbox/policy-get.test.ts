// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertOpenshellResolvable: vi.fn(),
  buildPolicyGetCommand: vi.fn((_name: string) => ["openshell", "policy", "get", "--full", _name]),
  parseCurrentPolicy: vi.fn((_raw: string) => ""),
  runCapture: vi.fn(() => ""),
}));

vi.mock("../../policy/index", () => ({
  assertOpenshellResolvable: mocks.assertOpenshellResolvable,
  buildPolicyGetCommand: mocks.buildPolicyGetCommand,
  parseCurrentPolicy: mocks.parseCurrentPolicy,
}));
vi.mock("../../runner", () => ({ runCapture: mocks.runCapture }));

import { getSandboxPolicy } from "./policy-get";

describe("getSandboxPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns raw and parsed YAML", () => {
    const rawOutput =
      "Version: 1\nHash: abc\nStatus: active\n---\nversion: 1\nnetwork_policies: []";
    mocks.runCapture.mockReturnValue(rawOutput);
    mocks.parseCurrentPolicy.mockReturnValue("version: 1\nnetwork_policies: []");

    const result = getSandboxPolicy("alpha");

    expect(mocks.assertOpenshellResolvable).toHaveBeenCalled();
    expect(mocks.buildPolicyGetCommand).toHaveBeenCalledWith("alpha");
    expect(mocks.runCapture).toHaveBeenCalledWith([
      "openshell",
      "policy",
      "get",
      "--full",
      "alpha",
    ]);
    expect(result.raw).toBe(rawOutput);
    expect(result.yaml).toBe("version: 1\nnetwork_policies: []");
  });

  it("returns empty yaml when runCapture returns empty", () => {
    mocks.runCapture.mockReturnValue("");

    const result = getSandboxPolicy("alpha");

    expect(result.raw).toBe("");
    expect(result.yaml).toBe("");
    expect(mocks.parseCurrentPolicy).not.toHaveBeenCalled();
  });

  it("returns empty yaml when parseCurrentPolicy fails", () => {
    mocks.runCapture.mockReturnValue("some garbage");
    mocks.parseCurrentPolicy.mockReturnValue("");

    const result = getSandboxPolicy("alpha");

    expect(result.raw).toBe("some garbage");
    expect(result.yaml).toBe("");
  });
});
