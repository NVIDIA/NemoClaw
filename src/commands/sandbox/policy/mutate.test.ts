// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSandboxPolicy: vi.fn().mockResolvedValue(undefined),
  removeSandboxPolicy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/actions/sandbox/policy-channel", () => mocks);

import PolicyAddCommand from "./add";
import PolicyRemoveCommand from "./remove";

const rootDir = process.cwd();

describe("policy mutation oclif commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps policy-add flags to typed action options", async () => {
    await PolicyAddCommand.run(
      ["alpha", "github", "--yes", "--dry-run", "--from-file", "/tmp/preset.yaml"],
      rootDir,
    );

    expect(mocks.addSandboxPolicy).toHaveBeenCalledWith("alpha", {
      preset: "github",
      yes: true,
      force: false,
      dryRun: true,
      fromFile: "/tmp/preset.yaml",
      fromDir: undefined,
    });
  });

  it("maps policy-remove flags to typed action options", async () => {
    await PolicyRemoveCommand.run(["alpha", "github", "-y", "--dry-run"], rootDir);

    expect(mocks.removeSandboxPolicy).toHaveBeenCalledWith("alpha", {
      preset: "github",
      yes: true,
      force: false,
      dryRun: true,
    });
  });

  it("rejects missing custom policy paths before dispatch", async () => {
    await expect(PolicyAddCommand.run(["alpha", "--from-file"], rootDir)).rejects.toThrow(
      /from-file/,
    );

    expect(mocks.addSandboxPolicy).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive custom policy sources before dispatch", async () => {
    await expect(
      PolicyAddCommand.run(["alpha", "--from-file", "preset.yaml", "--from-dir", "presets"], rootDir),
    ).rejects.toThrow(/from-file|from-dir/);

    expect(mocks.addSandboxPolicy).not.toHaveBeenCalled();
  });
});
