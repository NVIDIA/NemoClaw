// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeSkillContentDigest,
  installOpenClawSkill,
  type SkillPaths,
  type SshContext,
  type SshResult,
} from "./skill-install";

const roots: string[] = [];
const ctx: SshContext = { configFile: "/tmp/ssh-config", sandboxName: "alpha" };
const paths: SkillPaths = {
  stateDir: "/sandbox/.openclaw",
  uploadDir: "/sandbox/.openclaw/skills/demo-skill",
  mirrorDir: "$HOME/.openclaw/skills/demo-skill",
  workspaceSkillDir: "/sandbox/.openclaw/workspace/skills/demo-skill",
  uploadDirSharedWithAgent: false,
  sessionFile: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
  reloadsSkillsOnSessionStart: false,
  isOpenClaw: true,
};

function makeSkill(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-skill-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  roots.push(root);
  return root;
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { force: true, recursive: true }));
});

describe("OpenClaw native skill installation", () => {
  it("stages privately, delegates publication, verifies natively, and records provenance", () => {
    const skill = makeSkill();
    const digest = computeSkillContentDigest(skill);
    const sshExec = vi.fn(
      (
        _ctx: SshContext,
        _command: string,
        _opts?: { input?: string | Buffer; timeout?: number },
      ): SshResult => ({
        status: 0,
        stdout: `INSTALLED ${digest}`,
        stderr: "",
      }),
    );

    const result = installOpenClawSkill(ctx, skill, paths, "demo-skill", {
      sshExecImpl: sshExec,
    });

    expect(result).toEqual({ success: true, uploaded: 1, contentDigest: digest });
    const command = sshExec.mock.calls[0][1];
    expect(command).toContain('mktemp -d "$root/.nemoclaw-skill-stage.XXXXXX"');
    expect(command).toContain('chmod 700 "$stage"');
    expect(command).toContain("trap cleanup EXIT HUP INT TERM");
    expect(command).toContain('openclaw skills install "$payload" --agent main');
    expect(command).toContain("openclaw skills list --json");
    expect(command).toContain('openclaw skills info "$skill" --json');
    expect(command).toContain("openclaw skills check --json");
    expect(command).toContain("/sandbox/.openclaw/.nemoclaw/skill-installs");
    expect(command).not.toContain("sessions.json");
    expect(command).not.toContain('rm -rf -- "$target"');
    expect(sshExec.mock.calls[0][2]).toMatchObject({
      input: expect.any(Buffer),
      timeout: 120_000,
    });
  });

  it("permits native force only after matching provenance and installed content", () => {
    const skill = makeSkill();
    const digest = computeSkillContentDigest(skill);
    const sshExec = vi.fn(
      (
        _ctx: SshContext,
        _command: string,
        _opts?: { input?: string | Buffer; timeout?: number },
      ): SshResult => ({
        status: 0,
        stdout: `UPDATED ${digest}`,
        stderr: "",
      }),
    );

    expect(
      installOpenClawSkill(ctx, skill, paths, "demo-skill", { sshExecImpl: sshExec }),
    ).toMatchObject({ success: true, contentDigest: digest });
    const command = sshExec.mock.calls[0][1];
    expect(command).toContain('[ "$previous" = "$current" ]');
    expect(command).toContain('openclaw skills install "$payload" --agent main --force');
  });

  it.each([
    [2, "COLLISION", "destination_exists"],
    [3, "CAPABILITY_MISSING", "native_capability_missing"],
    [4, "VERIFY_FAILED", "verification_failed"],
  ] as const)("maps native failure %s to %s", (status, stdout, reason) => {
    const skill = makeSkill();
    const sshExec = vi.fn(
      (
        _ctx: SshContext,
        _command: string,
        _opts?: { input?: string | Buffer; timeout?: number },
      ): SshResult => ({ status, stdout, stderr: "" }),
    );

    expect(installOpenClawSkill(ctx, skill, paths, "demo-skill", { sshExecImpl: sshExec })).toEqual(
      { success: false, uploaded: 0, reason },
    );
  });
});
