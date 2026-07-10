// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunction(source: string, name: string): string {
  const header = `${name}() {`;
  const start = source.indexOf(header);
  expect(start, `expected ${name} in nemoclaw-start.sh`).not.toBe(-1);
  const body = source.slice(start + header.length);
  const closing = body.match(/^}$/m);
  expect(closing, `expected closing brace for ${name}`).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

function extractGatewayLogAppendFunction(
  source: string,
  gatewayLog: string,
  { replaceAfterLstat }: { replaceAfterLstat?: "regular" | "fifo" } = {},
): string {
  const functionSource = extractShellFunction(source, "append_openclaw_gateway_log_line");
  const marker = '  local log_file="/tmp/gateway.log"';
  expect(functionSource).toContain(marker);
  const rewrittenSource = functionSource.replace(
    marker,
    `  local log_file=${JSON.stringify(gatewayLog)}`,
  );
  const replacement =
    replaceAfterLstat === undefined
      ? []
      : replaceAfterLstat === "fifo"
        ? ["    os.unlink(path)", "    os.mkfifo(path)"]
        : [
            '    replacement = f"{path}.replacement"',
            '    with open(replacement, "w", encoding="utf-8") as handle:',
            '        handle.write("replacement\\n")',
            "    os.replace(replacement, path)",
          ];
  return rewrittenSource.replace(
    "    fd = os.open(path, flags)",
    [...replacement, "    fd = os.open(path, flags)"].join("\n"),
  );
}

type Harness = {
  eventLog: string;
  gatewayLog: string;
  result: SpawnSyncReturns<string>;
  sensitiveTarget?: string;
  sources: Record<string, string>;
  targets: Record<string, string>;
  tmpDir: string;
};

type RecoveryHarnessOptions = {
  gatewayLogKind?: "regular" | "symlink" | "directory" | "missing";
  missingCiaoSource?: boolean;
};

function runRecoveryHarness({
  gatewayLogKind = "regular",
  missingCiaoSource = false,
}: RecoveryHarnessOptions = {}): Harness {
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-recovery-"));
  const eventLog = path.join(tmpDir, "events.log");
  const gatewayLog = path.join(tmpDir, "gateway.log");
  let sensitiveTarget: string | undefined;
  switch (gatewayLogKind) {
    case "regular":
      fs.writeFileSync(gatewayLog, "", { mode: 0o644 });
      break;
    case "symlink":
      sensitiveTarget = path.join(tmpDir, "sensitive.log");
      fs.writeFileSync(sensitiveTarget, "do-not-touch\n", { mode: 0o600 });
      fs.symlinkSync(sensitiveTarget, gatewayLog);
      break;
    case "directory":
      fs.mkdirSync(gatewayLog);
      break;
    case "missing":
      break;
  }
  const sources = {
    safety: path.join(tmpDir, "source-safety.js"),
    proxy: path.join(tmpDir, "source-proxy.js"),
    nemotron: path.join(tmpDir, "source-nemotron.js"),
    ciao: path.join(tmpDir, "source-ciao.js"),
    websocket: path.join(tmpDir, "source-websocket.js"),
    seccomp: path.join(tmpDir, "source-seccomp.js"),
  };
  const targets = {
    safety: path.join(tmpDir, "target-safety.js"),
    proxy: path.join(tmpDir, "target-proxy.js"),
    nemotron: path.join(tmpDir, "target-nemotron.js"),
    ciao: path.join(tmpDir, "target-ciao.js"),
    websocket: path.join(tmpDir, "target-websocket.js"),
    seccomp: path.join(tmpDir, "target-seccomp.js"),
    runtimeEnv: path.join(tmpDir, "nemoclaw-proxy-env.sh"),
  };

  const stagedSources = Object.entries(sources).filter(
    ([name]) => !missingCiaoSource || name !== "ciao",
  );
  for (const [name, sourcePath] of stagedSources) {
    fs.writeFileSync(sourcePath, `module.exports = ${JSON.stringify(name)};\n`, { mode: 0o644 });
  }

  const script = [
    "set -uo pipefail",
    `EVENT_LOG=${JSON.stringify(eventLog)}`,
    `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(gatewayLog)}`,
    'NODE_OPTIONS=""',
    "NODE_USE_ENV_PROXY=1",
    `_SANDBOX_SAFETY_NET=${JSON.stringify(targets.safety)}`,
    `_SANDBOX_SAFETY_NET_SOURCE=${JSON.stringify(sources.safety)}`,
    `_PROXY_FIX_SCRIPT=${JSON.stringify(targets.proxy)}`,
    `_PROXY_FIX_SOURCE=${JSON.stringify(sources.proxy)}`,
    `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(targets.nemotron)}`,
    `_NEMOTRON_FIX_SOURCE=${JSON.stringify(sources.nemotron)}`,
    `_CIAO_GUARD_SCRIPT=${JSON.stringify(targets.ciao)}`,
    `_CIAO_GUARD_SOURCE=${JSON.stringify(sources.ciao)}`,
    `_WS_FIX_SCRIPT=${JSON.stringify(targets.websocket)}`,
    `_WS_FIX_SOURCE=${JSON.stringify(sources.websocket)}`,
    `_SECCOMP_GUARD_SCRIPT=${JSON.stringify(targets.seccomp)}`,
    `_SECCOMP_GUARD_SOURCE=${JSON.stringify(sources.seccomp)}`,
    `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(targets.runtimeEnv)}`,
    "OPENCLAW_RESTART_FAILURE_CODE=internal",
    "emit_sandbox_sourced_file() {",
    '  local target="$1" stage="${1}.stage"',
    '  cat >"$stage" || return 1',
    '  chmod 444 "$stage" || return 1',
    '  mv -f "$stage" "$target" || return 1',
    '  printf "emit:%s\\n" "$(basename "$target")" >>"$EVENT_LOG"',
    "}",
    'run_openclaw_config_guard() { printf "guard:%s\\n" "$1" >>"$EVENT_LOG"; }',
    'write_messaging_runtime_setup_plan() { printf "write-messaging-plan\\n" >>"$EVENT_LOG"; }',
    'install_messaging_runtime_preloads() { printf "messaging\\n" >>"$EVENT_LOG"; }',
    'verify_messaging_runtime_secret_scans() { printf "secret-scan\\n" >>"$EVENT_LOG"; }',
    "write_runtime_shell_env() {",
    '  printf "write-runtime-env\\n" >>"$EVENT_LOG"',
    '  printf "%s\\n" "# recovered runtime environment" | emit_sandbox_sourced_file "$_RUNTIME_SHELL_ENV_FILE"',
    "}",
    "validate_nemoclaw_tmp_permissions() {",
    '  printf "validate\\n" >>"$EVENT_LOG"',
    '  local target; for target in "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_CIAO_GUARD_SCRIPT" "$_WS_FIX_SCRIPT" "$_SECCOMP_GUARD_SCRIPT" "$_RUNTIME_SHELL_ENV_FILE"; do',
    '    [ -f "$target" ] && [ ! -L "$target" ] || return 1',
    "  done",
    "}",
    extractShellFunction(source, "node_options_has_require"),
    extractShellFunction(source, "append_node_require_once"),
    extractShellFunction(source, "install_core_runtime_preloads"),
    extractShellFunction(source, "openclaw_runtime_guard_chain_complete"),
    extractGatewayLogAppendFunction(source, gatewayLog),
    extractShellFunction(source, "restore_openclaw_runtime_guard_chain"),
    extractShellFunction(source, "prepare_openclaw_gateway_restart"),
    "rc=0; prepare_openclaw_gateway_restart || rc=$?",
    'if [ "$rc" -eq 0 ] && [ "${RUN_TWICE:-0}" = "1" ]; then prepare_openclaw_gateway_restart || rc=$?; fi',
    'printf "rc:%s\\nfailure-code:%s\\nnode-options:%s\\n" "$rc" "$OPENCLAW_RESTART_FAILURE_CODE" "$NODE_OPTIONS"',
  ].join("\n");

  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, RUN_TWICE: missingCiaoSource ? "0" : "1" },
    timeout: 10_000,
  });
  return {
    eventLog,
    gatewayLog,
    result,
    sensitiveTarget,
    sources,
    targets,
    tmpDir,
  };
}

describe("OpenClaw PID 1 guard-chain recovery", () => {
  it("re-stages packaged guards before rebuilding and validating the runtime environment", () => {
    const harness = runRecoveryHarness();
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stdout).toContain("rc:0\n");
      expect(harness.result.stderr.match(/restoring library guards/g)).toHaveLength(1);
      expect(
        fs.readFileSync(harness.gatewayLog, "utf8").match(/restoring library guards/g),
      ).toHaveLength(1);

      const onePass = [
        "guard:preflight-restart",
        "emit:target-safety.js",
        "emit:target-proxy.js",
        "emit:target-nemotron.js",
        "emit:target-ciao.js",
        "emit:target-websocket.js",
        "emit:target-seccomp.js",
        "write-messaging-plan",
        "messaging",
        "secret-scan",
        "write-runtime-env",
        "emit:nemoclaw-proxy-env.sh",
        "validate",
      ];
      expect(fs.readFileSync(harness.eventLog, "utf8").trim().split("\n")).toEqual([
        ...onePass,
        ...onePass,
      ]);

      for (const name of ["safety", "proxy", "nemotron", "ciao", "websocket", "seccomp"]) {
        const target = harness.targets[name];
        expect(fs.readFileSync(target, "utf8")).toBe(
          fs.readFileSync(harness.sources[name], "utf8"),
        );
        expect(fs.statSync(target).mode & 0o777).toBe(0o444);
        expect(harness.result.stdout.split(target)).toHaveLength(2);
      }
      expect(fs.statSync(harness.targets.runtimeEnv).mode & 0o777).toBe(0o444);
    } finally {
      fs.rmSync(harness.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not write guard-chain warnings through an unsafe gateway log symlink", () => {
    const harness = runRecoveryHarness({ gatewayLogKind: "symlink" });
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stderr).toContain("refusing unsafe gateway log path");
      expect(harness.result.stderr).toContain("restoring library guards");
      expect(harness.sensitiveTarget).toBeDefined();
      expect(fs.readlinkSync(harness.gatewayLog)).toBe(harness.sensitiveTarget);
      expect(fs.readFileSync(harness.sensitiveTarget ?? "", "utf8")).toBe("do-not-touch\n");
    } finally {
      fs.rmSync(harness.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not write guard-chain warnings to a non-regular gateway log target", () => {
    const harness = runRecoveryHarness({ gatewayLogKind: "directory" });
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stderr).toContain("refusing unsafe gateway log path");
      expect(fs.statSync(harness.gatewayLog).isDirectory()).toBe(true);
      expect(fs.readdirSync(harness.gatewayLog)).toHaveLength(0);
    } finally {
      fs.rmSync(harness.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not create a missing gateway log from guard-chain recovery", () => {
    const harness = runRecoveryHarness({ gatewayLogKind: "missing" });
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stderr).toContain("restoring library guards");
      expect(fs.existsSync(harness.gatewayLog)).toBe(false);
    } finally {
      fs.rmSync(harness.tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a gateway log path replaced between validation and append", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-replaced-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    try {
      fs.writeFileSync(gatewayLog, "original\n", { mode: 0o644 });
      const script = [
        "set -uo pipefail",
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(gatewayLog)}`,
        extractGatewayLogAppendFunction(source, gatewayLog, { replaceAfterLstat: "regular" }),
        "rc=0; append_openclaw_gateway_log_line 'safe-line' || rc=$?",
        'printf "rc:%s\\n" "$rc"',
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rc:1\n");
      expect(result.stderr).toContain("refusing replaced gateway log path");
      expect(fs.readFileSync(gatewayLog, "utf8")).toBe("replacement\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not block when the gateway log is replaced with a FIFO before open", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-fifo-swap-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    try {
      fs.writeFileSync(gatewayLog, "original\n", { mode: 0o644 });
      const script = [
        "set -uo pipefail",
        extractGatewayLogAppendFunction(source, gatewayLog, { replaceAfterLstat: "fifo" }),
        "rc=0; append_openclaw_gateway_log_line 'safe-line' || rc=$?",
        'printf "rc:%s\\n" "$rc"',
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rc:1\n");
      expect(result.stderr).toContain("refusing unsafe gateway log path");
      expect(fs.lstatSync(gatewayLog).isFIFO()).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores inherited non-canonical gateway log environment", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-contract-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const inheritedTarget = path.join(tmpDir, "inherited.log");
    try {
      fs.writeFileSync(gatewayLog, "", { mode: 0o644 });
      fs.writeFileSync(inheritedTarget, "existing\n", { mode: 0o644 });
      const script = [
        "set -uo pipefail",
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(inheritedTarget)}`,
        "_NEMOCLAW_GATEWAY_LOG_TEST_MODE=1",
        extractGatewayLogAppendFunction(source, gatewayLog),
        "append_openclaw_gateway_log_line 'safe-line'",
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(gatewayLog, "utf8")).toBe("safe-line\n");
      expect(fs.readFileSync(inheritedTarget, "utf8")).toBe("existing\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sanitizes gateway log lines before appending", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-sanitize-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    try {
      fs.writeFileSync(gatewayLog, "", { mode: 0o644 });
      const script = [
        "set -uo pipefail",
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(gatewayLog)}`,
        extractGatewayLogAppendFunction(source, gatewayLog),
        "append_openclaw_gateway_log_line $'first\\nsecond'",
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(gatewayLog, "utf8")).toBe("first second\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed as preload-missing before validation when a packaged guard is absent", () => {
    const harness = runRecoveryHarness({ missingCiaoSource: true });
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stdout).toContain("rc:1\n");
      expect(harness.result.stdout).toContain("failure-code:preload-missing\n");
      expect(harness.result.stderr).toContain("source-ciao.js");
      const events = fs.readFileSync(harness.eventLog, "utf8");
      expect(events).toContain("guard:preflight-restart");
      expect(events).not.toContain("write-messaging-plan");
      expect(events).not.toContain("messaging");
      expect(events).not.toContain("write-runtime-env");
      expect(events).not.toContain("validate");
    } finally {
      fs.rmSync(harness.tmpDir, { recursive: true, force: true });
    }
  });

  // ── Recovery warning must reach the gateway log, not just stderr (#6065) ──
  //
  // #5874 moved recovery to a docker-IPC path where the warning was written to
  // PID 1 stderr only; the live `issue-2478-crash-loop-recovery` E2E polls
  // /tmp/gateway.log and went red. That target does not run on PR CI, so this
  // mocked unit pins the file write through an extracted helper in the PR gate
  // to keep a refactor from silently regressing to stderr-only.
  it("mirrors the guard-chain restore warning into the gateway log file", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-warn-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    try {
      fs.writeFileSync(gatewayLog, "", { mode: 0o644 });
      const script = [
        "set -uo pipefail",
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(gatewayLog)}`,
        // Force the chain-incomplete branch so the warning fires, and stub the
        // downstream restore steps so this isolates the warning emission alone.
        "openclaw_runtime_guard_chain_complete() { return 1; }",
        "install_core_runtime_preloads() { return 0; }",
        "write_messaging_runtime_setup_plan() { return 0; }",
        "install_messaging_runtime_preloads() { return 0; }",
        "verify_messaging_runtime_secret_scans() { return 0; }",
        "write_runtime_shell_env() { return 0; }",
        "validate_nemoclaw_tmp_permissions() { return 0; }",
        extractGatewayLogAppendFunction(source, gatewayLog),
        extractShellFunction(source, "restore_openclaw_runtime_guard_chain"),
        "rc=0; restore_openclaw_runtime_guard_chain || rc=$?",
        'printf "rc:%s\\n" "$rc"',
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rc:0\n");
      // The marker must appear on stderr (operator console) AND in the gateway
      // log file the recovery E2E observes.
      expect(result.stderr).toContain("restoring library guards from packaged preloads");
      expect(fs.existsSync(gatewayLog)).toBe(true);
      expect(fs.readFileSync(gatewayLog, "utf8")).toContain(
        "[gateway-recovery] WARNING: /tmp guard chain missing or unsafe",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not emit the recovery warning when the guard chain is already complete", () => {
    // Fence the branch: a healthy chain must stay silent so the log marker
    // remains a true recovery signal rather than startup noise.
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-quiet-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    try {
      const script = [
        "set -uo pipefail",
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(gatewayLog)}`,
        "openclaw_runtime_guard_chain_complete() { return 0; }",
        "install_core_runtime_preloads() { return 0; }",
        "write_messaging_runtime_setup_plan() { return 0; }",
        "install_messaging_runtime_preloads() { return 0; }",
        "verify_messaging_runtime_secret_scans() { return 0; }",
        "write_runtime_shell_env() { return 0; }",
        "validate_nemoclaw_tmp_permissions() { return 0; }",
        extractShellFunction(source, "restore_openclaw_runtime_guard_chain"),
        "rc=0; restore_openclaw_runtime_guard_chain || rc=$?",
        'printf "rc:%s\\n" "$rc"',
      ].join("\n");

      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rc:0\n");
      expect(result.stderr).not.toContain("restoring library guards");
      expect(fs.existsSync(gatewayLog)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses an automatic respawn when guard restoration fails", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf8");
    const script = [
      "set -uo pipefail",
      "restore_openclaw_runtime_guard_chain() { printf 'restore-attempted\\n'; return 1; }",
      extractShellFunction(source, "prepare_openclaw_automatic_respawn"),
      "rc=0; prepare_openclaw_automatic_respawn || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("restore-attempted\nrc:1\n");
    expect(result.stderr).toContain("refusing automatic respawn");
  });
});
