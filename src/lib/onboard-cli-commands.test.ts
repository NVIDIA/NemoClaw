// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { OnboardCliCommand } from "./onboard-cli-commands";
import { runOnboardAction } from "./global-cli-actions";

vi.mock("./global-cli-actions", () => ({
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
  runSetupAction: vi.fn().mockResolvedValue(undefined),
  runSetupSparkAction: vi.fn().mockResolvedValue(undefined),
}));

const rootDir = process.cwd();

describe("onboard oclif command", () => {
  it("rejects mutually exclusive resume and fresh flags before dispatch", async () => {
    await expect(OnboardCliCommand.run(["--resume", "--fresh"], rootDir)).rejects.toThrow(
      /resume|fresh/,
    );

    expect(runOnboardAction).not.toHaveBeenCalled();
  });
});
