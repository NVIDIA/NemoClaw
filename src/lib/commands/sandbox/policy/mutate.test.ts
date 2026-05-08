// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import PolicyAddCommand from "./add";
import { setPolicyRuntimeBridgeFactoryForTest } from "./common";
import PolicyRemoveCommand from "./remove";

const rootDir = process.cwd();

describe("policy mutation oclif commands", () => {
  it("maps policy-add flags to the legacy argv shape", async () => {
    const runtime = {
      sandboxPolicyAdd: vi.fn().mockResolvedValue(undefined),
      sandboxPolicyRemove: vi.fn().mockResolvedValue(undefined),
    };
    setPolicyRuntimeBridgeFactoryForTest(() => runtime);

    await PolicyAddCommand.run(
      ["alpha", "github", "--yes", "--dry-run", "--from-file", "/tmp/preset.yaml"],
      rootDir,
    );

    expect(runtime.sandboxPolicyAdd).toHaveBeenCalledWith("alpha", [
      "github",
      "--yes",
      "--dry-run",
      "--from-file",
      "/tmp/preset.yaml",
    ]);
  });

  it("maps policy-remove flags to the legacy argv shape", async () => {
    const runtime = {
      sandboxPolicyAdd: vi.fn().mockResolvedValue(undefined),
      sandboxPolicyRemove: vi.fn().mockResolvedValue(undefined),
    };
    setPolicyRuntimeBridgeFactoryForTest(() => runtime);

    await PolicyRemoveCommand.run(["alpha", "github", "-y", "--dry-run"], rootDir);

    expect(runtime.sandboxPolicyRemove).toHaveBeenCalledWith("alpha", [
      "github",
      "--yes",
      "--dry-run",
    ]);
  });

  it("rejects missing custom policy paths before dispatch", async () => {
    const runtime = {
      sandboxPolicyAdd: vi.fn().mockResolvedValue(undefined),
      sandboxPolicyRemove: vi.fn().mockResolvedValue(undefined),
    };
    setPolicyRuntimeBridgeFactoryForTest(() => runtime);

    await expect(PolicyAddCommand.run(["alpha", "--from-file"], rootDir)).rejects.toThrow(
      /from-file/,
    );

    expect(runtime.sandboxPolicyAdd).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive custom policy sources before dispatch", async () => {
    const runtime = {
      sandboxPolicyAdd: vi.fn().mockResolvedValue(undefined),
      sandboxPolicyRemove: vi.fn().mockResolvedValue(undefined),
    };
    setPolicyRuntimeBridgeFactoryForTest(() => runtime);

    await expect(
      PolicyAddCommand.run(["alpha", "--from-file", "preset.yaml", "--from-dir", "presets"], rootDir),
    ).rejects.toThrow(/from-file|from-dir/);

    expect(runtime.sandboxPolicyAdd).not.toHaveBeenCalled();
  });
});
