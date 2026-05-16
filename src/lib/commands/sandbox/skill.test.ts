// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import SkillCliCommand from "./skill";
import { setSkillInstallRuntimeBridgeFactoryForTest } from "./skill/common";
import SkillInstallCliCommand from "./skill/install";

const rootDir = process.cwd();

describe("SkillCliCommand", () => {
  it("records a parser-style failure when the sandbox name is missing", async () => {
    const sandboxSkillInstall = vi.fn().mockResolvedValue(undefined);
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(SkillCliCommand.run([], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenCalledWith("Missing required sandboxName for skill.");
      expect(sandboxSkillInstall).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("SkillInstallCliCommand", () => {
  it("runs skill install with the legacy install argv shape", async () => {
    const sandboxSkillInstall = vi.fn().mockResolvedValue(undefined);
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));

    await SkillInstallCliCommand.run(["alpha", "/tmp/my-skill"], rootDir);

    expect(sandboxSkillInstall).toHaveBeenCalledWith("alpha", ["install", "/tmp/my-skill"]);
  });

  it("requires an install path before dispatch", async () => {
    const sandboxSkillInstall = vi.fn().mockResolvedValue(undefined);
    setSkillInstallRuntimeBridgeFactoryForTest(() => ({ sandboxSkillInstall }));

    await expect(SkillInstallCliCommand.run(["alpha"], rootDir)).rejects.toThrow(/path/i);

    expect(sandboxSkillInstall).not.toHaveBeenCalled();
  });
});
