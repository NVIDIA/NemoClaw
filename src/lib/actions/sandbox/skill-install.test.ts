// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureSandboxSshConfig = vi.hoisted(() => vi.fn());
const getSessionAgent = vi.hoisted(() => vi.fn());
const ensureLiveSandboxOrExit = vi.hoisted(() => vi.fn());
const skillInstall = vi.hoisted(() => ({
  validateSkillName: vi.fn(),
  resolveSkillPaths: vi.fn(),
  checkExisting: vi.fn(),
  removeSkill: vi.fn(),
  verifyRemove: vi.fn(),
  parseFrontmatter: vi.fn(),
  collectFiles: vi.fn(),
  uploadDirectory: vi.fn(),
  postInstall: vi.fn(),
  verifyInstall: vi.fn(),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  captureSandboxSshConfig,
}));

vi.mock("../../agent/runtime", () => ({
  getSessionAgent,
}));

vi.mock("../../skill-install", () => skillInstall);

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit,
}));

import { installSandboxSkill, removeSandboxSkill } from "./skill-install";

const paths = {
  uploadDir: "/sandbox/.openclaw/skills/demo-skill",
  mirrorDir: "$HOME/.openclaw/skills/demo-skill",
  sessionFile: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
  isOpenClaw: true,
};

const agent = { name: "openclaw", configPaths: { dir: "/sandbox/.openclaw" } };

function makeSkillDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-action-skill-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  return dir;
}

function restoreExitCode(previousExitCode: typeof process.exitCode): void {
  process.exitCode = previousExitCode;
}

describe("sandbox skill action orchestration", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();

    captureSandboxSshConfig.mockReturnValue({ status: 0, output: "Host openshell-alpha\n" });
    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSessionAgent.mockReturnValue(agent);
    skillInstall.validateSkillName.mockReturnValue(true);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    skillInstall.checkExisting.mockReturnValue(true);
    skillInstall.removeSkill.mockReturnValue({
      success: true,
      removedUploadDir: true,
      removedMirrorDir: true,
      clearedSessions: true,
      messages: [],
    });
    skillInstall.verifyRemove.mockReturnValue(true);
    skillInstall.parseFrontmatter.mockReturnValue({ name: "demo-skill" });
    skillInstall.collectFiles.mockReturnValue({
      files: ["SKILL.md"],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.uploadDirectory.mockReturnValue({
      uploaded: 1,
      failed: [],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.postInstall.mockReturnValue({ success: true, messages: [] });
    skillInstall.verifyInstall.mockReturnValue(true);
  });

  afterEach(() => {
    restoreExitCode(previousExitCode);
    vi.restoreAllMocks();
  });

  it("fails skill remove when SSH config capture fails", async () => {
    captureSandboxSshConfig.mockReturnValue({ status: 1, output: "" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await expect(removeSandboxSkill("alpha", { name: "demo-skill" })).rejects.toThrow(
      "process.exit 1",
    );

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(captureSandboxSshConfig).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(error).toHaveBeenCalledWith("  Failed to obtain SSH configuration for the sandbox.");
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("treats unknown skill existence as fatal for remove and deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      expect(fs.existsSync(tempConfig)).toBe(true);
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Could not check if skill 'demo-skill' exists — sandbox may be unreachable.",
    );
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(tempConfig).not.toBe("");
    expect(fs.existsSync(tempConfig)).toBe(false);
  });

  it("reports an absent skill for remove and deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return false;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Skill 'demo-skill' is not installed in sandbox 'alpha'.");
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(tempConfig).not.toBe("");
    expect(fs.existsSync(tempConfig)).toBe(false);
  });

  it("removes and verifies an existing skill, then deletes the temp SSH config", async () => {
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx, resolvedPaths) => {
      tempConfig = ctx.configFile;
      expect(resolvedPaths).toBe(paths);
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(getSessionAgent).toHaveBeenCalledWith("alpha");
    expect(skillInstall.resolveSkillPaths).toHaveBeenCalledWith(agent, "demo-skill");
    expect(skillInstall.removeSkill).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(skillInstall.verifyRemove).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' removed"));
    expect(fs.existsSync(tempConfig)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("continues skill install when the existence probe is unknown because upload plus verify are authoritative", async () => {
    const skillDir = makeSkillDir();
    let tempConfig = "";
    skillInstall.checkExisting.mockImplementation((ctx) => {
      tempConfig = ctx.configFile;
      return null;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Warning: could not check sandbox for existing skill — treating as fresh install.",
      ),
    );
    expect(skillInstall.uploadDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      skillDir,
      paths.uploadDir,
    );
    expect(skillInstall.verifyInstall).toHaveBeenCalledWith(
      expect.objectContaining({ configFile: tempConfig, sandboxName: "alpha" }),
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' installed"));
    expect(fs.existsSync(tempConfig)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });
});
