// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectOpenShellSandboxControlForMutation = vi.hoisted(() => vi.fn());
const closeControl = vi.hoisted(() => vi.fn());
const control = vi.hoisted(() => ({ exec: vi.fn() }));
const getSandbox = vi.hoisted(() => vi.fn());
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

vi.mock("../../adapters/openshell/sandbox-control-routing", () => ({
  selectOpenShellSandboxControlForMutation,
}));

vi.mock("../../state/registry", () => ({ getSandbox }));

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

    selectOpenShellSandboxControlForMutation.mockReturnValue({
      control,
      transport: "grpc",
      close: closeControl,
    });
    getSandbox.mockReturnValue({ gatewayName: "nemoclaw-9090", gatewayPort: 9090 });
    ensureLiveSandboxOrExit.mockResolvedValue(undefined);
    getSessionAgent.mockReturnValue(agent);
    skillInstall.validateSkillName.mockReturnValue(true);
    skillInstall.resolveSkillPaths.mockReturnValue(paths);
    skillInstall.checkExisting.mockResolvedValue(true);
    skillInstall.removeSkill.mockResolvedValue({
      success: true,
      removedUploadDir: true,
      removedMirrorDir: true,
      clearedSessions: true,
      messages: [],
    });
    skillInstall.verifyRemove.mockResolvedValue(true);
    skillInstall.parseFrontmatter.mockReturnValue({ name: "demo-skill" });
    skillInstall.collectFiles.mockReturnValue({
      files: ["SKILL.md"],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.uploadDirectory.mockResolvedValue({
      uploaded: 1,
      failed: [],
      skippedDotfiles: [],
      unsafePaths: [],
    });
    skillInstall.postInstall.mockResolvedValue({ success: true, messages: [] });
    skillInstall.verifyInstall.mockResolvedValue(true);
  });

  afterEach(() => {
    restoreExitCode(previousExitCode);
    vi.restoreAllMocks();
  });

  it("fails skill remove before dispatch when control selection fails", async () => {
    selectOpenShellSandboxControlForMutation.mockImplementation(() => {
      throw new Error("invalid mTLS material");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await expect(removeSandboxSkill("alpha", { name: "demo-skill" })).rejects.toThrow(
      "process.exit 1",
    );

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(selectOpenShellSandboxControlForMutation).toHaveBeenCalledWith("nemoclaw-9090");
    expect(error).toHaveBeenCalledWith(
      "  Failed to configure OpenShell sandbox execution: invalid mTLS material",
    );
    expect(skillInstall.checkExisting).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("treats unknown skill existence as fatal for remove and closes the control", async () => {
    skillInstall.checkExisting.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "  Could not check if skill 'demo-skill' exists — sandbox may be unreachable.",
    );
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(closeControl).toHaveBeenCalledOnce();
  });

  it("reports an absent skill for remove and closes the control", async () => {
    skillInstall.checkExisting.mockResolvedValue(false);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("  Skill 'demo-skill' is not installed in sandbox 'alpha'.");
    expect(skillInstall.removeSkill).not.toHaveBeenCalled();
    expect(skillInstall.verifyRemove).not.toHaveBeenCalled();
    expect(closeControl).toHaveBeenCalledOnce();
  });

  it("removes and verifies an existing skill, then closes the selected control", async () => {
    skillInstall.checkExisting.mockImplementation(async (ctx, resolvedPaths) => {
      expect(ctx.control).toBe(control);
      expect(resolvedPaths).toBe(paths);
      return true;
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await removeSandboxSkill("alpha", { name: "demo-skill" });

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(getSessionAgent).toHaveBeenCalledWith("alpha");
    expect(skillInstall.resolveSkillPaths).toHaveBeenCalledWith(agent, "demo-skill");
    expect(skillInstall.removeSkill).toHaveBeenCalledWith({ control, sandboxName: "alpha" }, paths);
    expect(skillInstall.verifyRemove).toHaveBeenCalledWith(
      { control, sandboxName: "alpha" },
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' removed"));
    expect(closeControl).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("stops skill installation at the shared gateway liveness guard (#2276)", async () => {
    const skillDir = makeSkillDir();
    ensureLiveSandboxOrExit.mockRejectedValueOnce(new Error("wrong gateway active"));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        installSandboxSkill("alpha", { command: "install", path: skillDir }),
      ).rejects.toThrow("wrong gateway active");
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(ensureLiveSandboxOrExit).toHaveBeenCalledWith("alpha");
    expect(selectOpenShellSandboxControlForMutation).not.toHaveBeenCalled();
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
  });

  it("fails skill install before upload when the existence probe is inconclusive", async () => {
    const skillDir = makeSkillDir();
    skillInstall.checkExisting.mockResolvedValue(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(
      "  Could not check if skill 'demo-skill' exists — sandbox may be unreachable. No files were uploaded.",
    );
    expect(skillInstall.uploadDirectory).not.toHaveBeenCalled();
    expect(skillInstall.postInstall).not.toHaveBeenCalled();
    expect(skillInstall.verifyInstall).not.toHaveBeenCalled();
    expect(closeControl).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("installs when the existence probe confirms the skill is absent", async () => {
    const skillDir = makeSkillDir();
    skillInstall.checkExisting.mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await installSandboxSkill("alpha", { command: "install", path: skillDir });
    } finally {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }

    expect(skillInstall.uploadDirectory).toHaveBeenCalledWith(
      { control, sandboxName: "alpha" },
      skillDir,
      paths.uploadDir,
    );
    expect(skillInstall.verifyInstall).toHaveBeenCalledWith(
      { control, sandboxName: "alpha" },
      paths,
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Skill 'demo-skill' installed"));
    expect(closeControl).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });
});
