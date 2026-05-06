// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runOnboardAction } from "../global-cli-actions";
import OnboardCliCommand from "./onboard";

vi.mock("../global-cli-actions", () => ({
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
  runSetupAction: vi.fn().mockResolvedValue(undefined),
  runSetupSparkAction: vi.fn().mockResolvedValue(undefined),
}));

const rootDir = process.cwd();

describe("onboard oclif command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects mutually exclusive resume and fresh flags before dispatch", async () => {
    await expect(OnboardCliCommand.run(["--resume", "--fresh"], rootDir)).rejects.toThrow(
      /resume|fresh/,
    );

    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("accepts --yes and forwards it to the legacy onboard action", async () => {
    await OnboardCliCommand.run(
      ["--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith([
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
    ]);
  });

  it("accepts -y as the short form for --yes", async () => {
    await OnboardCliCommand.run(["--non-interactive", "-y"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(["--non-interactive", "--yes"]);
  });

  it("forwards --no-gpu to the legacy onboard action", async () => {
    await OnboardCliCommand.run(["--non-interactive", "--no-gpu"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(["--non-interactive", "--no-gpu"]);
  });

  it("rejects mutually exclusive gpu and no-gpu flags before dispatch", async () => {
    await expect(OnboardCliCommand.run(["--gpu", "--no-gpu"], rootDir)).rejects.toThrow(
      /gpu|no-gpu/,
    );

    expect(runOnboardAction).not.toHaveBeenCalled();
  });
});
