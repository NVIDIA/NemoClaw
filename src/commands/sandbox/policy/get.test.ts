// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandboxPolicy: vi.fn(async () => ({ raw: "", yaml: "" })),
}));

vi.mock("../../../lib/actions/sandbox/policy-get", () => ({
  getSandboxPolicy: mocks.getSandboxPolicy,
}));

import SandboxPolicyGetCommand from "./get";

const rootDir = process.cwd();

describe("sandbox:policy:get command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outputs parsed base-policy YAML by default", async () => {
    const credential = "opaque-live-policy-credential";
    mocks.getSandboxPolicy.mockResolvedValue({
      raw: "Version: 1\nHash: abc\nStatus: active\n---\nversion: 1\nSERVICE_API_KEY: '[STRIPPED_BY_MIGRATION]'",
      yaml: "version: 1\nSERVICE_API_KEY: '[STRIPPED_BY_MIGRATION]'",
    });

    const logSpy = vi.spyOn(SandboxPolicyGetCommand.prototype, "log");
    await SandboxPolicyGetCommand.run(["alpha"], rootDir);

    expect(mocks.getSandboxPolicy).toHaveBeenCalledWith("alpha");
    expect(logSpy).toHaveBeenCalledWith("version: 1\nSERVICE_API_KEY: '[STRIPPED_BY_MIGRATION]'");
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(credential));
  });

  it("outputs the credential-redacted response with --raw", async () => {
    const credential = "opaque-live-policy-credential";
    const rawOutput =
      "Version: 1\nHash: abc\nStatus: active\n---\nversion: 1\nSERVICE_API_KEY: '[STRIPPED_BY_MIGRATION]'";
    mocks.getSandboxPolicy.mockResolvedValue({
      raw: rawOutput,
      yaml: "version: 1\nSERVICE_API_KEY: '[STRIPPED_BY_MIGRATION]'",
    });

    const logSpy = vi.spyOn(SandboxPolicyGetCommand.prototype, "log");
    await SandboxPolicyGetCommand.run(["alpha", "--raw"], rootDir);

    expect(logSpy).toHaveBeenCalledWith(rawOutput);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(credential));
  });

  it("exits with error when the base policy is empty", async () => {
    mocks.getSandboxPolicy.mockResolvedValue({ raw: "", yaml: "" });

    await expect(SandboxPolicyGetCommand.run(["alpha"], rootDir)).rejects.toThrow(
      /Failed to retrieve base policy/,
    );
  });

  it("exits with error when base-policy YAML cannot be parsed", async () => {
    mocks.getSandboxPolicy.mockResolvedValue({ raw: "some output", yaml: "" });

    await expect(SandboxPolicyGetCommand.run(["alpha"], rootDir)).rejects.toThrow(
      /Failed to parse base policy YAML/,
    );
  });

  it("propagates OpenShell retrieval failures", async () => {
    mocks.getSandboxPolicy.mockRejectedValueOnce(
      new Error("Failed to retrieve base policy for sandbox 'alpha'."),
    );

    await expect(SandboxPolicyGetCommand.run(["alpha"], rootDir)).rejects.toThrow(
      /Failed to retrieve base policy for sandbox 'alpha'/,
    );
  });
});
