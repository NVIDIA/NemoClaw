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

const SANDBOX_INIT = join(import.meta.dirname, "../../../scripts/lib/sandbox-init.sh");

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
  describe("process observation", () => {
    it("uses the configured proc root for listener ownership", () => {
      const procRoot = mkdtempSync(join(tmpdir(), "sandbox-init-proc-"));
      try {
        const result = runWithLib(
          [
            'mkdir -p "$TEST_PROC_ROOT/net" "$TEST_PROC_ROOT/$$/fd"',
            "printf '%s\\n' '0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 4242' >\"$TEST_PROC_ROOT/net/tcp\"",
            ': >"$TEST_PROC_ROOT/net/tcp6"',
            'ln -s "socket:[4242]" "$TEST_PROC_ROOT/$$/fd/3"',
            '_NEMOCLAW_PROC_ROOT="$TEST_PROC_ROOT"',
            'gateway_control_pid_owns_tcp_listener "$$" 8080',
            "printf 'owned\\n'",
          ].join("\n"),
          { env: { TEST_PROC_ROOT: procRoot } },
        );
        expect(result.stdout).toBe("owned");
      } finally {
        rmSync(procRoot, { recursive: true, force: true });
      }
    });
  });

  describe("Python startup isolation", () => {
    it("ignores inherited PYTHONPATH in read_messaging_plan_channels", () => {
      const workDir = mkdtempSync(join(tmpdir(), "sandbox-init-python-"));
      const sentinel = join(workDir, "sitecustomize-ran");
      writeFileSync(
        join(workDir, "sitecustomize.py"),
        'import os\nfrom pathlib import Path\nPath(os.environ["TEST_PYTHON_SENTINEL"]).write_text("executed")\n',
      );
      try {
        const result = runWithLib("read_messaging_plan_channels", {
          env: {
            PYTHONPATH: workDir,
            TEST_PYTHON_SENTINEL: sentinel,
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(
              JSON.stringify({ channels: [{ channelId: "telegram", active: true }] }),
            ).toString("base64"),
          },
        });
        expect(existsSync(sentinel)).toBe(false);
        expect(result.stdout).toBe("telegram");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });

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
  });

  describe("direct-root capability fallback", () => {
    const QA_CAPBND = "00000004a82c35fb";

    it("reads and decodes the direct-root bounding set", () => {
      const workDir = mkdtempSync(join(tmpdir(), "nemoclaw-cap-bnd-"));
      const status = join(workDir, "status");
      writeFileSync(status, `Name:\tbash\nCapBnd:\t${QA_CAPBND}\n`);
      try {
        const { stdout } = runWithLib(
          `cap_bnd="$(read_capability_bounding_set ${JSON.stringify(status)})"
           printf '%s:%s\n' "$cap_bnd" "$(dangerous_caps_in_capbnd "$cap_bnd")"`,
        );
        expect(stdout).toBe(
          `${QA_CAPBND}:cap_sys_admin,cap_sys_ptrace,cap_net_raw,cap_dac_override,cap_sys_chroot,cap_fsetid,cap_setfcap,cap_mknod,cap_audit_write,cap_net_bind_service`,
        );
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it("fails closed when a direct-root drop cannot run", () => {
      const { stderr } = runWithLib(
        `read_capability_bounding_set() { printf '%s\n' ${QA_CAPBND}; }
         command() { [ "$*" = '-v capsh' ] && return 1; builtin command "$@"; }
         NEMOCLAW_REQUIRE_CAP_DROP=1 drop_capabilities /bin/true`,
        { expectFail: true },
      );
      expect(stderr).toContain("Refusing to start sandbox: dangerous caps remain");
    });
  });

  describe("harden_resource_limits", () => {
    it("sources the shared init without resolving a PATH-controlled dirname", () => {
      const workDir = mkdtempSync(join(tmpdir(), "sandbox-init-path-"));
      const fakeBin = join(workDir, "bin");
      const marker = join(workDir, "dirname-called");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(fakeBin, "dirname"),
        ["#!/usr/bin/env bash", `printf called > ${JSON.stringify(marker)}`, "exit 99"].join("\n"),
        { mode: 0o700 },
      );

      try {
        const { stdout } = runWithLib('printf "INIT_OK\\n"', {
          env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        });
        expect(stdout).toBe("INIT_OK");
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });

    it.runIf(process.platform === "linux")(
      "bypasses shadowed ulimit functions for nproc and nofile enforcement and verification",
      () => {
        const nprocLimit = 4096;
        const { stdout } = runWithLib(
          [
            `NEMOCLAW_SANDBOX_NPROC_LIMIT=${nprocLimit}`,
            "ulimit() {",
            '  case "$1:$#" in',
            "    -Su:2 | -Hu:2 | -Sn:2 | -Hn:2) return 0 ;;",
            "    -Su:1 | -Hu:1 | -Sn:1 | -Hn:1) printf '%s\\n' 999999; return 0 ;;",
            "  esac",
            "  return 0",
            "}",
            "harden_resource_limits --quiet",
            "verify_resource_limits",
            'printf "shadow=%s\\n" "$(type -t ulimit)"',
            'printf "nproc=%s\\n" "$(builtin ulimit -u)"',
            'printf "nofile=%s\\n" "$(builtin ulimit -n)"',
          ].join("\n"),
        );
        expect(stdout).toContain("shadow=function");
        expect(stdout).toContain(`nproc=${nprocLimit}`);
        const nofile = Number(stdout.match(/nofile=(\d+)/)?.[1] ?? "NaN");
        expect(nofile).toBeGreaterThan(0);
        expect(nofile).toBeLessThanOrEqual(65536);
      },
    );

    it("is best-effort: exits 0 and warns when ulimit fails", () => {
      const { stdout } = runWithLib(
        [
          "NEMOCLAW_SANDBOX_NPROC_LIMIT=not-a-limit",
          "NEMOCLAW_SANDBOX_NOFILE_LIMIT=not-a-limit",
          "harden_resource_limits 2>&1",
          'echo "HARDEN_OK"',
        ].join("\n"),
      );
      expect(stdout).toContain("HARDEN_OK");
      expect(stdout).toContain("Could not set soft nproc limit");
      expect(stdout).toContain("Could not set hard nproc limit");
      expect(stdout).toContain("Could not set soft nofile limit");
      expect(stdout).toContain("Could not set hard nofile limit");
    });

    it("verifies effective limits and emits diagnostics when a runtime leaves them unbounded", () => {
      const { stdout } = runWithLib(
        [
          "NEMOCLAW_SANDBOX_NPROC_LIMIT=1",
          "NEMOCLAW_SANDBOX_NOFILE_LIMIT=1",
          "verify_resource_limits 2>&1 || echo VERIFY_FAILED",
        ].join("\n"),
      );
      expect(stdout).not.toContain("Could not set");
      expect(stdout).toContain("Effective soft nproc limit is");
      expect(stdout).toContain("Effective hard nproc limit is");
      expect(stdout).toContain("Effective soft nofile limit is");
      expect(stdout).toContain("Effective hard nofile limit is");
      expect(stdout).toContain("VERIFY_FAILED");
    });
  });

  describe("entrypoints call harden_resource_limits", () => {
    const entrypoints = ["../../../scripts/nemoclaw-start.sh", "../../../agents/hermes/start.sh"];

    // Both entrypoints must delegate RLIMIT hardening to the shared helper and
    // must no longer carry the pre-#4527 raw inline `ulimit -Su 512` block.
    it.each(entrypoints)(
      "%s calls harden_resource_limits and has no raw inline nproc block",
      (rel) => {
        const src = readFileSync(join(import.meta.dirname, rel), "utf-8");
        expect(src).toContain("harden_resource_limits");
        expect(src).not.toContain("ulimit -Su 512");
        expect(src).not.toContain("ulimit -Hu 512");
      },
    );
  });

  describe("init_step_down_prefixes", () => {
    it("fails closed when setpriv is unavailable", () => {
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
      expect(combined).toContain("setpriv unavailable");
      expect(stdout.match(/setpriv unavailable/g)?.length).toBeGreaterThanOrEqual(2);
      expect(stdout).not.toContain("gosu");

      const refusal = runWithLib(
        [
          "export PATH=/nonexistent",
          "init_step_down_prefixes >/dev/null 2>&1",
          '"${STEP_DOWN_PREFIX_SANDBOX[@]}" id',
        ].join("\n"),
        { expectFail: true },
      );
      expect(refusal.stderr).toContain("refusing to execute a root privilege transition");
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
          "init_step_down_prefixes 2>&1",
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

    it("uses setpriv without the bounding-set drop when CAP_SETPCAP is unavailable", () => {
      const { stdout } = runWithLib(
        [
          "TMP=$(mktemp -d)",
          "cat >\"$TMP/setpriv\" <<'STUB'",
          "#!/bin/sh",
          "exit 0",
          "STUB",
          "cat >\"$TMP/capsh\" <<'STUB'",
          "#!/bin/sh",
          "exit 1",
          "STUB",
          'chmod +x "$TMP/setpriv" "$TMP/capsh"',
          'export PATH="$TMP:$PATH"',
          "init_step_down_prefixes 2>&1",
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_SANDBOX[@]}\"",
          'echo "--"',
          "printf '%s\\n' \"${STEP_DOWN_PREFIX_GATEWAY[@]}\"",
          'rm -rf "$TMP"',
        ].join("\n"),
      );
      expect(stdout).toContain("CAP_SETPCAP unavailable");
      expect(stdout).toContain("--reuid=sandbox");
      expect(stdout).toContain("--reuid=gateway");
      expect(stdout).not.toContain("--bounding-set=");
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
        exit() { echo "EXIT_$1"; }
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
      const src = readFileSync(
        join(import.meta.dirname, "../../../scripts/nemoclaw-start.sh"),
        "utf-8",
      );
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
          'printf "INIT_LOADED=%s\\n" "${NEMOCLAW_TEST_SANDBOX_INIT_LOADED:-0}"',
        ].join("\n"),
        { mode: 0o700 },
      );

      try {
        const result = execFileSync("bash", [wrapperPath], { encoding: "utf-8" }).trim();
        expect(result).toBe("INIT_LOADED=1");
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    });
  });
});
