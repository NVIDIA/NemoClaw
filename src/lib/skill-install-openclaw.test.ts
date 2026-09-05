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
  resolveOpenClawSkillProvenancePath,
  type SkillPaths,
  type SshContext,
  type SshResult,
} from "./skill-install";

const roots: string[] = [];
const ctx: SshContext = { configFile: "/tmp/ssh-config", sandboxName: "alpha" };
const sandboxIdentityFingerprint = "f".repeat(64);
const paths: SkillPaths = {
  stateDir: "/sandbox/.openclaw",
  uploadDir: "/sandbox/.openclaw/workspace/skills/demo-skill",
  workspaceSkillDir: "/sandbox/.openclaw/workspace/skills/demo-skill",
  uploadDirSharedWithAgent: false,
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
    "executes native publication, provenance, replacement, refusal, and staging cleanup",
    () => {
      const skill = makeSkill();
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-root-"));
      const fakeBin = path.join(sandboxRoot, "bin");
      const workspaceSkillDir = path.join(sandboxRoot, "workspace", "skills", "demo-skill");
      const provenanceStateDir = path.join(sandboxRoot, "host-state");
      const invocationLog = path.join(sandboxRoot, "openclaw.log");
      let checkState = "eligible";
      const executionPaths: SkillPaths = {
        ...paths,
        stateDir: sandboxRoot,
        uploadDir: path.join(sandboxRoot, "skills", "demo-skill"),
        workspaceSkillDir,
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
    case " $* " in *" --agent main "*) ;; *) exit 65 ;; esac
    printf '%s\\n' "$*" >> "$OPENCLAW_TEST_LOG"
    rm -rf -- "$OPENCLAW_TEST_TARGET"
    mkdir -p -- "$(dirname "$OPENCLAW_TEST_TARGET")"
    cp -R -- "$3" "$OPENCLAW_TEST_TARGET"
    mkdir -- "$OPENCLAW_TEST_TARGET/.openclaw"
    printf '{"version":1,"source":"path"}\\n' > "$OPENCLAW_TEST_TARGET/.openclaw/source-origin.json"
    ;;
  "skills list")
    case " $* " in *" --agent main "*) ;; *) exit 65 ;; esac
    printf '{"skills":[{"name":"demo-skill"}]}\\n'
    ;;
  "skills info")
    case " $* " in *" --agent main "*) ;; *) exit 65 ;; esac
    printf '{"name":"demo-skill","baseDir":"%s","filePath":"%s/SKILL.md"}\\n' "$OPENCLAW_TEST_TARGET" "$OPENCLAW_TEST_TARGET"
    ;;
  "skills check")
    case " $* " in *" --agent main "*) ;; *) exit 65 ;; esac
    if [ "$OPENCLAW_TEST_CHECK_STATE" = eligible ]; then
      printf '{"agentId":"main","eligible":["demo-skill"],"disabled":[],"blocked":[]}\\n'
    else
      printf '{"agentId":"main","eligible":[],"disabled":[],"blocked":["demo-skill"]}\\n'
    fi
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
              OPENCLAW_TEST_CHECK_STATE: checkState,
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
      const installOpts = {
        provenanceStateDir,
        sandboxIdentityFingerprint,
        sshExecImpl: sshExec,
      };
      const provenancePath = resolveOpenClawSkillProvenancePath(
        sandboxIdentityFingerprint,
        "demo-skill",
        provenanceStateDir,
      );

      const firstDigest = computeSkillContentDigest(skill);
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: firstDigest,
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain("# Demo");
      expect(fs.readFileSync(provenancePath, "utf8")).toContain(`"contentDigest":"${firstDigest}"`);
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);

      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo-skill\n---\n# Updated\n");
      const updatedDigest = computeSkillContentDigest(skill);
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: updatedDigest,
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain(
        "# Updated",
      );
      expect(fs.readFileSync(invocationLog, "utf8").trim().split("\n")).toEqual([
        expect.not.stringContaining("--force"),
        expect.stringContaining("--force"),
      ]);

      checkState = "blocked";
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: false,
        uploaded: 0,
        reason: "verification_failed",
      });
      checkState = "eligible";
      expect(JSON.parse(fs.readFileSync(provenancePath, "utf8"))).toMatchObject({
        phase: "pending",
        contentDigest: updatedDigest,
        previousDigest: updatedDigest,
      });
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: updatedDigest,
      });
      expect(fs.readFileSync(invocationLog, "utf8").trim().split("\n")).toHaveLength(3);

      const installedContent = fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8");
      fs.rmSync(provenancePath);
      const forgedRemoteReceipt = path.join(
        sandboxRoot,
        ".nemoclaw",
        "skill-installs",
        "demo-skill.sha256",
      );
      fs.mkdirSync(path.dirname(forgedRemoteReceipt), { recursive: true });
      fs.writeFileSync(forgedRemoteReceipt, `${updatedDigest}\n`, { mode: 0o600 });
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: false,
        uploaded: 0,
        reason: "destination_exists",
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toBe(
        installedContent,
      );
      expect(fs.existsSync(provenancePath)).toBe(false);

      fs.writeFileSync(
        provenancePath,
        `${JSON.stringify({
          schemaVersion: 1,
          sandboxIdentityFingerprint,
          sandboxName: "alpha",
          skillName: "demo-skill",
          workspaceSkillDir,
          phase: "installed",
          contentDigest: "0".repeat(64),
          previousDigest: null,
        })}\n`,
        { mode: 0o600 },
      );
      expect(installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOpts)).toEqual({
        success: false,
        uploaded: 0,
        reason: "destination_exists",
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toBe(
        installedContent,
      );
      expect(fs.readFileSync(invocationLog, "utf8").trim().split("\n")).toHaveLength(3);
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);
    },
  );

  it.runIf(process.platform === "linux")(
    "rejects a state root reached through a symlinked parent",
    () => {
      const skill = makeSkill();
      const container = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-root-link-"));
      const realParent = path.join(container, "real");
      const linkedParent = path.join(container, "linked");
      const stateDir = path.join(realParent, "state");
      const fakeBin = path.join(container, "bin");
      const invocationLog = path.join(container, "openclaw.log");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENCLAW_TEST_LOG"\nexit 99\n',
        { mode: 0o755 },
      );
      fs.symlinkSync(realParent, linkedParent);
      roots.push(container);
      const linkedPaths: SkillPaths = {
        ...paths,
        stateDir: path.join(linkedParent, "state"),
        uploadDir: path.join(linkedParent, "state", "skills", "demo-skill"),
        workspaceSkillDir: path.join(linkedParent, "state", "workspace", "skills", "demo-skill"),
      };
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

      expect(
        installOpenClawSkill(ctx, skill, linkedPaths, "demo-skill", {
          provenanceStateDir: path.join(container, "host-state"),
          sandboxIdentityFingerprint,
          sshExecImpl: sshExec,
        }),
      ).toEqual({ success: false, uploaded: 0, reason: "remote_state_unknown" });
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(fs.existsSync(invocationLog)).toBe(false);
    },
  );

  it.each([
    [2, "COLLISION\n", "destination_exists"],
    [3, "CAPABILITY_MISSING\n", "native_capability_missing"],
    [4, "installer output\nVERIFY_FAILED\n", "verification_failed"],
  ] as const)("maps native failure %s to %s", (status, stdout, reason) => {
    const skill = makeSkill();
    const provenanceStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-openclaw-provenance-"),
    );
    roots.push(provenanceStateDir);
    const sshExec = vi.fn(
      (
        _ctx: SshContext,
        _command: string,
        _opts?: { input?: string | Buffer; timeout?: number },
      ): SshResult => ({ status, stdout, stderr: "" }),
    );

    expect(
      installOpenClawSkill(ctx, skill, paths, "demo-skill", {
        provenanceStateDir,
        sandboxIdentityFingerprint,
        sshExecImpl: sshExec,
      }),
    ).toEqual({ success: false, uploaded: 0, reason });
  });
});
