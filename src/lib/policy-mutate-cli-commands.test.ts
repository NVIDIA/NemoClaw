// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  PolicyAddCommand,
  PolicyRemoveCommand,
  setPolicyRuntimeBridgeFactoryForTest,
} from "./policy-mutate-cli-commands";

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
});
