// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  it.runIf(process.platform === "linux")(
    "executes native publication, provenance, replacement, and staging cleanup",
    () => {
      const skill = makeSkill();
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-root-"));
      const fakeBin = path.join(sandboxRoot, "bin");
      const workspaceSkillDir = path.join(sandboxRoot, "workspace", "skills", "demo-skill");
      const invocationLog = path.join(sandboxRoot, "openclaw.log");
      const executionPaths: SkillPaths = {
        ...paths,
        stateDir: sandboxRoot,
        uploadDir: path.join(sandboxRoot, "skills", "demo-skill"),
        mirrorDir: null,
        workspaceSkillDir,
        sessionFile: path.join(sandboxRoot, "agents", "main", "sessions", "sessions.json"),
      };
      roots.push(sandboxRoot);
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        `#!/bin/sh
set -eu
case "$1 $2" in
  "skills install")
    if [ "\${3:-}" = "--help" ]; then
      printf '%s\\n' '--agent --force'
      exit 0
    fi
    printf '%s\\n' "$*" >> "$OPENCLAW_TEST_LOG"
    rm -rf -- "$OPENCLAW_TEST_TARGET"
    mkdir -p -- "$(dirname "$OPENCLAW_TEST_TARGET")"
    cp -R -- "$3" "$OPENCLAW_TEST_TARGET"
    ;;
  "skills list"|"skills info"|"skills check")
    printf '{"skills":["demo-skill"],"path":"%s"}\\n' "$OPENCLAW_TEST_TARGET"
    ;;
  *)
    exit 64
    ;;
esac
`,
        { mode: 0o755 },
      );
      const sshExec = vi.fn(
        (
          _ctx: SshContext,
          command: string,
          opts?: { input?: string | Buffer; timeout?: number },
        ): SshResult => {
          const execution = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
            encoding: "utf8",
            env: {
              ...process.env,
              OPENCLAW_TEST_LOG: invocationLog,
              OPENCLAW_TEST_TARGET: workspaceSkillDir,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            },
            input: opts?.input,
            timeout: opts?.timeout,
          });
          return {
            status: execution.status ?? 1,
            stdout: execution.stdout,
            stderr: execution.stderr,
          };
        },
      );

      const firstDigest = computeSkillContentDigest(skill);
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", {
          sshExecImpl: sshExec,
        }),
      ).toEqual({ success: true, uploaded: 1, contentDigest: firstDigest });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain("# Demo");
      expect(
        fs.readFileSync(
          path.join(sandboxRoot, ".nemoclaw", "skill-installs", "demo-skill.sha256"),
          "utf8",
        ),
      ).toBe(`${firstDigest}\n`);
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);

      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo-skill\n---\n# Updated\n");
      const updatedDigest = computeSkillContentDigest(skill);
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", {
          sshExecImpl: sshExec,
        }),
      ).toEqual({ success: true, uploaded: 1, contentDigest: updatedDigest });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain(
        "# Updated",
      );
      expect(fs.readFileSync(invocationLog, "utf8").trim().split("\n")).toEqual([
        expect.not.stringContaining("--force"),
        expect.stringContaining("--force"),
      ]);
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);
    },
  );

  it.each([
    [2, "COLLISION\n", "destination_exists"],
    [3, "CAPABILITY_MISSING\n", "native_capability_missing"],
    [4, "installer output\nVERIFY_FAILED\n", "verification_failed"],
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
