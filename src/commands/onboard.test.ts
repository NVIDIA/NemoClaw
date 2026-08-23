// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOnboardActionRuntimeDeps: vi.fn(),
  onboardRuntimeDeps: { googlechatTunnelRuntime: {} },
}));

import { runOnboardAction } from "../lib/actions/global";
import OnboardCliCommand from "./onboard";

vi.mock("../lib/actions/global", () => ({
  runOnboardAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/cli/onboard-runtime-deps", () => ({
  createOnboardActionRuntimeDeps: mocks.createOnboardActionRuntimeDeps,
}));

const rootDir = process.cwd();

describe("onboard oclif command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOnboardActionRuntimeDeps.mockReturnValue(mocks.onboardRuntimeDeps);
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
      mocks.onboardRuntimeDeps,
    );
  });

  it("accepts -y as the short form for --yes", async () => {
    await OnboardCliCommand.run(["--non-interactive", "-y"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({ "non-interactive": true, yes: true }),
      mocks.onboardRuntimeDeps,
    );
  });

  it("accepts an exact managed runtime catalog without candidate activation", async () => {
    await OnboardCliCommand.run(
      ["--temp-managed-runtime-catalog", "managed-catalog.json"],
      rootDir,
    );

    const [flags, deps] = vi.mocked(runOnboardAction).mock.calls[0]!;
    expect(flags["temp-managed-runtime-catalog"]).toBe("managed-catalog.json");
    expect(flags["temp-managed-runtime"]).toBeUndefined();
    expect(deps).toBe(mocks.onboardRuntimeDeps);
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
      mocks.onboardRuntimeDeps,
    );
  });

  it("forwards the managed vLLM GPU device independently of sandbox GPU flags", async () => {
    await OnboardCliCommand.run(
      ["--non-interactive", "--vllm-gpu-device", "GPU-69adb14e-820e-bfb4-0993-171e73f68504"],
      rootDir,
    );

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        "non-interactive": true,
        "vllm-gpu-device": "GPU-69adb14e-820e-bfb4-0993-171e73f68504",
      }),
      mocks.onboardRuntimeDeps,
    );
  });

  it("forwards --no-gpu to the onboard action", async () => {
    await OnboardCliCommand.run(["--non-interactive", "--no-gpu"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({ "non-interactive": true, "no-gpu": true }),
      mocks.onboardRuntimeDeps,
    );
  });

  it("accepts the hidden portable experimental profile", async () => {
    await OnboardCliCommand.run(["--experimental-profile", "portable"], rootDir);

    expect(runOnboardAction).toHaveBeenCalledWith(
      expect.objectContaining({ "experimental-profile": "portable" }),
      mocks.onboardRuntimeDeps,
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
