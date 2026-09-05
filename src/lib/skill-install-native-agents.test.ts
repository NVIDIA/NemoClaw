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
  installNativeAgentSkill,
  shellQuote,
  type NativeLocalSkillAgent,
  type NativeSkillState,
} from "./skill-install";
import type { SshContext, SshResult } from "./skill-remote";

const roots: string[] = [];
const context: SshContext = { configFile: "/tmp/ssh-config", sandboxName: "alpha" };
const SANDBOX_ID = "sandbox-alpha";
const SANDBOX_IDENTITY = createHash("sha256").update(SANDBOX_ID).digest("hex");

function makeSkill(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-agent-skill-"));
  fs.writeFileSync(path.join(root, "SKILL.md"), "---\nname: demo-skill\n---\n# Demo\n");
  roots.push(root);
  return root;
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("Hermes and DCode native skill installation", () => {
  it.each([
    ["hermes", "/usr/local/bin/hermes", "import-local", "/sandbox/.hermes"],
    ["langchain-deepagents-code", "/usr/local/bin/dcode", "import", "/sandbox/.deepagents"],
  ] as const)(
    "builds a staged %s native import without a host destination",
    (agent, binary, verb, stateDir) => {
      const skill = makeSkill();
      const digest = computeSkillContentDigest(skill);
      let command = "";
      const sshExec = vi.fn((_ctx: SshContext, candidate: string): SshResult => {
        command = candidate;
        return { status: 0, stdout: `INSTALLED ${digest}`, stderr: "" };
      });
      const paths: NativeSkillState = {
        stateDir,
        isOpenClaw: false,
      };

      expect(
        installNativeAgentSkill(context, skill, paths, agent, "demo-skill", {
          expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY,
          sshExecImpl: sshExec,
        }),
      ).toEqual({ success: true, uploaded: 1, contentDigest: digest });
      expect(command).toContain(shellQuote(binary));
      expect(command).toContain(`'skills' '${verb}' "$payload"`);
      expect(command).toContain(`'--expected-digest' '${digest}'`);
      expect(command).toContain("NEMOCLAW_NATIVE_SKILL_IMPORT=");
      expect(command).not.toContain("/skills/demo-skill");
    },
  );

  it.each([
    [3, "CAPABILITY_MISSING\n", "native_capability_missing"],
    [4, "VERIFY_FAILED\n", "verification_failed"],
    [5, "NATIVE_INSTALL_FAILED\n", "native_install_failed"],
    [7, "STAGE_RECOVERY_FAILED\n", "stage_recovery_failed"],
    [9, "IDENTITY_CHANGED\n", "sandbox_identity_changed"],
  ] as const)("maps native staged import failure %s", (status, stdout, reason) => {
    const skill = makeSkill();
    const paths: NativeSkillState = {
      stateDir: "/sandbox/.hermes",
      isOpenClaw: false,
    };

    expect(
      installNativeAgentSkill(context, skill, paths, "hermes", "demo-skill", {
        expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY,
        sshExecImpl: () => ({ status, stdout, stderr: "" }),
      }),
    ).toEqual({ success: false, uploaded: 0, reason });
  });

  it
    .runIf(process.platform === "linux")
    .each(["hermes", "langchain-deepagents-code"] as NativeLocalSkillAgent[])(
    "executes %s-emitted target resolution for fresh installs and updates",
    (agent) => {
      const skill = makeSkill();
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-${agent}-state-`));
      roots.push(stateDir);
      const target = path.join(
        stateDir,
        agent === "hermes" ? "skills/demo-skill" : "agent/skills/demo-skill",
      );
      const fakeBinary = path.join(stateDir, "agent-cli");
      const abandonedStage = path.join(stateDir, ".nemoclaw-skill-stage.abandoned");
      const nativeBinary = agent === "hermes" ? "/usr/local/bin/hermes" : "/usr/local/bin/dcode";
      let mutatePayload = false;
      fs.mkdirSync(abandonedStage, { mode: 0o700 });
      fs.writeFileSync(path.join(abandonedStage, "stale"), "stale\n");
      fs.writeFileSync(
        fakeBinary,
        `#!/bin/sh
set -eu
if [ "\${3:-}" = "--help" ]; then exit 0; fi
case "\${1:-} \${2:-}" in
  "skills import-local"|"skills import")
    source=\$3
    expected=""
    previous=""
    for argument in "\$@"; do
      if [ "\$previous" = "--expected-digest" ]; then expected=\$argument; fi
      previous=\$argument
    done
    [ -n "\$expected" ] || exit 65
    if [ "\$NATIVE_SKILL_MUTATE" = 1 ]; then printf '%s\n' '# changed after outer validation' >> "\$source/SKILL.md"; fi
    file_digest=\$(sha256sum "\$source/SKILL.md" | cut -d ' ' -f 1)
    observed=\$(printf '644 %s  SKILL.md\n' "\$file_digest" | sha256sum | cut -d ' ' -f 1)
    [ "\$observed" = "\$expected" ] || exit 74
    rm -rf -- "$NATIVE_SKILL_TARGET"
    mkdir -p -- "\$(dirname "$NATIVE_SKILL_TARGET")"
    cp -R -- "\$source" "$NATIVE_SKILL_TARGET"
    printf 'NEMOCLAW_NATIVE_SKILL_IMPORT={"status":"installed","name":"demo-skill","path":"%s","digest":"%s"}\\n' "$NATIVE_SKILL_TARGET" "\$expected"
    ;;
  "skills list") exit 0 ;;
  *) exit 64 ;;
esac
`,
        { mode: 0o755 },
      );
      const paths: NativeSkillState = {
        stateDir,
        isOpenClaw: false,
      };
      const sshExec = (
        _ctx: SshContext,
        command: string,
        options?: { input?: string | Buffer; timeout?: number },
      ): SshResult => {
        const result = spawnSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            command.replaceAll(shellQuote(nativeBinary), shellQuote(fakeBinary)),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NATIVE_SKILL_MUTATE: mutatePayload ? "1" : "0",
              NATIVE_SKILL_TARGET: target,
              OPENSHELL_SANDBOX_ID: SANDBOX_ID,
            },
            input: options?.input,
          },
        );
        return {
          status: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      };

      expect(
        installNativeAgentSkill(context, skill, paths, agent, "demo-skill", {
          expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY,
          sshExecImpl: sshExec,
        }),
      ).toMatchObject({ success: true });
      expect(fs.existsSync(abandonedStage)).toBe(false);
      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo-skill\n---\n# Updated\n");
      expect(
        installNativeAgentSkill(context, skill, paths, agent, "demo-skill", {
          expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY,
          sshExecImpl: sshExec,
        }),
      ).toMatchObject({ success: true });
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toContain("# Updated");
      mutatePayload = true;
      expect(
        installNativeAgentSkill(context, skill, paths, agent, "demo-skill", {
          expectedSandboxIdentityFingerprint: SANDBOX_IDENTITY,
          sshExecImpl: sshExec,
        }),
      ).toEqual({ success: false, uploaded: 0, reason: "native_install_failed" });
      expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toContain("# Updated");
      expect(
        fs.readdirSync(stateDir).filter((name) => name.startsWith(".nemoclaw-skill-stage.")),
      ).toEqual([]);
    },
  );
});
