// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeSkillContentDigest,
  getNativeSkillLifecycle,
  installOpenClawSkill,
  probeOpenClawSkillRemoveCapability,
  SKILL_SNAPSHOT_MAX_BYTES,
  shellQuote,
  type NativeSkillState,
  type SshContext,
  type SshResult,
} from "./skill-install";

const roots: string[] = [];
const ctx: SshContext = { configFile: "/tmp/ssh-config", sandboxName: "alpha" };
const SANDBOX_ID = "sandbox-alpha";
const SANDBOX_IDENTITY = createHash("sha256").update(SANDBOX_ID).digest("hex");
const paths: NativeSkillState = {
  stateDir: "/sandbox/.openclaw",
  isOpenClaw: true,
};
const lifecycle = getNativeSkillLifecycle({
  name: "openclaw",
  binary_path: "/usr/local/bin/openclaw",
  displayName: "OpenClaw",
})!;

function makeSkill(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-skill-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  roots.push(root);
  return root;
}

function installOptions(sshExecImpl: typeof import("./skill-remote").sshExec) {
  return { expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY, lifecycle, sshExecImpl };
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { force: true, recursive: true }));
});

describe("OpenClaw native skill installation", () => {
  it("probes native removal on the identity-bound SSH target without mutation", () => {
    const sshExec = vi.fn((_ctx: SshContext, _command: string): SshResult => ({
      status: 0,
      stdout: "remove help",
      stderr: "",
    }));

    expect(probeOpenClawSkillRemoveCapability(ctx, SANDBOX_IDENTITY, lifecycle, sshExec)).toBe(
      true,
    );
    expect(sshExec).toHaveBeenCalledWith(
      ctx,
      expect.stringContaining("'skills' 'remove' '--help'"),
      { timeout: 30_000 },
    );
    expect(sshExec.mock.calls[0]?.[1]).toContain("OPENSHELL_SANDBOX_ID");
  });

  it.runIf(process.platform === "linux")(
    "delegates a legacy main workspace, updates, and a timed-out native publisher",
    () => {
      const skill = makeSkill();
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-root-"));
      const fakeBin = path.join(sandboxRoot, "bin");
      const workspaceSkillDir = path.join(sandboxRoot, "workspace-main", "skills", "demo-skill");
      let nativeTarget = workspaceSkillDir;
      const invocationLog = path.join(sandboxRoot, "openclaw.log");
      const pinnedOpenClaw = path.join(fakeBin, "openclaw-pinned");
      const abandonedStage = path.join(sandboxRoot, ".nemoclaw-skill-stage.abandoned");
      let checkState = "eligible";
      let hangInstall = false;
      let hangVerification = false;
      let lastStderr = "";
      let mutatePayload = false;
      const lateInstallMarker = path.join(sandboxRoot, "late-install");
      const executionPaths: NativeSkillState = {
        ...paths,
        stateDir: sandboxRoot,
      };
      roots.push(sandboxRoot);
      fs.mkdirSync(fakeBin);
      fs.mkdirSync(abandonedStage, { mode: 0o700 });
      fs.writeFileSync(path.join(abandonedStage, "stale"), "stale\n");
      fs.writeFileSync(
        path.join(sandboxRoot, "openclaw.json"),
        `${JSON.stringify({ agents: { list: [{ id: "main", default: true, workspace: path.join(sandboxRoot, "workspace-main") }] } })}\n`,
      );
      fs.writeFileSync(
        pinnedOpenClaw,
        `#!/bin/sh
set -eu
case "$1 $2" in
  "skills install")
    if [ "\${3:-}" = "--help" ]; then
      printf '%s\n' '--agent --force --expected-digest'
      exit 0
    fi
    case " $* " in *" --agent main "*) ;; *) exit 65 ;; esac
    case " $* " in *" --force "*) ;; *) exit 65 ;; esac
    expected=""
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "--expected-digest" ]; then expected=$argument; fi
      previous=$argument
    done
    [ -n "$expected" ] || exit 65
    if [ "$OPENCLAW_TEST_HANG" = 1 ]; then sleep 10; printf late > "$OPENCLAW_TEST_LATE_MARKER"; fi
    if [ "$OPENCLAW_TEST_MUTATE" = 1 ]; then printf '%s\n' '# changed after outer validation' >> "$3/SKILL.md"; fi
    file_digest=$(sha256sum "$3/SKILL.md" | cut -d ' ' -f 1)
    observed=$(printf '644 %s  SKILL.md\n' "$file_digest" | sha256sum | cut -d ' ' -f 1)
    [ "$observed" = "$expected" ] || exit 74
    printf '%s\n' "$*" >> "$OPENCLAW_TEST_LOG"
    rm -rf -- "$OPENCLAW_TEST_TARGET"
    mkdir -p -- "$(dirname "$OPENCLAW_TEST_TARGET")"
    cp -R -- "$3" "$OPENCLAW_TEST_TARGET"
    mkdir -- "$OPENCLAW_TEST_TARGET/.openclaw"
    printf '{"version":1,"source":"path"}\n' > "$OPENCLAW_TEST_TARGET/.openclaw/source-origin.json"
    ;;
  "skills list")
    if [ "$OPENCLAW_TEST_HANG_VERIFICATION" = 1 ]; then sleep 10; fi
    printf '{"skills":[{"name":"demo-skill"}]}\n'
    ;;
  "skills info")
    printf '{"name":"demo-skill","baseDir":"%s","filePath":"%s/SKILL.md"}\n' "$OPENCLAW_TEST_TARGET" "$OPENCLAW_TEST_TARGET"
    ;;
  "skills check")
    if [ "$OPENCLAW_TEST_CHECK_STATE" = eligible ]; then
      printf '{"agentId":"main","eligible":["demo-skill"],"disabled":[],"blocked":[]}\n'
    else
      printf '{"agentId":"main","eligible":[],"disabled":[],"blocked":["demo-skill"]}\n'
    fi
    ;;
  *) exit 64 ;;
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
          const execution = spawnSync(
            "bash",
            [
              "--noprofile",
              "--norc",
              "-c",
              command.replaceAll("'/usr/local/bin/openclaw'", shellQuote(pinnedOpenClaw)),
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                OPENCLAW_TEST_CHECK_STATE: checkState,
                OPENCLAW_TEST_HANG: hangInstall ? "1" : "0",
                OPENCLAW_TEST_HANG_VERIFICATION: hangVerification ? "1" : "0",
                OPENCLAW_TEST_LATE_MARKER: lateInstallMarker,
                OPENCLAW_TEST_LOG: invocationLog,
                OPENCLAW_TEST_MUTATE: mutatePayload ? "1" : "0",
                OPENCLAW_TEST_TARGET: nativeTarget,
                OPENSHELL_SANDBOX_ID: SANDBOX_ID,
              },
              input: opts?.input,
              timeout: opts?.timeout,
            },
          );
          lastStderr = execution.stderr;
          return {
            status: execution.status ?? 1,
            stdout: execution.stdout,
            stderr: execution.stderr,
          };
        },
      );

      const firstDigest = computeSkillContentDigest(skill);
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({
        success: false,
        uploaded: 0,
        reason: "stage_recovery_failed",
      });
      expect(fs.readFileSync(path.join(abandonedStage, "stale"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(invocationLog)).toBe(false);
      fs.rmSync(abandonedStage, { recursive: true });

      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: firstDigest,
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain("# Demo");

      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo-skill\n---\n# Updated\n");
      const updatedDigest = computeSkillContentDigest(skill);
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: updatedDigest,
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain(
        "# Updated",
      );
      expect(fs.readFileSync(invocationLog, "utf8").trim().split("\n")).toHaveLength(2);

      fs.writeFileSync(path.join(workspaceSkillDir, "SKILL.md"), "# Foreign ClawHub content\n");
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({
        success: true,
        uploaded: 1,
        contentDigest: updatedDigest,
      });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain(
        "# Updated",
      );

      mutatePayload = true;
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({ success: false, uploaded: 0, reason: "native_install_failed" });
      expect(fs.readFileSync(path.join(workspaceSkillDir, "SKILL.md"), "utf8")).toContain(
        "# Updated",
      );
      mutatePayload = false;

      checkState = "blocked";
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({
        success: false,
        uploaded: 0,
        reason: "verification_failed",
      });
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);

      checkState = "eligible";
      hangInstall = true;
      const timedOut = installOpenClawSkill(
        ctx,
        skill,
        executionPaths,
        "demo-skill",
        installOptions((sshContext, command, options) =>
          sshExec(
            sshContext,
            command.replace("--kill-after=5s 90s", "--kill-after=1s 1s"),
            options,
          ),
        ),
      );
      expect(timedOut).toEqual({
        success: false,
        uploaded: 0,
        reason: "native_install_timed_out",
      });
      expect(fs.existsSync(lateInstallMarker)).toBe(false);
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);

      hangInstall = false;
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toMatchObject({ success: true });

      hangVerification = true;
      expect(
        installOpenClawSkill(
          ctx,
          skill,
          executionPaths,
          "demo-skill",
          installOptions((sshContext, command, options) =>
            sshExec(
              sshContext,
              command.replace("--kill-after=1s 5s", "--kill-after=1s 1s"),
              options,
            ),
          ),
        ),
      ).toEqual({ success: false, uploaded: 0, reason: "verification_failed" });
      expect(lastStderr).toContain("verification failed during skills list");
      expect(lastStderr).toContain("inspect native skill list state before retrying");
      expect(
        fs.readdirSync(sandboxRoot).filter((entry) => entry.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);
      hangVerification = false;

      nativeTarget = path.join(sandboxRoot, "other", "skills", "demo-skill");
      expect(
        installOpenClawSkill(ctx, skill, executionPaths, "demo-skill", installOptions(sshExec)),
      ).toEqual({ success: false, uploaded: 0, reason: "verification_failed" });
    },
    30_000,
  );

  it("rejects an oversized host snapshot before contacting the sandbox", () => {
    const skill = makeSkill();
    const oversized = path.join(skill, "oversized.bin");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, SKILL_SNAPSHOT_MAX_BYTES + 1);
    const sshExec = vi.fn();

    expect(installOpenClawSkill(ctx, skill, paths, "demo-skill", installOptions(sshExec))).toEqual({
      success: false,
      uploaded: 0,
      reason: "snapshot_limit_exceeded",
    });
    expect(sshExec).not.toHaveBeenCalled();
  });

  it.each([
    [3, "CAPABILITY_MISSING\n", "native_capability_missing"],
    [5, "NATIVE_INSTALL_FAILED\n", "native_install_failed"],
    [6, "NATIVE_INSTALL_TIMEOUT\n", "native_install_timed_out"],
    [7, "STAGE_RECOVERY_FAILED\n", "stage_recovery_failed"],
    [4, "installer output\nVERIFY_FAILED\n", "verification_failed"],
    [9, "IDENTITY_CHANGED\n", "sandbox_identity_changed"],
  ] as const)("maps native failure %s to %s", (status, stdout, reason) => {
    const skill = makeSkill();
    const sshExec = vi.fn((): SshResult => ({ status, stdout, stderr: "" }));

    expect(installOpenClawSkill(ctx, skill, paths, "demo-skill", installOptions(sshExec))).toEqual({
      success: false,
      uploaded: 0,
      reason,
    });
  });
});
