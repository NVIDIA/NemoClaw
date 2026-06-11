// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression coverage for #4538 (reopened after PR #4610).
 *
 * The reporter workflow is NOT a NemoClaw wrapper command: QA connects to a
 * mutable sandbox and runs the raw OpenClaw CLI directly —
 *
 *     openclaw doctor --fix
 *
 * `doctor --fix` enforces OpenClaw's single-user 700/600 layout, tightening
 * /sandbox/.openclaw to `700 sandbox:sandbox` and openclaw.json to `600`, even
 * when it exits nonzero (it hits EACCES on the root-locked /sandbox/.bashrc).
 * That breaks the NemoClaw mutable contract (2770 dir / 660 config) the gateway
 * UID needs — the gateway is in the sandbox group and can no longer persist
 * config writes.
 *
 * PR #4610 only repaired this from NemoClaw-managed host paths (`nemoclaw doctor
 * --fix`, rebuild structure-repair, startup). None of those run after a raw
 * in-sandbox `openclaw doctor --fix` until the next restart, so the gateway
 * stays broken in between. The fix adds the restore to the always-on in-sandbox
 * `openclaw()` guard function (emitted into /tmp/nemoclaw-proxy-env.sh and
 * sourced by every interactive/login sandbox shell), so the contract is
 * re-asserted after every raw openclaw invocation, regardless of exit code.
 *
 * These tests execute the actual emitted guard / helper shell against a
 * temporary OpenClaw config tree rather than asserting on source text. The
 * docker-backed test at the bottom drives the EXACT reporter workflow against a
 * real sandbox image and is gated behind NEMOCLAW_RUN_DOCTOR_PERMS_DOCKER_E2E=1.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunctionFromSource(src: string, name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

/**
 * Extract the literal guard block emitted into /tmp/nemoclaw-proxy-env.sh — the
 * region between `# nemoclaw-configure-guard begin` and `# nemoclaw-configure-
 * guard end`. The block lives inside a single-quoted heredoc, so what the test
 * sources is byte-identical to what a connect shell sources at runtime.
 */
function extractGuardBlock(src: string): string {
  const begin = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end");
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error("Expected nemoclaw-configure-guard begin/end markers in nemoclaw-start.sh");
  }
  return src.slice(begin, src.indexOf("\n", end) + 1);
}

function modeBits(filePath: string): number {
  return fs.statSync(filePath).mode & 0o7777;
}

// WSL CI can run these snippets as root; force restore-path cases to model a
// mutable sandbox-owned config tree instead of the shields-up root-owned branch.
function mutableSandboxOwnerStatShim(): string {
  return [
    "stat() {",
    '  if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U" ] && [ "${3:-}" = "$OPENCLAW_STATE_DIR" ]; then',
    '    printf "sandbox\\n";',
    "    return 0;",
    "  fi",
    '  command stat "$@";',
    "}",
  ].join("\n");
}

function mkdtempOnPosixFs(prefix: string): string {
  const roots = process.platform === "linux" ? ["/tmp", os.tmpdir()] : [os.tmpdir()];
  let lastError: unknown = null;
  for (const root of roots) {
    try {
      return fs.mkdtempSync(path.join(root, prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function seedTightenedConfigTree(): { tmpDir: string; configDir: string; configFile: string } {
  const tmpDir = mkdtempOnPosixFs("nemoclaw-4538-");
  const configDir = path.join(tmpDir, ".openclaw");
  const nestedDir = path.join(configDir, "agents", "main");
  const configFile = path.join(configDir, "openclaw.json");
  const hashFile = path.join(configDir, ".config-hash");
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(configFile, "{}\n");
  fs.writeFileSync(hashFile, "deadbeef\n");
  // Simulate the post-`openclaw doctor --fix` single-user layout.
  fs.chmodSync(configFile, 0o600);
  fs.chmodSync(hashFile, 0o600);
  fs.chmodSync(nestedDir, 0o700);
  fs.chmodSync(configDir, 0o700);
  return { tmpDir, configDir, configFile };
}

describe("#4538 raw `openclaw doctor --fix` mutable-perm restore", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("restore helper re-asserts 2770/660 after the tree is tightened to 700/600", () => {
    const { tmpDir, configDir, configFile } = seedTightenedConfigTree();
    const nestedDir = path.join(configDir, "agents", "main");
    const hashFile = path.join(configDir, ".config-hash");
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            mutableSandboxOwnerStatShim(),
            extractShellFunctionFromSource(src, "_nemoclaw_restore_mutable_config_perms"),
            "_nemoclaw_restore_mutable_config_perms",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, OPENCLAW_STATE_DIR: configDir },
        },
      );

      expect(result.status).toBe(0);
      // Dir: setgid + group rwx, world stripped.
      expect(modeBits(configDir)).toBe(0o2770);
      // Config + hash: group-writable so the gateway UID can persist edits.
      expect(modeBits(configFile)).toBe(0o660);
      expect(modeBits(hashFile)).toBe(0o660);
      // Recursive: nested dirs regain setgid + group access too.
      expect(modeBits(nestedDir) & 0o2070).toBe(0o2070);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restore helper is a no-op when shields are up (config dir owned by root)", () => {
    const { tmpDir, configDir, configFile } = seedTightenedConfigTree();
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            // Pretend the dir is root-owned (shields up); never weaken the lock.
            'stat() { if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%U" ]; then printf "root\\n"; else command stat "$@"; fi; }',
            extractShellFunctionFromSource(src, "_nemoclaw_restore_mutable_config_perms"),
            "_nemoclaw_restore_mutable_config_perms",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, OPENCLAW_STATE_DIR: configDir },
        },
      );

      expect(result.status).toBe(0);
      // Untouched: shields-up locking must not be loosened by the guard.
      expect(modeBits(configDir)).toBe(0o700);
      expect(modeBits(configFile)).toBe(0o600);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emitted openclaw() guard restores the contract AND preserves a nonzero exit", () => {
    const { tmpDir, configDir, configFile } = seedTightenedConfigTree();
    // Start from the intact contract so the simulated doctor run is what
    // tightens it — exactly the reporter sequence.
    fs.chmodSync(configDir, 0o2770);
    fs.chmodSync(configFile, 0o660);
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            mutableSandboxOwnerStatShim(),
            // Intercept `command openclaw ...` (the guard's terminal call) to
            // simulate `doctor --fix`: tighten perms, then exit nonzero — the
            // EACCES-on-.bashrc case the reporter hit.
            "command() {",
            '  if [ "${1:-}" = "openclaw" ]; then',
            '    chmod 700 "$OPENCLAW_STATE_DIR";',
            '    chmod 600 "$OPENCLAW_STATE_DIR/openclaw.json";',
            "    return 7;",
            "  fi",
            '  builtin command "$@";',
            "}",
            extractGuardBlock(src),
            "openclaw doctor --fix",
            'echo "GUARD_EXIT:$?"',
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, OPENCLAW_STATE_DIR: configDir },
        },
      );

      expect(result.status).toBe(0);
      // The guard preserves the underlying nonzero doctor exit code.
      expect(result.stdout).toContain("GUARD_EXIT:7");
      // ...and still restores the mutable contract afterwards.
      expect(modeBits(configDir)).toBe(0o2770);
      expect(modeBits(configFile)).toBe(0o660);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emitted openclaw() guard restores the contract even under an inherited `set -e`", () => {
    // Regression for the errexit gap: when the guard is sourced into a shell
    // with errexit on, a nonzero `doctor --fix` must not abort openclaw()
    // before the restore runs. The top-level call aborts the script (expected),
    // but the perms must already be restored from inside the function.
    const { tmpDir, configDir, configFile } = seedTightenedConfigTree();
    fs.chmodSync(configDir, 0o2770);
    fs.chmodSync(configFile, 0o660);
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -e",
            mutableSandboxOwnerStatShim(),
            "command() {",
            '  if [ "${1:-}" = "openclaw" ]; then',
            '    chmod 700 "$OPENCLAW_STATE_DIR";',
            '    chmod 600 "$OPENCLAW_STATE_DIR/openclaw.json";',
            "    return 7;",
            "  fi",
            '  builtin command "$@";',
            "}",
            extractGuardBlock(src),
            "openclaw doctor --fix",
            'echo "UNREACHABLE_UNDER_ERREXIT"',
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, OPENCLAW_STATE_DIR: configDir },
        },
      );

      // Script aborts on the nonzero return (errexit), so the echo never runs...
      expect(result.stdout).not.toContain("UNREACHABLE_UNDER_ERREXIT");
      // ...but the in-function restore ran before the function returned.
      expect(modeBits(configDir)).toBe(0o2770);
      expect(modeBits(configFile)).toBe(0o660);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restore helper never leaves the recovery baseline group-writable", () => {
    // The recursive `chmod -R g+rwX` must not loosen the read-only recovery
    // trust anchor; the helper strips group-write from it afterwards (#4538).
    const { tmpDir, configDir } = seedTightenedConfigTree();
    const baseline = path.join(configDir, "openclaw.json.nemoclaw-baseline");
    fs.writeFileSync(baseline, "{}\n");
    fs.chmodSync(baseline, 0o440);
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            mutableSandboxOwnerStatShim(),
            extractShellFunctionFromSource(src, "_nemoclaw_restore_mutable_config_perms"),
            "_nemoclaw_restore_mutable_config_perms",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, OPENCLAW_STATE_DIR: configDir },
        },
      );

      expect(result.status).toBe(0);
      // Contract restored on the dir...
      expect(modeBits(configDir)).toBe(0o2770);
      // ...but the baseline must NOT be group-writable.
      expect(modeBits(baseline) & 0o020).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Reporter-workflow E2E against a real sandbox image (gated) ──────────────
// Runs the EXACT reported workflow — source the always-on guard (as a connect
// shell does), run raw `openclaw doctor --fix`, assert the contract survives —
// inside a real NemoClaw sandbox image with the real OpenClaw CLI. Gated so it
// only runs where docker + the image are available (locally, or a pipeline job):
//   NEMOCLAW_RUN_DOCTOR_PERMS_DOCKER_E2E=1 npx vitest run test/repro-4538-raw-doctor-perms.test.ts
const RUN_DOCKER_E2E = process.env.NEMOCLAW_RUN_DOCTOR_PERMS_DOCKER_E2E === "1";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

function resolveSandboxImage(): string | null {
  const candidates = [
    process.env.NEMOCLAW_DOCTOR_PERMS_E2E_IMAGE,
    "nemoclaw-production:latest",
    "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
  ].filter((v): v is string => Boolean(v));
  for (const image of candidates) {
    try {
      execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15000 });
      return image;
    } catch {
      /* try next */
    }
  }
  return null;
}

describe.skipIf(!RUN_DOCKER_E2E || !dockerAvailable())(
  "#4538 reporter workflow E2E (real sandbox image, raw openclaw doctor --fix)",
  () => {
    it("restores 2770/660 after a connect-shell `openclaw doctor --fix`", () => {
      const image = resolveSandboxImage();
      if (!image) {
        throw new Error(
          "No sandbox image found. Build/pull nemoclaw-production:latest or set NEMOCLAW_DOCTOR_PERMS_E2E_IMAGE.",
        );
      }
      const src = fs.readFileSync(START_SCRIPT, "utf-8");
      // Pass the guard via a base64 env var and decode in-container, so it never
      // depends on host file/dir traversal perms for the sandbox uid.
      const guardB64 = Buffer.from(extractGuardBlock(src), "utf-8").toString("base64");
      const script = [
        "set -u",
        'stat -c "%n %a %U:%G" /sandbox/.openclaw /sandbox/.openclaw/openclaw.json',
        // Materialize and source the always-on guard exactly as /etc/bash.bashrc
        // sources /tmp/nemoclaw-proxy-env.sh on connect.
        'printf "%s" "$NEMOCLAW_GUARD_B64" | base64 -d > /tmp/guard.sh',
        ". /tmp/guard.sh",
        // The exact reporter command.
        "openclaw doctor --fix >/tmp/doctor.log 2>&1 || true",
        'dirmode=$(stat -c "%a" /sandbox/.openclaw)',
        'filemode=$(stat -c "%a" /sandbox/.openclaw/openclaw.json)',
        'echo "RESULT dir=$dirmode file=$filemode"',
        '[ "$dirmode" = "2770" ] && [ "$filemode" = "660" ] && echo PASS || { echo FAIL; exit 1; }',
      ].join("\n");
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--entrypoint",
          "bash",
          "-u",
          "sandbox",
          "-e",
          "HOME=/sandbox",
          "-e",
          "OPENCLAW_HOME=/sandbox",
          "-e",
          "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
          "-e",
          "OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json",
          "-e",
          `NEMOCLAW_GUARD_B64=${guardB64}`,
          image,
          "-lc",
          script,
        ],
        { encoding: "utf-8", timeout: 180000 },
      );
      // Surface logs for the acceptance gate.
      process.stderr.write(`\n[#4538 E2E image=${image}]\n${result.stdout}\n${result.stderr}\n`);
      expect(result.stdout).toContain("PASS");
      expect(result.status).toBe(0);
    }, 200000);
  },
);
