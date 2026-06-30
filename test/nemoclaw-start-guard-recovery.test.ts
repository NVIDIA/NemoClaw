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

type Harness = {
  eventLog: string;
  result: SpawnSyncReturns<string>;
  sources: Record<string, string>;
  targets: Record<string, string>;
  tmpDir: string;
};

function runRecoveryHarness({ missingCiaoSource = false } = {}): Harness {
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-guard-recovery-"));
  const eventLog = path.join(tmpDir, "events.log");
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
  return { eventLog, result, sources, targets, tmpDir };
}

describe("OpenClaw PID 1 guard-chain recovery", () => {
  it("re-stages packaged guards before rebuilding and validating the runtime environment", () => {
    const harness = runRecoveryHarness();
    try {
      expect(harness.result.status, harness.result.stderr).toBe(0);
      expect(harness.result.stdout).toContain("rc:0\n");
      expect(harness.result.stderr.match(/restoring library guards/g)).toHaveLength(1);

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
