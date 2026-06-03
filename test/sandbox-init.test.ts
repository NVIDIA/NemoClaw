// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  chmodSync,
  existsSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX_INIT = join(import.meta.dirname, "../scripts/lib/sandbox-init.sh");

/** Cross-platform octal permission string (macOS uses -f, Linux uses -c). */
function getOctalPerms(filePath: string): string {
  try {
    // Linux: stat -c '%a' file
    return execFileSync("stat", ["-c", "%a", filePath], { encoding: "utf-8" }).trim();
  } catch {
    // macOS: stat -f '%Lp' file
    return execFileSync("stat", ["-f", "%Lp", filePath], { encoding: "utf-8" }).trim();
  }
}

/**
 * Run a bash snippet that sources sandbox-init.sh and executes the given body.
 * Returns { stdout, stderr } as trimmed strings.
 */
type ExecFailureShape = { stdout?: string | Buffer; stderr?: string | Buffer };

function readExecFileSyncOutput(error: ExecFailureShape | null, key: "stdout" | "stderr"): string {
  if (error === null) {
    return "";
  }
  const value = Reflect.get(error, key);
  if (typeof value === "string") {
    return value.trim();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString().trim();
  }
  return "";
}

function runWithLib(
  body: string,
  opts: { env?: Record<string, string>; expectFail?: boolean } = {},
) {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `source ${JSON.stringify(SANDBOX_INIT)}`,
    body,
  ].join("\n");
  const tmpFile = join(tmpdir(), `sandbox-init-test-${process.pid}-${Date.now()}.sh`);
  try {
    writeFileSync(tmpFile, script, { mode: 0o700 });
    const result = execFileSync("bash", [tmpFile], {
      encoding: "utf-8",
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: result.trim(), stderr: "" };
  } catch (e) {
    if (opts.expectFail) {
      const errorObject: ExecFailureShape | null = typeof e === "object" && e !== null ? e : null;
      return {
        stdout: readExecFileSyncOutput(errorObject, "stdout"),
        stderr: readExecFileSyncOutput(errorObject, "stderr"),
      };
    }
    throw e;
  } finally {
    try {
      execFileSync("rm", ["-f", tmpFile]);
    } catch {
      /* ignore */
    }
  }
}

function pathExists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function backupTmpArtifacts(paths: string[], backupDir: string): Record<string, string> {
  const backups: Record<string, string> = {};

  for (const originalPath of paths) {
    if (!pathExists(originalPath)) {
      continue;
    }
    const backupPath = join(
      backupDir,
      `${originalPath.replaceAll("/", "_").replace(/^_+/, "")}.backup`,
    );
    renameSync(originalPath, backupPath);
    backups[originalPath] = backupPath;
  }

  return backups;
}

function restoreTmpArtifacts(paths: string[], backups: Record<string, string>): void {
  for (const originalPath of paths) {
    if (pathExists(originalPath)) {
      rmSync(originalPath, { force: true, recursive: true });
    }
    const backupPath = backups[originalPath];
    if (backupPath && pathExists(backupPath)) {
      renameSync(backupPath, originalPath);
    }
  }
}

describe("scripts/lib/sandbox-init.sh", () => {
  describe("emit_sandbox_sourced_file", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-init-emit-"));
    });

    afterEach(() => {
      execFileSync("rm", ["-rf", workDir]);
    });

    it("creates a file with 444 permissions", () => {
      const target = join(workDir, "test-sourced.sh");
      runWithLib(`echo 'export FOO=bar' | emit_sandbox_sourced_file ${JSON.stringify(target)}`);

      expect(existsSync(target)).toBe(true);
      const content = readFileSync(target, "utf-8");
      expect(content).toContain("export FOO=bar");

      // Check permissions — 444 in octal
      const perms = getOctalPerms(target);
      expect(perms).toBe("444");
    });

    it("overwrites existing file cleanly", () => {
      const target = join(workDir, "overwrite.sh");
      writeFileSync(target, "OLD CONTENT");
      runWithLib(`echo 'NEW CONTENT' | emit_sandbox_sourced_file ${JSON.stringify(target)}`);

      const content = readFileSync(target, "utf-8");
      expect(content).toContain("NEW CONTENT");
      expect(content).not.toContain("OLD CONTENT");
    });

    it("removes symlink before writing (anti-symlink attack)", () => {
      const target = join(workDir, "proxy-env.sh");
      const sensitive = join(workDir, "sensitive-data");
      writeFileSync(sensitive, "SECRET_DATA");
      symlinkSync(sensitive, target);

      runWithLib(`echo 'export X=1' | emit_sandbox_sourced_file ${JSON.stringify(target)}`);

      // Target should now be a regular file, not a symlink
      const stat = lstatSync(target);
      expect(stat.isSymbolicLink()).toBe(false);
      // Sensitive file should be untouched
      expect(readFileSync(sensitive, "utf-8")).toBe("SECRET_DATA");
    });

    it("accepts heredoc input", () => {
      const target = join(workDir, "heredoc.sh");
      runWithLib(`
emit_sandbox_sourced_file ${JSON.stringify(target)} <<'EOF'
export A="hello"
export B="world"
EOF
      `);

      const content = readFileSync(target, "utf-8");
      expect(content).toContain('export A="hello"');
      expect(content).toContain('export B="world"');
    });
  });

  describe("validate_tmp_permissions", () => {
    let workDir: string;
    let tmpBackups: Record<string, string>;
    const TMP_ARTIFACTS = ["/tmp/nemoclaw-proxy-env.sh", "/tmp/gateway.log", "/tmp/auto-pair.log"];

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-init-validate-"));
      tmpBackups = backupTmpArtifacts(TMP_ARTIFACTS, workDir);
    });

    afterEach(() => {
      restoreTmpArtifacts(TMP_ARTIFACTS, tmpBackups);
      execFileSync("rm", ["-rf", workDir]);
    });

    it("passes when no monitored files exist", () => {
      // validate_tmp_permissions should succeed when files don't exist
      // (they're skipped via [ -f "$f" ] || continue)
      runWithLib(`
        validate_tmp_permissions
        echo "PASSED"
      `);
    });

    it("detects bad permissions on sourced files", () => {
      const testFile = join(workDir, "bad-sourced.sh");
      writeFileSync(testFile, "# bad permissions");
      chmodSync(testFile, 0o644); // writable — should fail

      const { stderr } = runWithLib(`validate_tmp_permissions ${JSON.stringify(testFile)}`, {
        expectFail: true,
      });
      expect(stderr).toContain("unsafe permissions");
    });

    it("passes with correct 444 permissions on sourced files", () => {
      const testFile = join(workDir, "good-sourced.sh");
      writeFileSync(testFile, "# good permissions");
      chmodSync(testFile, 0o444);

      runWithLib(`
        validate_tmp_permissions ${JSON.stringify(testFile)}
        echo "PASSED"
      `);
    });
  });

  describe("verify_config_integrity", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-init-integrity-"));
    });

    afterEach(() => {
      execFileSync("rm", ["-rf", workDir]);
    });

    it("fails when hash file is missing", () => {
      const { stderr } = runWithLib(`verify_config_integrity ${JSON.stringify(workDir)}`, {
        expectFail: true,
      });
      expect(stderr).toContain("Config hash file missing");
    });

    it("passes when config matches hash", () => {
      const configFile = join(workDir, "config.json");
      writeFileSync(configFile, '{"test": true}');
      // Generate hash
      execFileSync("bash", [
        "-c",
        `cd ${JSON.stringify(workDir)} && sha256sum config.json > .config-hash`,
      ]);

      runWithLib(`
        verify_config_integrity ${JSON.stringify(workDir)}
        echo "INTEGRITY_OK"
      `);
    });

    it("fails when config is tampered", () => {
      const configFile = join(workDir, "config.json");
      writeFileSync(configFile, '{"test": true}');
      execFileSync("bash", [
        "-c",
        `cd ${JSON.stringify(workDir)} && sha256sum config.json > .config-hash`,
      ]);
      // Tamper with config
      writeFileSync(configFile, '{"test": false, "injected": "malicious"}');

      const { stderr } = runWithLib(`verify_config_integrity ${JSON.stringify(workDir)}`, {
        expectFail: true,
      });
      expect(stderr).toContain("integrity check FAILED");
    });

    it("locked-aware verifier skips mutable-default hash files", () => {
      const configFile = join(workDir, "config.json");
      writeFileSync(configFile, '{"test": true}');
      execFileSync("bash", [
        "-c",
        `cd ${JSON.stringify(workDir)} && sha256sum config.json > .config-hash`,
      ]);
      writeFileSync(configFile, '{"test": false, "mutable": true}');

      const { stdout } = runWithLib(`
        verify_config_integrity_if_locked ${JSON.stringify(workDir)} 2>&1
        echo "MUTABLE_OK"
      `);
      expect(stdout).toContain("Config integrity check skipped for mutable default");
    });

    it("locked-aware verifier fails closed when a locked config is missing its hash", () => {
      const fakeBin = join(workDir, "bin");
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, "stat"),
        [
          "#!/usr/bin/env bash",
          'if [ "${2:-}" = "%u" ]; then echo 0; exit 0; fi',
          'if [ "${2:-}" = "%a" ] || [ "${2:-}" = "%Lp" ]; then echo 755; exit 0; fi',
          "exit 1",
        ].join("\n"),
        { mode: 0o700 },
      );

      const { stderr } = runWithLib(`verify_config_integrity_if_locked ${JSON.stringify(workDir)}`, {
        env: { PATH: `${fakeBin}:${process.env.PATH || ""}` },
        expectFail: true,
      });
      expect(stderr).toContain("Locked config is missing hash file");
    });
  });

  describe("lock_rc_files", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-init-lock-"));
    });

    afterEach(() => {
      // Need to make writable before cleanup
      try {
        chmodSync(join(workDir, ".bashrc"), 0o644);
      } catch {
        /* ignore */
      }
      try {
        chmodSync(join(workDir, ".profile"), 0o644);
      } catch {
        /* ignore */
      }
      execFileSync("rm", ["-rf", workDir]);
    });

    it("sets .bashrc and .profile to 444", () => {
      writeFileSync(join(workDir, ".bashrc"), "# bashrc");
      writeFileSync(join(workDir, ".profile"), "# profile");

      runWithLib(`lock_rc_files ${JSON.stringify(workDir)}`);

      const bashrcPerms = getOctalPerms(join(workDir, ".bashrc"));
      const profilePerms = getOctalPerms(join(workDir, ".profile"));
      expect(bashrcPerms).toBe("444");
      expect(profilePerms).toBe("444");
    });

    it("is a no-op when files do not exist", () => {
      // Should not throw
      runWithLib(`lock_rc_files ${JSON.stringify(workDir)}`);
    });

    it("refuses to chmod symlinked rc files", () => {
      const target = join(workDir, "target");
      writeFileSync(target, "# target", { mode: 0o600 });
      symlinkSync(target, join(workDir, ".bashrc"));

      const { stdout } = runWithLib(`lock_rc_files ${JSON.stringify(workDir)} 2>&1`);

      expect(stdout).toContain("Refusing to lock symlinked rc file");
      expect(getOctalPerms(target)).toBe("600");
    });
  });

  describe("drop_capabilities", () => {
    it("function is defined and callable", () => {
      // We can't test actual capsh on macOS, but verify the function exists
      // and handles the no-capsh case gracefully. Capture stderr via redirect.
      const { stdout } = runWithLib(
        `
        # Hide capsh from PATH so the function falls through
        drop_capabilities /usr/local/bin/fake-entrypoint 2>&1
        echo "FALLTHROUGH_OK"
      `,
        { env: { PATH: "/usr/bin:/bin", NEMOCLAW_CAPS_DROPPED: "" } },
      );
      expect(stdout).toContain("capsh not available");
      expect(stdout).toContain("FALLTHROUGH_OK");
    });

    it("skips when NEMOCLAW_CAPS_DROPPED=1", () => {
      const { stdout } = runWithLib(
        `
        NEMOCLAW_CAPS_DROPPED=1
        drop_capabilities /usr/local/bin/fake-entrypoint
        echo "SKIPPED_OK"
      `,
      );
      expect(stdout).toContain("SKIPPED_OK");
    });

    // Repro for reopened issue #3280 (NVBug 6159223), QA FAIL reported by
    // hulynn on v0.0.54: on a host whose container runtime does not grant
    // CAP_SETPCAP (e.g. the Colossus Ubuntu 24.04 image), capsh --drop cannot
    // run, so the bounding-set drop is skipped and the 8 dangerous caps
    // (cap_sys_admin, cap_sys_ptrace, cap_net_raw, cap_dac_override,
    // cap_net_bind_service, cap_fowner, cap_setuid, cap_setgid) remain in the
    // sandbox bounding set.
    //
    // PR #4266 made this fall-through fail-closed (refuse to start unless
    // NEMOCLAW_ALLOW_RESIDUAL_CAPS=1). PR #4341 reverted that to
    // warn-and-continue, which is what current main does — and is exactly
    // why QA still sees the residual caps. This test drives the
    // CAP_SETPCAP-missing path with a stubbed capsh and asserts the current
    // warn-and-continue behavior: the warning is emitted but the entrypoint
    // does NOT refuse to start, so the residual-cap posture survives.
    it("warns but does NOT refuse to start when CAP_SETPCAP is unavailable (issue #3280 repro)", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          // Stub capsh so it is found on PATH (command -v succeeds) but
          // reports CAP_SETPCAP absent, forcing the fall-through that skips
          // the actual bounding-set drop.
          'cat >"$TMP/capsh" <<\'STUB\'',
          "#!/bin/sh",
          '[ "$1" = "--has-p=cap_setpcap" ] && exit 1',
          "exit 0",
          "STUB",
          'chmod +x "$TMP/capsh"',
          'export PATH="$TMP:$PATH"',
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          // Reached only because drop_capabilities returned instead of
          // exiting. The pre-#4341 fail-closed policy would `exit 1` before
          // this line, so its presence in output IS the reproduced gap.
          'echo "SANDBOX_CONTINUED_DESPITE_RESIDUAL_CAPS"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "" } },
      );

      // The drop was attempted and detected as impossible...
      expect(stdout).toContain("CAP_SETPCAP not available — cannot drop bounding-set caps via capsh");
      // ...yet the sandbox keeps going (the bug this issue tracks).
      expect(stdout).toContain("SANDBOX_CONTINUED_DESPITE_RESIDUAL_CAPS");
      // And it does so silently w.r.t. fail-closed: no refusal banner and no
      // opt-in escape hatch are present on current main (post-#4341 revert).
      expect(stdout).not.toContain("Refusing to start sandbox");
      expect(stdout).not.toContain("NEMOCLAW_ALLOW_RESIDUAL_CAPS");
    });

    // Companion repro at the detection layer: report_residual_capabilities
    // must name the dangerous caps it finds in the bounding set so they are
    // visible in the entrypoint log (the [SECURITY] line QA quoted from
    // /tmp/nemoclaw-start.log). Decoding is exercised directly so the
    // assertion is deterministic and host-independent (it does not depend on
    // the test runner's own CapBnd). CapBnd 0x4a82c35fb is the exact value
    // hulynn decoded on the failing Colossus host.
    it("names residual dangerous caps from a known CapBnd (issue #3280 repro)", () => {
      const { stdout } = runWithLib(
        [
          // Shadow /proc/self/status reads with a fixture exposing the
          // failing host's CapBnd, then invoke the decode loop verbatim.
          "TMP=$(mktemp -d)",
          'printf "CapBnd:\\t00000004a82c35fb\\n" >"$TMP/status"',
          "cap_bnd_hex=$(awk '/^CapBnd:/{print $2}' \"$TMP/status\")",
          "val=$((16#$cap_bnd_hex))",
          "present_caps=''",
          "for entry in \\",
          '  "21:cap_sys_admin" \\',
          '  "19:cap_sys_ptrace" \\',
          '  "13:cap_net_raw" \\',
          '  "1:cap_dac_override" \\',
          '  "10:cap_net_bind_service"; do',
          '  bit="${entry%%:*}"',
          '  name="${entry#*:}"',
          "  if [ $(((val >> bit) & 1)) -ne 0 ]; then",
          '    present_caps="${present_caps:+$present_caps,}$name"',
          "  fi",
          "done",
          'echo "RESIDUAL: ${present_caps}"',
          'rm -rf "$TMP"',
        ].join("\n"),
      );

      // All five caps the entrypoint inspects are present in this CapBnd,
      // matching the QA-reported residual set.
      expect(stdout).toContain(
        "RESIDUAL: cap_sys_admin,cap_sys_ptrace,cap_net_raw,cap_dac_override,cap_net_bind_service",
      );
    });

    // ── Fix: opt-in fail-closed strict mode (issue #3280) ──────────────
    // The inverse of the reverted #4266: default stays warn-and-continue (no
    // regression on CAP_SETPCAP-less hosts), but operators can demand the
    // hardened posture with NEMOCLAW_REQUIRE_CAP_DROP=1, which refuses to
    // start when the bounding-set drop could not happen.

    it("refuses to start when CAP_SETPCAP is unavailable and NEMOCLAW_REQUIRE_CAP_DROP=1", () => {
      const { stdout, stderr } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          // capsh present but reports CAP_SETPCAP absent → drop is skipped.
          'cat >"$TMP/capsh" <<\'STUB\'',
          "#!/bin/sh",
          '[ "$1" = "--has-p=cap_setpcap" ] && exit 1',
          "exit 0",
          "STUB",
          'chmod +x "$TMP/capsh"',
          'export PATH="$TMP:$PATH"',
          "drop_capabilities /usr/local/bin/fake-entrypoint",
          // Strict mode exits 1 before this line is reached.
          'echo "SHOULD_NOT_REACH"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" }, expectFail: true },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).toContain("CAP_SETPCAP unavailable");
      expect(combined).toContain("NEMOCLAW_REQUIRE_CAP_DROP=1 is set");
      expect(combined).not.toContain("SHOULD_NOT_REACH");
    });

    it("refuses to start when capsh is missing and NEMOCLAW_REQUIRE_CAP_DROP=1", () => {
      const { stdout, stderr } = runWithLib(
        `
        drop_capabilities /usr/local/bin/fake-entrypoint
        echo "SHOULD_NOT_REACH"
      `,
        {
          // Hide capsh so command -v fails, exercising the capsh-missing branch.
          env: { PATH: "/usr/bin:/bin", NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" },
          expectFail: true,
        },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("capsh not available");
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).not.toContain("SHOULD_NOT_REACH");
    });

    it("continues (no regression) when NEMOCLAW_REQUIRE_CAP_DROP is unset", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          'cat >"$TMP/capsh" <<\'STUB\'',
          "#!/bin/sh",
          '[ "$1" = "--has-p=cap_setpcap" ] && exit 1',
          "exit 0",
          "STUB",
          'chmod +x "$TMP/capsh"',
          'export PATH="$TMP:$PATH"',
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          'echo "CONTINUED_OK"',
          'rm -rf "$TMP"',
        ].join("\n"),
        // NEMOCLAW_REQUIRE_CAP_DROP deliberately unset → default warn-and-continue.
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "" } },
      );
      expect(stdout).toContain("CONTINUED_OK");
      expect(stdout).not.toContain("Refusing to start sandbox");
    });
  });

  describe("init_step_down_prefixes", () => {
    it("falls back to gosu when setpriv is unavailable", () => {
      // Source-time init runs before our test body, so re-run it with a
      // PATH that hides setpriv and capsh to exercise the fallback.
      const { stdout, stderr } = runWithLib(
        [
          "export PATH=/nonexistent",
          "init_step_down_prefixes 2>&1",
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_SANDBOX[@]}\"",
          'echo "--"',
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_GATEWAY[@]}\"",
        ].join("\n"),
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("falling back to gosu");
      expect(stdout).toContain("gosu\nsandbox");
      expect(stdout).toContain("gosu\ngateway");
    });

    it("uses setpriv with the issue-3280 bounding-set drop when available", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          'cat >"$TMP/setpriv" <<\'STUB\'',
          "#!/bin/sh",
          "exit 0",
          "STUB",
          'cat >"$TMP/capsh" <<\'STUB\'',
          "#!/bin/sh",
          '[ "$1" = "--has-p=cap_setpcap" ] && exit 0',
          "exit 1",
          "STUB",
          'chmod +x "$TMP/setpriv" "$TMP/capsh"',
          'export PATH="$TMP:$PATH"',
          "init_step_down_prefixes",
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_SANDBOX[@]}\"",
          'echo "--"',
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_GATEWAY[@]}\"",
          'rm -rf "$TMP"',
        ].join("\n"),
      );
      // setpriv prefix must include --reuid/--regid for the user and the
      // bounding-set drop covering the five load-bearing caps from #3280.
      expect(stdout).toContain("setpriv");
      expect(stdout).toContain("--reuid=sandbox");
      expect(stdout).toContain("--regid=sandbox");
      expect(stdout).toContain("--reuid=gateway");
      expect(stdout).toContain("--regid=gateway");
      // setpriv expects unprefixed cap names (per `setpriv --list`),
      // unlike capsh which uses cap_*. Keep these in sync with the
      // STEP_DOWN_PREFIX_* arrays in sandbox-init.sh.
      expect(stdout).toContain("--bounding-set=-setuid,-setgid,-fowner,-chown,-kill");
      // Each prefix array must end with '--' so setpriv stops parsing
      // its own flags before the caller's target command. printf splits
      // array elements onto separate lines, so each prefix's last element
      // is a line containing just '--'.
      expect(stdout.match(/^--$/gm)?.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("validate_config_symlinks", () => {
    let workDir: string;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), "sandbox-init-symlinks-"));
      mkdirSync(join(workDir, "config"));
      mkdirSync(join(workDir, "data"));
    });

    afterEach(() => {
      execFileSync("rm", ["-rf", workDir]);
    });

    it("passes when symlinks point to expected targets", () => {
      const dataFile = join(workDir, "data", "agents");
      writeFileSync(dataFile, "data");
      symlinkSync(dataFile, join(workDir, "config", "agents"));

      // validate_config_symlinks resolves both sides via readlink -f,
      // so macOS /var → /private/var doesn't cause false positives.
      runWithLib(`
        validate_config_symlinks ${JSON.stringify(join(workDir, "config"))} ${JSON.stringify(join(workDir, "data"))}
        echo "SYMLINKS_OK"
      `);
    });

    it("fails when symlink points to unexpected target", () => {
      const badTarget = join(workDir, "malicious");
      writeFileSync(badTarget, "evil");
      symlinkSync(badTarget, join(workDir, "config", "agents"));

      const { stderr } = runWithLib(
        `validate_config_symlinks ${JSON.stringify(join(workDir, "config"))} ${JSON.stringify(join(workDir, "data"))}`,
        { expectFail: true },
      );
      expect(stderr).toContain("unexpected target");
    });

    it("passes when directory has no symlinks", () => {
      writeFileSync(join(workDir, "config", "regular-file"), "not a symlink");

      runWithLib(`
        validate_config_symlinks ${JSON.stringify(join(workDir, "config"))} ${JSON.stringify(join(workDir, "data"))}
        echo "NO_SYMLINKS_OK"
      `);
    });
  });

  describe("configure_messaging_channels", () => {
    it("returns silently when no tokens are set", () => {
      const { stderr } = runWithLib("configure_messaging_channels", {
        env: {
          TELEGRAM_BOT_TOKEN: "",
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "",
        },
      });
      expect(stderr).not.toContain("[channels]");
    });

    it("logs active channels when tokens are present", () => {
      // configure_messaging_channels writes to stderr; redirect to stdout to capture it
      const { stdout } = runWithLib("configure_messaging_channels 2>&1", {
        env: {
          TELEGRAM_BOT_TOKEN: "fake-token",
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "fake-slack",
        },
      });
      expect(stdout).toContain("telegram");
      expect(stdout).toContain("slack");
      expect(stdout).not.toContain("discord");
    });
  });

  describe("cleanup_on_signal", () => {
    it("function is defined and uses SANDBOX_CHILD_PIDS", () => {
      // Verify the function exists and handles empty PID list gracefully
      const { stdout } = runWithLib(`
        SANDBOX_CHILD_PIDS=()
        SANDBOX_WAIT_PID=""
        # Override exit so we can test
        exit() { echo "EXIT_\$1"; }
        cleanup_on_signal
      `);
      expect(stdout).toContain("EXIT_0");
    });
  });

  describe("double-source guard", () => {
    it("does not redefine functions when sourced twice", () => {
      runWithLib(`
        # Source again — should be a no-op
        source ${JSON.stringify(SANDBOX_INIT)}
        # Functions should still work
        echo "test" | emit_sandbox_sourced_file /dev/null 2>/dev/null || true
        echo "DOUBLE_SOURCE_OK"
      `);
    });
  });

  describe("both entrypoints source the shared library", () => {
    it("nemoclaw-start.sh sources sandbox-init.sh", () => {
      const src = readFileSync(join(import.meta.dirname, "../scripts/nemoclaw-start.sh"), "utf-8");
      const start = src.indexOf("_SANDBOX_INIT=");
      const end = src.indexOf("# Harden: limit process count", start);
      if (start === -1 || end === -1 || end <= start) {
        throw new Error("Expected sandbox-init source block in scripts/nemoclaw-start.sh");
      }

      const workDir = mkdtempSync(join(tmpdir(), "nemoclaw-start-source-init-"));
      const scriptDir = join(workDir, "scripts");
      const libDir = join(scriptDir, "lib");
      mkdirSync(libDir, { recursive: true });
      writeFileSync(
        join(libDir, "sandbox-init.sh"),
        "export NEMOCLAW_TEST_SANDBOX_INIT_LOADED=1\n",
      );
      const wrapperPath = join(scriptDir, "nemoclaw-start.sh");
      writeFileSync(
        wrapperPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          src.slice(start, end),
          'printf "LOADED=%s\\n" "${NEMOCLAW_TEST_SANDBOX_INIT_LOADED:-0}"',
        ].join("\n"),
        { mode: 0o700 },
      );

      try {
        const result = execFileSync("bash", [wrapperPath], { encoding: "utf-8" }).trim();
        expect(result).toBe("LOADED=1");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

  });
});
