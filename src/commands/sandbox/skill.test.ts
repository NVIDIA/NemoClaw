// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const installSandboxSkill = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const removeSandboxSkill = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../lib/actions/sandbox/skill-install", () => ({
  installSandboxSkill,
  removeSandboxSkill,
}));

import SkillCliCommand from "./skill";
import SkillInstallCliCommand from "./skill/install";
import SkillRemoveCliCommand from "./skill/remove";

const rootDir = process.cwd();

function clearSkillMocks(): void {
  installSandboxSkill.mockClear();
  removeSandboxSkill.mockClear();
}

describe("SkillCliCommand", () => {
  beforeEach(() => {
    clearSkillMocks();
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
      expect(removeSandboxSkill).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("SkillInstallCliCommand", () => {
  beforeEach(() => {
    clearSkillMocks();
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

describe("SkillRemoveCliCommand", () => {
  beforeEach(() => {
    clearSkillMocks();
  });

  it("runs skill remove with typed action options", async () => {
    await SkillRemoveCliCommand.run(["alpha", "my-skill"], rootDir);

    expect(removeSandboxSkill).toHaveBeenCalledWith("alpha", {
      command: "remove",
      name: "my-skill",
    });
  });

  it("allows help as a removable skill name", async () => {
    await SkillRemoveCliCommand.run(["alpha", "help"], rootDir);

    expect(removeSandboxSkill).toHaveBeenCalledWith("alpha", {
      command: "remove",
      name: "help",
    });
  });

  it("requires a skill name before dispatch", async () => {
    await expect(SkillRemoveCliCommand.run(["alpha"], rootDir)).rejects.toThrow(/skill/i);

    expect(removeSandboxSkill).not.toHaveBeenCalled();
  });
});
