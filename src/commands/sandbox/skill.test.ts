// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const installSandboxSkill = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../lib/actions/sandbox/skill-install", () => ({
  installSandboxSkill,
}));

import SkillCliCommand from "./skill";
import SkillInstallCliCommand from "./skill/install";

const rootDir = process.cwd();

describe("SkillCliCommand", () => {
  beforeEach(() => {
    installSandboxSkill.mockClear();
  });

  it("records a parser-style failure when the sandbox name is missing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await expect(SkillCliCommand.run([], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(2);
      expect(error).toHaveBeenCalledWith("Missing required sandboxName for skill.");
      expect(installSandboxSkill).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("SkillInstallCliCommand", () => {
  beforeEach(() => {
    installSandboxSkill.mockClear();
  });

  it("runs skill install with typed action options", async () => {
    await SkillInstallCliCommand.run(["alpha", "/tmp/my-skill"], rootDir);

    expect(installSandboxSkill).toHaveBeenCalledWith("alpha", {
      command: "install",
      path: "/tmp/my-skill",
    });
  });

  it("requires an install path before dispatch", async () => {
    await expect(SkillInstallCliCommand.run(["alpha"], rootDir)).rejects.toThrow(/path/i);

    expect(installSandboxSkill).not.toHaveBeenCalled();
  });
});
