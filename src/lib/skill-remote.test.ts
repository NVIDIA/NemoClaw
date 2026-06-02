// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { validateSkillName } from "../../dist/lib/skill-name";
import { checkExisting, removeSkill, verifyRemove } from "../../dist/lib/skill-remote";
import { resolveSkillPaths } from "../../dist/lib/skill-install";

describe("validateSkillName", () => {
  it("accepts valid skill names", () => {
    expect(validateSkillName("my-skill")).toBe(true);
    expect(validateSkillName("my_skill")).toBe(true);
    expect(validateSkillName("my.skill")).toBe(true);
    expect(validateSkillName("MySkill123")).toBe(true);
    expect(validateSkillName("digicon-zeiss-ai-strategy")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSkillName("")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(validateSkillName("my skill")).toBe(false);
  });

  it("rejects names with shell metacharacters", () => {
    expect(validateSkillName("my;skill")).toBe(false);
    expect(validateSkillName("my$skill")).toBe(false);
    expect(validateSkillName("my/skill")).toBe(false);
    expect(validateSkillName("../escape")).toBe(false);
    expect(validateSkillName("my`skill`")).toBe(false);
  });

  it("rejects dot and double-dot to prevent directory traversal on rm -rf", () => {
    expect(validateSkillName(".")).toBe(false);
    expect(validateSkillName("..")).toBe(false);
  });
});

describe("removeSkill (unit — no SSH)", () => {
  it("returns success=false and a warning when sshExec returns null (sandbox unreachable)", () => {
    const paths = resolveSkillPaths(null, "test-skill");

    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    const result = removeSkill(ctx, paths);

    expect(result.success).toBe(false);
    expect(result.removedUploadDir).toBe(false);
    expect(result.messages.some((m) => m.startsWith("Warning:"))).toBe(true);
  });

  it("success is false for OpenClaw when mirrorDir removal fails even if uploadDir was removed", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(null, "test-skill");
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => ({
        status: command.includes("$HOME/.openclaw/skills") ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(result.removedUploadDir).toBe(true);
    expect(result.removedMirrorDir).toBe(false);
    expect(result.success).toBe(false);
  });

  it("removes OpenClaw upload and mirror dirs, then clears sessions", () => {
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const paths = resolveSkillPaths(null, "test-skill");
    const commands: string[] = [];
    const result = removeSkill(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.success).toBe(true);
    expect(result.clearedSessions).toBe(true);
    expect(commands).toEqual([
      "rm -rf '/sandbox/.openclaw/skills/test-skill'",
      'rm -rf "$HOME/.openclaw/skills/test-skill"',
      "printf '{}' > '/sandbox/.openclaw/agents/main/sessions/sessions.json'",
    ]);
  });
});

describe("verifyRemove (unit — no SSH)", () => {
  it("returns false when SSH is unreachable (conservative — treat failure as not-gone)", () => {
    const paths = resolveSkillPaths(null, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(verifyRemove(ctx, paths)).toBe(false);
  });

  it("returns false for non-OpenClaw paths when SSH is unreachable", () => {
    const paths = resolveSkillPaths(
      { name: "hermes", configPaths: { dir: "/sandbox/.hermes" } },
      "test-skill",
    );
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(verifyRemove(ctx, paths)).toBe(false);
  });

  it("verifies both OpenClaw skill directories are gone", () => {
    const paths = resolveSkillPaths(null, "test-skill");
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const commands: string[] = [];
    const gone = verifyRemove(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "GONE", stderr: "" };
      },
    });

    expect(gone).toBe(true);
    expect(commands).toEqual([
      "test ! -e '/sandbox/.openclaw/skills/test-skill' && test ! -e \"$HOME/.openclaw/skills/test-skill\" && echo GONE || echo EXISTS",
    ]);
  });
});

describe("checkExisting (unit — no SSH)", () => {
  it("returns null when SSH is unreachable for OpenClaw paths", () => {
    const paths = resolveSkillPaths(null, "test-skill");
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(checkExisting(ctx, paths)).toBeNull();
  });

  it("returns null when SSH is unreachable for non-OpenClaw paths", () => {
    const paths = resolveSkillPaths(
      { name: "hermes", configPaths: { dir: "/sandbox/.hermes" } },
      "test-skill",
    );
    const ctx = { configFile: "/nonexistent/ssh.conf", sandboxName: "test-sandbox" };
    expect(checkExisting(ctx, paths)).toBeNull();
  });

  it("probes skill directories so removal can clean partial uploads", () => {
    const paths = resolveSkillPaths(null, "test-skill");
    const ctx = { configFile: "/tmp/ssh.conf", sandboxName: "test-sandbox" };
    const commands: string[] = [];
    const exists = checkExisting(ctx, paths, {
      sshExecImpl: (_ctx, command) => {
        commands.push(command);
        return { status: 0, stdout: "EXISTS", stderr: "" };
      },
    });

    expect(exists).toBe(true);
    expect(commands[0]).toContain("test -e '/sandbox/.openclaw/skills/test-skill'");
    expect(commands[0]).toContain('test -e "$HOME/.openclaw/skills/test-skill"');
    expect(commands[0]).not.toContain("SKILL.md");
  });
});
