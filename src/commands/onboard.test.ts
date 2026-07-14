// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runOnboardAction } from "../lib/actions/global";
import OnboardCliCommand from "./onboard";

vi.mock("../lib/actions/global", () => ({
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
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

  it("accepts --yes and forwards typed flags to the onboard action", async () => {
    await OnboardCliCommand.run(
      ["--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        yes: true,
        "yes-i-accept-third-party-software": true,
      }),
    );
  });

  it("accepts -y as the short form for --yes", async () => {
    await OnboardCliCommand.run(["--non-interactive", "-y"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({ "non-interactive": true, yes: true }),
    );
  });

  it("forwards typed sandbox GPU flags", async () => {
    await OnboardCliCommand.run(
      ["--non-interactive", "--yes", "--sandbox-gpu", "--sandbox-gpu-device", "nvidia.com/gpu=0"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        "sandbox-gpu": true,
        "sandbox-gpu-device": "nvidia.com/gpu=0",
        yes: true,
      }),
    );
  });

  it("forwards --no-gpu to the onboard action", async () => {
    await OnboardCliCommand.run(["--non-interactive", "--no-gpu"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({ "non-interactive": true, "no-gpu": true }),
    );
  });

  it.each([
    ["--gpu", "--no-gpu"],
    ["--sandbox-gpu", "--no-sandbox-gpu"],
    ["--gpu", "--no-sandbox-gpu"],
    ["--no-gpu", "--sandbox-gpu"],
  ])("rejects incompatible GPU flags %s and %s before dispatch", async (left, right) => {
    await expect(OnboardCliCommand.run([left, right], rootDir)).rejects.toThrow(/gpu/i);

    expect(runOnboardAction).not.toHaveBeenCalled();
  });

  it("rejects a sandbox GPU device without explicit sandbox GPU mode", async () => {
    await expect(
      OnboardCliCommand.run(["--sandbox-gpu-device", "nvidia.com/gpu=0"], rootDir),
    ).rejects.toThrow(/sandbox-gpu/);

    expect(runOnboardAction).not.toHaveBeenCalled();
  });
});
