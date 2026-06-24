// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    const TMP_ARTIFACTS = [
      "/tmp/nemoclaw-proxy-env.sh",
      "/tmp/gateway.log",
      "/tmp/auto-pair.log",
      "/tmp/nemoclaw-plugin-refresh.log",
    ];

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

    it("rejects a symlinked plugin refresh log", () => {
      const pluginRefreshLog = join(workDir, "nemoclaw-plugin-refresh.log");
      const target = join(workDir, "plugin-refresh-target.log");
      writeFileSync(target, "do not truncate");
      symlinkSync(target, pluginRefreshLog);

      const { stderr } = runWithLib("validate_tmp_permissions", {
        env: { PLUGIN_REFRESH_LOG: pluginRefreshLog },
        expectFail: true,
      });
      expect(stderr).toContain(`${pluginRefreshLog} is a symlink`);
      expect(readFileSync(target, "utf-8")).toBe("do not truncate");
    });

    it("keeps the plugin refresh log private", () => {
      const pluginRefreshLog = join(workDir, "nemoclaw-plugin-refresh.log");
      writeFileSync(pluginRefreshLog, "refresh output");
      chmodSync(pluginRefreshLog, 0o644);

      const { stderr } = runWithLib("validate_tmp_permissions", {
        env: { PLUGIN_REFRESH_LOG: pluginRefreshLog },
        expectFail: true,
      });
      expect(stderr).toContain(`${pluginRefreshLog} has unexpected permissions`);
      expect(stderr).toContain("expected 600");
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

      const { stderr } = runWithLib(
        `verify_config_integrity_if_locked ${JSON.stringify(workDir)}`,
        {
          env: { PATH: `${fakeBin}:${process.env.PATH || ""}` },
          expectFail: true,
        },
      );
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

    // Context for reopened issue #3280 (NVBug 6159223), QA FAIL reported by
    // hulynn on v0.0.54: on a host whose container runtime does not grant
    // CAP_SETPCAP (e.g. the Colossus Ubuntu 24.04 image), capsh --drop cannot
    // run, so the bounding-set drop is skipped and the dangerous caps
    // (cap_sys_admin, cap_sys_ptrace, cap_net_raw, cap_dac_override,
    // cap_net_bind_service, ...) remain in the bounding set.
    //
    // The strict-mode tests below use NEMOCLAW_PROC_STATUS — a test seam in
    // sandbox-init.sh — to feed a known CapBnd fixture, so they exercise the
    // real enforcement against a controlled bounding set without depending on
    // the test runner's own /proc/self/status. CapBnd 0x4a82c35fb is the exact
    // value hulynn decoded on the failing Colossus host.
    const QA_CAPBND = "00000004a82c35fb"; // contains all 10 inspected dangerous caps
    const CLEAN_CAPBND = "0000000000000000"; // none present
    const QA_DANGEROUS =
      "cap_sys_admin,cap_sys_ptrace,cap_net_raw,cap_dac_override,cap_sys_chroot,cap_fsetid,cap_setfcap,cap_mknod,cap_audit_write,cap_net_bind_service";

    // Stub capsh so it is found on PATH (command -v succeeds) but reports
    // CAP_SETPCAP absent, forcing the fall-through that skips the real drop.
    const capshNoSetpcapStub = [
      "cat >\"$TMP/capsh\" <<'STUB'",
      "#!/bin/sh",
      '[ "$1" = "--has-p=cap_setpcap" ] && exit 1',
      "exit 0",
      "STUB",
      'chmod +x "$TMP/capsh"',
      'export PATH="$TMP:$PATH"',
    ];
    const writeStatusFixture = (capbndHex: string) => [
      `printf 'CapBnd:\\t${capbndHex}\\n' >"$TMP/status"`,
      'export NEMOCLAW_PROC_STATUS="$TMP/status"',
    ];

    // Default (no NEMOCLAW_REQUIRE_CAP_DROP): warns and CONTINUES even though
    // dangerous caps remain — preserving the zero-regression posture for
    // CAP_SETPCAP-less hosts. report_residual_capabilities still names them.
    it("warns but does NOT refuse to start when CAP_SETPCAP is unavailable (issue #3280)", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...capshNoSetpcapStub,
          ...writeStatusFixture(QA_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          'echo "SANDBOX_CONTINUED_DESPITE_RESIDUAL_CAPS"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "" } },
      );
      expect(stdout).toContain(
        "CAP_SETPCAP not available — cannot drop bounding-set caps via capsh",
      );
      expect(stdout).toContain(`Dangerous caps remain in bounding set: ${QA_DANGEROUS}`);
      expect(stdout).toContain("SANDBOX_CONTINUED_DESPITE_RESIDUAL_CAPS");
      expect(stdout).not.toContain("Refusing to start sandbox");
    });

    // Exercise the REAL decode function (not a copy of its loop) so future
    // drift in dangerous_caps_in_capbnd is caught.
    it("dangerous_caps_in_capbnd decodes the inspected caps from a CapBnd hex", () => {
      const { stdout } = runWithLib(
        [
          `echo "DANGEROUS:[$(dangerous_caps_in_capbnd ${QA_CAPBND})]"`,
          `echo "CLEAN:[$(dangerous_caps_in_capbnd ${CLEAN_CAPBND})]"`,
        ].join("\n"),
      );
      expect(stdout).toContain(`DANGEROUS:[${QA_DANGEROUS}]`);
      expect(stdout).toContain("CLEAN:[]");
    });

    // ── Fix: opt-in fail-closed strict mode (issue #3280) ──────────────
    // The inverse of the reverted #4266: default stays warn-and-continue (no
    // regression), but NEMOCLAW_REQUIRE_CAP_DROP=1 refuses to start unless the
    // ACTUAL bounding set is provably free of the dangerous caps.

    it("refuses to start when REQUIRE_CAP_DROP=1 and dangerous caps remain (CAP_SETPCAP path)", () => {
      const { stdout, stderr } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...capshNoSetpcapStub,
          ...writeStatusFixture(QA_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint",
          'echo "SHOULD_NOT_REACH"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" }, expectFail: true },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).toContain(
        `dangerous caps remain in bounding set (CapBnd=${QA_CAPBND}): ${QA_DANGEROUS}`,
      );
      expect(combined).not.toContain("SHOULD_NOT_REACH");
    });

    it("refuses to start when REQUIRE_CAP_DROP=1 and capsh is missing", () => {
      const { stdout, stderr } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...writeStatusFixture(QA_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint",
          'echo "SHOULD_NOT_REACH"',
          'rm -rf "$TMP"',
        ].join("\n"),
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

    // Regression for the sentinel-bypass finding: a pre-set NEMOCLAW_CAPS_DROPPED=1
    // must NOT let a host with residual caps slip past strict mode. The gate
    // verifies the actual bounding set, so it still refuses.
    it("refuses despite a pre-set NEMOCLAW_CAPS_DROPPED=1 when dangerous caps remain (strict)", () => {
      const { stdout, stderr } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...writeStatusFixture(QA_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint",
          'echo "BYPASSED_STRICT_MODE"',
          'rm -rf "$TMP"',
        ].join("\n"),
        {
          env: { NEMOCLAW_CAPS_DROPPED: "1", NEMOCLAW_REQUIRE_CAP_DROP: "1" },
          expectFail: true,
        },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).toContain("dangerous caps remain in bounding set");
      expect(combined).not.toContain("BYPASSED_STRICT_MODE");
    });

    // Strict mode trusts the verified state, not the fall-through: if the
    // bounding set is already clean it must NOT refuse.
    it("continues under REQUIRE_CAP_DROP=1 when the bounding set is already clean", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...capshNoSetpcapStub,
          ...writeStatusFixture(CLEAN_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          'echo "CONTINUED_CLEAN"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" } },
      );
      expect(stdout).toContain("CONTINUED_CLEAN");
      expect(stdout).not.toContain("Refusing to start sandbox");
    });

    it("refuses under REQUIRE_CAP_DROP=1 when the bounding set cannot be verified", () => {
      const { stdout, stderr } = runWithLib(
        `
        export NEMOCLAW_PROC_STATUS=/nonexistent/sandbox-init-status
        drop_capabilities /usr/local/bin/fake-entrypoint
        echo "SHOULD_NOT_REACH"
      `,
        {
          env: { PATH: "/usr/bin:/bin", NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" },
          expectFail: true,
        },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).toContain("could not read bounding set");
      expect(combined).not.toContain("SHOULD_NOT_REACH");
    });

    // Harden (issue #3280): a non-empty but unparseable CapBnd (corrupt /proc,
    // CRLF fixture, future format change) must be treated as "cannot verify"
    // — refusing in strict mode — and must NOT surface a raw bash arithmetic
    // error. MALFORMED_CAPBND contains non-hex characters.
    const MALFORMED_CAPBND = "00000000nothex0";
    it("refuses under REQUIRE_CAP_DROP=1 when CapBnd is non-empty but unparseable", () => {
      const { stdout, stderr } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...writeStatusFixture(MALFORMED_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint",
          'echo "SHOULD_NOT_REACH"',
          'rm -rf "$TMP"',
        ].join("\n"),
        {
          env: { PATH: "/usr/bin:/bin", NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "1" },
          expectFail: true,
        },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("Refusing to start sandbox");
      expect(combined).toContain("could not parse bounding set");
      expect(combined).not.toContain("SHOULD_NOT_REACH");
      // No leaked bash arithmetic error.
      expect(combined).not.toMatch(/value too great for base|invalid arithmetic|16#/);
    });

    it("warns and continues (no abort) on an unparseable CapBnd when REQUIRE_CAP_DROP is unset", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...capshNoSetpcapStub,
          ...writeStatusFixture(MALFORMED_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          'echo "CONTINUED_ON_BAD_CAPBND"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "" } },
      );
      expect(stdout).toContain("residual caps unknown");
      expect(stdout).toContain("CONTINUED_ON_BAD_CAPBND");
      expect(stdout).not.toContain("Refusing to start sandbox");
    });

    it("continues (no regression) when NEMOCLAW_REQUIRE_CAP_DROP is unset even with residual caps", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          ...capshNoSetpcapStub,
          ...writeStatusFixture(QA_CAPBND),
          "drop_capabilities /usr/local/bin/fake-entrypoint 2>&1",
          'echo "CONTINUED_OK"',
          'rm -rf "$TMP"',
        ].join("\n"),
        { env: { NEMOCLAW_CAPS_DROPPED: "", NEMOCLAW_REQUIRE_CAP_DROP: "" } },
      );
      expect(stdout).toContain("CONTINUED_OK");
      expect(stdout).not.toContain("Refusing to start sandbox");
    });
  });

  describe("harden_resource_limits", () => {
    // Shim `ulimit` (a bash builtin) by overriding it with a function inside the
    // sourced body. The function records each invocation so we can assert both
    // the nproc (#809) and nofile (#4527) caps are applied, soft-before-hard.
    it("applies nproc and nofile soft+hard limits in order", () => {
      const { stdout } = runWithLib(
        [
          // Override the ulimit builtin to record args and succeed.
          "ulimit() { printf 'ulimit %s\\n' \"$*\"; return 0; }",
          "harden_resource_limits",
        ].join("\n"),
      );
      const calls = stdout.split("\n").filter((line) => line.startsWith("ulimit "));
      expect(calls).toEqual([
        "ulimit -Su 512",
        "ulimit -Hu 512",
        "ulimit -Sn 65536",
        "ulimit -Hn 65536",
      ]);
    });

    it("is best-effort: exits 0 and warns when ulimit fails", () => {
      // Shim ulimit to always fail. The function must not abort (best-effort)
      // and must emit a [SECURITY] warning for each of the four limits.
      const { stdout } = runWithLib(
        ["ulimit() { return 1; }", "harden_resource_limits 2>&1", 'echo "HARDEN_OK"'].join("\n"),
      );
      expect(stdout).toContain("HARDEN_OK");
      expect(stdout).toContain("Could not set soft nproc limit");
      expect(stdout).toContain("Could not set hard nproc limit");
      expect(stdout).toContain("Could not set soft nofile limit");
      expect(stdout).toContain("Could not set hard nofile limit");
    });
  });

  describe("entrypoints call harden_resource_limits", () => {
    // Both entrypoints must delegate RLIMIT hardening to the shared helper and
    // must no longer carry the pre-#4527 raw inline `ulimit -Su 512` block.
    for (const rel of ["../scripts/nemoclaw-start.sh", "../agents/hermes/start.sh"]) {
      it(`${rel} calls harden_resource_limits and has no raw inline nproc block`, () => {
        const src = readFileSync(join(import.meta.dirname, rel), "utf-8");
        expect(src).toContain("harden_resource_limits");
        expect(src).not.toContain("ulimit -Su 512");
        expect(src).not.toContain("ulimit -Hu 512");
      });
    }

    // SECURITY (#4527): the RLIMIT caps are only unraisable if they are set
    // while still root PID 1, BEFORE drop_capabilities (capsh) and the
    // setpriv/gosu step-down. A refactor that moved the harden call after the
    // privilege drop would turn it into dead code (cap set as the unprivileged
    // agent, hard limit no longer lowered) while every other test stayed green.
    // Pin the ordering so that regression is caught.
    for (const rel of ["../scripts/nemoclaw-start.sh", "../agents/hermes/start.sh"]) {
      it(`${rel} calls harden_resource_limits before drop_capabilities`, () => {
        const src = readFileSync(join(import.meta.dirname, rel), "utf-8");
        // Anchor to executable command lines, not free-text, so a comment
        // mentioning either name cannot satisfy (or break) the ordering check.
        const hardenIdx = src.match(/^\s*harden_resource_limits\s*$/m)?.index ?? -1;
        const dropIdx = src.match(/^\s*drop_capabilities\b.*$/m)?.index ?? -1;
        expect(hardenIdx).toBeGreaterThanOrEqual(0);
        expect(dropIdx).toBeGreaterThanOrEqual(0);
        expect(hardenIdx).toBeLessThan(dropIdx);
      });
    }
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
          "cat >\"$TMP/setpriv\" <<'STUB'",
          "#!/bin/sh",
          "exit 0",
          "STUB",
          "cat >\"$TMP/capsh\" <<'STUB'",
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
    function messagingPlanEnv(channels: string[]): string {
      return Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          channels: channels.map((channelId) => ({
            channelId,
            active: true,
            disabled: false,
          })),
        }),
      ).toString("base64");
    }

    it("returns silently when no messaging plan is set", () => {
      const { stderr } = runWithLib("configure_messaging_channels", {
        env: { NEMOCLAW_MESSAGING_PLAN_B64: "" },
      });
      expect(stderr).not.toContain("[channels]");
    });

    it("logs active channels from the messaging plan", () => {
      // configure_messaging_channels writes to stderr; redirect to stdout to capture it
      const { stdout } = runWithLib("configure_messaging_channels 2>&1", {
        env: {
          NEMOCLAW_MESSAGING_PLAN_B64: messagingPlanEnv(["telegram", "slack"]),
        },
      });
      expect(stdout).toContain("telegram");
      expect(stdout).toContain("slack");
      expect(stdout).not.toContain("discord");
    });

    it("logs active channels from the baked runtime artifact when env plan is absent", () => {
      const workDir = mkdtempSync(join(tmpdir(), "nemoclaw-messaging-artifact-log-"));
      const artifactPath = join(workDir, "messaging-runtime-plan.json");
      writeFileSync(
        artifactPath,
        Buffer.from(messagingPlanEnv(["telegram", "whatsapp"]), "base64").toString("utf-8"),
      );

      try {
        const { stdout } = runWithLib("configure_messaging_channels 2>&1", {
          env: {
            NEMOCLAW_MESSAGING_PLAN_B64: "",
            NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: artifactPath,
          },
        });
        expect(stdout).toContain("telegram");
        expect(stdout).toContain("whatsapp");
        expect(stdout).not.toContain("discord");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
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
      // Bound the source block at the harden_resource_limits call line itself
      // (executable, stable) rather than a free-text comment that may be reworded.
      const hardenCallFromStart = src.slice(start).match(/^\s*harden_resource_limits\s*$/m);
      const end = hardenCallFromStart ? start + (hardenCallFromStart.index ?? 0) : -1;
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
