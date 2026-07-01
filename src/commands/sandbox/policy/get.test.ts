// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertOpenshellResolvable: vi.fn(),
  buildPolicyGetCommand: vi.fn((_name: string) => ["openshell", "policy", "get", "--full", _name]),
  parseCurrentPolicy: vi.fn((_raw: string) => "version: 1\nnetwork_policies: []"),
  runCapture: vi.fn(() => ""),
}));

vi.mock("../../../lib/policy/index", () => ({
  assertOpenshellResolvable: mocks.assertOpenshellResolvable,
  buildPolicyGetCommand: mocks.buildPolicyGetCommand,
  parseCurrentPolicy: mocks.parseCurrentPolicy,
}));
vi.mock("../../../lib/runner", () => ({ runCapture: mocks.runCapture }));

import SandboxPolicyGetCommand from "./get";

const rootDir = process.cwd();

describe("sandbox:policy:get command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes openshell and parses policy by default", async () => {
    const rawOutput =
      "Version: 1\nHash: abc\nStatus: active\n---\nversion: 1\nnetwork_policies: []";
    mocks.runCapture.mockReturnValue(rawOutput);
    mocks.parseCurrentPolicy.mockReturnValue("version: 1\nnetwork_policies: []");

    await SandboxPolicyGetCommand.run(["alpha"], rootDir);

    expect(mocks.assertOpenshellResolvable).toHaveBeenCalled();
    expect(mocks.buildPolicyGetCommand).toHaveBeenCalledWith("alpha");
    expect(mocks.runCapture).toHaveBeenCalledWith([
      "openshell",
      "policy",
      "get",
      "--full",
      "alpha",
    ]);
    expect(mocks.parseCurrentPolicy).toHaveBeenCalledWith(rawOutput);
  });

  it("skips parsing with --raw flag", async () => {
    const rawOutput =
      "Version: 1\nHash: abc\nStatus: active\n---\nversion: 1\nnetwork_policies: []";
    mocks.runCapture.mockReturnValue(rawOutput);

    await SandboxPolicyGetCommand.run(["alpha", "--raw"], rootDir);

    expect(mocks.runCapture).toHaveBeenCalled();
    expect(mocks.parseCurrentPolicy).not.toHaveBeenCalled();
  });

  it("exits with error when policy cannot be retrieved", async () => {
    mocks.runCapture.mockReturnValue("");

    await expect(SandboxPolicyGetCommand.run(["alpha"], rootDir)).rejects.toThrow(
      /Failed to retrieve policy/,
    );
  });

  it("exits with error when policy YAML cannot be parsed", async () => {
    mocks.runCapture.mockReturnValue("some output");
    mocks.parseCurrentPolicy.mockReturnValue("");

    await expect(SandboxPolicyGetCommand.run(["alpha"], rootDir)).rejects.toThrow(
      /Failed to parse policy YAML/,
    );
  });
});
