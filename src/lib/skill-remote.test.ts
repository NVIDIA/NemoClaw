// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxControl } from "./adapters/openshell/sandbox-control";
import { resolveSkillPaths } from "./skill-install";
import { validateSkillName } from "./skill-name";
import {
  checkExisting,
  removeSkill,
  type SandboxControlContext,
  sandboxExec,
  verifyRemove,
} from "./skill-remote";

function context(
  exec: OpenShellSandboxControl["exec"] = vi.fn(async () => {
    throw new Error("unreachable");
  }),
): SandboxControlContext {
  return { control: { exec }, sandboxName: "test-sandbox" };
}

describe("validateSkillName", () => {
  it.each([
    "my-skill",
    "my_skill",
    "my.skill",
    "MySkill123",
    "digicon-zeiss-ai-strategy",
  ])("accepts %s", (name) => expect(validateSkillName(name)).toBe(true));

  it.each([
    "",
    "my skill",
    "my;skill",
    "my$skill",
    "my/skill",
    "../escape",
    "my`skill`",
    ".",
    "..",
  ])("rejects %s", (name) => expect(validateSkillName(name)).toBe(false));
});

describe("sandboxExec", () => {
  it("runs one shell command through the selected control without transport retry", async () => {
    const exec = vi.fn(async () => ({ status: 0, stdout: "ok\n", stderr: " warning\n" }));
    const ctx = context(exec);

    await expect(
      sandboxExec(ctx, "cat > /tmp/file", { input: Buffer.from("body") }),
    ).resolves.toEqual({
      status: 0,
      stdout: "ok",
      stderr: "warning",
    });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith({
      sandboxName: "test-sandbox",
      command: ["sh", "-lc", "cat > /tmp/file"],
      stdin: Buffer.from("body"),
      timeoutMs: 30_000,
    });
  });
});

describe("removeSkill", () => {
  it("returns failure and warnings when sandbox execution is unavailable", async () => {
    const result = await removeSkill(context(), resolveSkillPaths(null, "test-skill"));

    expect(result.success).toBe(false);
    expect(result.removedUploadDir).toBe(false);
    expect(result.messages.some((message) => message.startsWith("Warning:"))).toBe(true);
  });

  it("fails when the OpenClaw mirror removal fails after upload removal", async () => {
    const result = await removeSkill(context(), resolveSkillPaths(null, "test-skill"), {
      execImpl: async (_ctx, command) => ({
        status: command.includes("$HOME/.openclaw/skills") ? 1 : 0,
        stdout: "",
        stderr: "",
      }),
    });

    expect(result).toMatchObject({
      removedUploadDir: true,
      removedMirrorDir: false,
      success: false,
    });
  });

  it("converges when retried after removing only the upload directory", async () => {
    const paths = resolveSkillPaths(null, "test-skill");
    const mirrorDir = paths.mirrorDir!;
    const unrelatedPath = "/sandbox/.openclaw/skills/other-skill";
    const clearSessions = `printf '{}' > '${paths.sessionFile}'`;
    const verifyGone = `test ! -e '${paths.uploadDir}' && test ! -e "${mirrorDir}" && echo GONE || echo EXISTS`;
    const scriptedResults = [
      {
        command: `rm -rf '${paths.uploadDir}'`,
        result: { status: 0, stdout: "", stderr: "" },
      },
      {
        command: `rm -rf "${mirrorDir}"`,
        result: { status: 1, stdout: "", stderr: "failed" },
      },
      { command: clearSessions, result: { status: 0, stdout: "", stderr: "" } },
      {
        command: `rm -rf '${paths.uploadDir}'`,
        result: { status: 0, stdout: "", stderr: "" },
      },
      {
        command: `rm -rf "${mirrorDir}"`,
        result: { status: 0, stdout: "", stderr: "" },
      },
      { command: clearSessions, result: { status: 0, stdout: "", stderr: "" } },
      {
        command: verifyGone,
        result: { status: 0, stdout: "GONE", stderr: "" },
      },
    ];
    const execImpl = vi.fn(async (_ctx: SandboxControlContext, command: string) => {
      const next = scriptedResults.shift();
      expect(next).toBeDefined();
      expect(command).toBe(next!.command);
      expect(command).not.toContain(unrelatedPath);
      return next!.result;
    });

    await expect(removeSkill(context(), paths, { execImpl })).resolves.toMatchObject({
      removedUploadDir: true,
      removedMirrorDir: false,
      success: false,
    });
    await expect(removeSkill(context(), paths, { execImpl })).resolves.toMatchObject({
      clearedSessions: true,
      removedMirrorDir: true,
      removedUploadDir: true,
      success: true,
    });
    await expect(verifyRemove(context(), paths, { execImpl })).resolves.toBe(true);

    expect(scriptedResults).toEqual([]);
  });

  it("removes OpenClaw upload and mirror dirs, then clears sessions", async () => {
    const commands: string[] = [];
    const result = await removeSkill(context(), resolveSkillPaths(null, "test-skill"), {
      execImpl: async (_ctx, command) => {
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

describe("verifyRemove", () => {
  it("fails conservatively when sandbox execution is unavailable", async () => {
    await expect(verifyRemove(context(), resolveSkillPaths(null, "test-skill"))).resolves.toBe(
      false,
    );
  });

  it("verifies both OpenClaw skill directories are gone", async () => {
    const commands: string[] = [];
    const gone = await verifyRemove(context(), resolveSkillPaths(null, "test-skill"), {
      execImpl: async (_ctx, command) => {
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

describe("checkExisting", () => {
  it("maps a selected-control execution failure to an inconclusive result", async () => {
    await expect(
      checkExisting(context(), resolveSkillPaths(null, "test-skill")),
    ).resolves.toBeNull();
  });

  it("maps a successful absence sentinel to false", async () => {
    const execImpl = vi.fn(async () => ({ status: 0, stdout: "ABSENT", stderr: "" }));

    await expect(
      checkExisting(context(), resolveSkillPaths(null, "test-skill"), { execImpl }),
    ).resolves.toBe(false);
  });

  it("probes directories so removal can clean partial uploads", async () => {
    const commands: string[] = [];
    const exists = await checkExisting(context(), resolveSkillPaths(null, "test-skill"), {
      execImpl: async (_ctx, command) => {
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
