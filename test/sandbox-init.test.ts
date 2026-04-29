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
      expect(src).toContain("source");
      expect(src).toContain("sandbox-init.sh");
    });

    it("hermes start.sh sources sandbox-init.sh", () => {
      const src = readFileSync(join(import.meta.dirname, "../agents/hermes/start.sh"), "utf-8");
      expect(src).toContain("source");
      expect(src).toContain("sandbox-init.sh");
    });

    it("hermes start.sh calls lock_rc_files (vulnerability fix)", () => {
      const src = readFileSync(join(import.meta.dirname, "../agents/hermes/start.sh"), "utf-8");
      expect(src).toContain("lock_rc_files");
    });

    it("hermes start.sh uses emit_sandbox_sourced_file for proxy config", () => {
      const src = readFileSync(join(import.meta.dirname, "../agents/hermes/start.sh"), "utf-8");
      expect(src).toContain("emit_sandbox_sourced_file");
      // Should NOT contain the old inline _write_proxy_snippet pattern
      expect(src).not.toContain("_write_proxy_snippet");
      expect(src).not.toContain("_PROXY_MARKER_BEGIN");
    });

    it("hermes start.sh calls validate_tmp_permissions", () => {
      const src = readFileSync(join(import.meta.dirname, "../agents/hermes/start.sh"), "utf-8");
      expect(src).toContain("validate_tmp_permissions");
    });

    it("nemoclaw-start.sh uses emit_sandbox_sourced_file for proxy-env.sh", () => {
      const src = readFileSync(join(import.meta.dirname, "../scripts/nemoclaw-start.sh"), "utf-8");
      expect(src).toContain("emit_sandbox_sourced_file");
      // Should NOT contain old chmod 644 for proxy-env
      expect(src).not.toMatch(/chmod 644.*\$_PROXY_ENV_FILE/);
    });

    it("nemoclaw-start.sh uses parameterized verify_config_integrity", () => {
      const src = readFileSync(join(import.meta.dirname, "../scripts/nemoclaw-start.sh"), "utf-8");
      expect(src).toContain("verify_config_integrity /sandbox/.openclaw");
    });
  });
});
