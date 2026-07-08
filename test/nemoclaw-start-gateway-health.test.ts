// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway-health coverage for scripts/nemoclaw-start.sh (#4503, #4710):
// the Docker HEALTHCHECK marker invariants and the gateway serving watchdog.
// The OpenClaw gateway can drop its HTTP listener while the process stays
// alive (failed in-process SIGUSR1 restart); the #2757 respawn loop only sees
// process exit, so the watchdog must kill an alive-but-deaf gateway to hand
// recovery back to the respawn loop. Marker tests are split from
// test/nemoclaw-start.test.ts, which is at its size budget
// (ci/test-file-size-budget.json).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const GATEWAY_SUPERVISOR = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "gateway-supervisor.sh",
);

// Read a file that may legitimately be absent without a check-then-read
// race (CodeQL js/file-system-race): attempt the read and treat a missing
// file as null.
function readFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function extractShellFunction(src: string, name: string): string {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  expect(start, `Expected ${name} in scripts/nemoclaw-start.sh`).not.toBe(-1);
  const bodyStart = start + header.length;
  const body = src.slice(bodyStart);
  const closing = body.match(/^}$/m);
  expect(closing, `Expected closing brace for ${name} in scripts/nemoclaw-start.sh`).not.toBeNull();
  return `${name}() {${body.slice(0, closing?.index ?? 0)}\n}`;
}

function extractGatewayLogAppendFunction(src: string, gatewayLog: string): string {
  const functionSource = extractShellFunction(src, "append_openclaw_gateway_log_line");
  const marker = '  local log_file="/tmp/gateway.log"';
  expect(functionSource).toContain(marker);
  return functionSource.replace(marker, `  local log_file=${JSON.stringify(gatewayLog)}`);
}

function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in scripts/nemoclaw-start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in scripts/nemoclaw-start.sh").toBeGreaterThan(start);
  return src.slice(start, end);
}

function pidIdentityFunctions(src: string): string {
  const supervisor = fs.readFileSync(GATEWAY_SUPERVISOR, "utf-8");
  return [
    extractShellFunction(src, "openclaw_load_pid_identity"),
    extractShellFunction(src, "openclaw_pid_start_identity"),
    extractShellFunction(src, "capture_openclaw_pid_start_identity"),
    extractShellFunction(src, "openclaw_supervised_pid_is_live"),
    extractShellFunction(supervisor, "gateway_control_proc_root"),
    extractShellFunction(supervisor, "gateway_control_proc_root_is_explicit"),
    extractShellFunction(supervisor, "gateway_control_pid_state"),
    extractShellFunction(supervisor, "gateway_control_pid_is_live"),
  ].join("\n");
}

const writeProcStatFunction = [
  "write_proc_stat() {",
  '  local pid="$1" parent="$2" start="$3"',
  '  printf \'%s (test-process) S %s\' "$pid" "$parent"',
  "  for _ in {1..17}; do printf ' 0'; done",
  "  printf ' %s\\n' \"$start\"",
  "}",
].join("\n");

function watchdogFunctions(gatewayLog: string): string {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  return [
    safeTmpHelpers(src),
    pidIdentityFunctions(src),
    extractGatewayLogAppendFunction(src, gatewayLog),
    extractShellFunction(src, "record_gateway_pid"),
    extractShellFunction(src, "gateway_pid_is_openclaw_gateway"),
    extractShellFunction(src, "gateway_watchdog_positive_int_ok"),
    extractShellFunction(src, "start_gateway_serving_watchdog"),
  ].join("\n");
}

function rootGatewayLifecycleFunctions(src: string, gatewayLog: string): string {
  return [
    pidIdentityFunctions(src),
    extractShellFunction(src, "launch_openclaw_gateway").replaceAll("/tmp/gateway.log", gatewayLog),
    extractShellFunction(src, "openclaw_supervised_aux_pid_is_live"),
    extractShellFunction(src, "stop_openclaw_supervised_gateway"),
    extractShellFunction(src, "refresh_openclaw_supervised_child_pids"),
    extractShellFunction(src, "mark_openclaw_gateway_stopped"),
    extractShellFunction(src, "stop_openclaw_gateway_fail_closed"),
    extractShellFunction(src, "openclaw_reap_exited_gateway"),
  ].join("\n");
}

// Drive the watchdog end-to-end against a real background process standing in
// for the gateway. `curlPlan` is the sequence of curl exit codes the stubbed
// probe returns, one per watchdog cycle; the last entry repeats forever.
// The proc fixture under _NEMOCLAW_PROC_ROOT controls what the PID-identity
// check sees for the fake gateway.
function runWatchdog(opts: {
  curlPlan: number[];
  cmdline?: string;
  env?: Record<string, string>;
  // How long to let the watchdog run when no kill is expected (seconds).
  settleSeconds?: number;
  expectKill: boolean;
}): {
  result: ReturnType<typeof spawnSync>;
  fakeAlive: boolean;
  wedgeLog: string;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-"));
  const planFile = path.join(tmpDir, "curl-plan.txt");
  const wedgeLogFile = path.join(tmpDir, "gateway.log");
  fs.writeFileSync(wedgeLogFile, "", { mode: 0o644 });
  const pidFile = path.join(tmpDir, "gateway.pid");
  const procRoot = path.join(tmpDir, "proc");
  fs.writeFileSync(planFile, `${opts.curlPlan.join("\n")}\n`);

  const settle = opts.settleSeconds ?? 0.5;
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -o pipefail",
    `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
    "_DASHBOARD_PORT=18789",
    `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
    `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(path.join(tmpDir, "ignored-inherited.log"))}`,
    writeProcStatFunction,
    // Throttle rather than no-op so the spinning loop stays cheap but the
    // test still completes in well under a second per cycle.
    "sleep() { command sleep 0.01; }",
    // curl stub: pop the next exit code off the plan; keep the last one.
    `_CURL_PLAN=${JSON.stringify(planFile)}`,
    "curl() {",
    "  local next rest",
    '  next="$(head -n1 "$_CURL_PLAN" 2>/dev/null)"',
    '  [ -n "$next" ] || next=0',
    '  rest="$(tail -n +2 "$_CURL_PLAN" 2>/dev/null)"',
    '  if [ -n "$rest" ]; then printf "%s\\n" "$rest" >"$_CURL_PLAN"; fi',
    '  return "$next"',
    "}",
    // A real process stands in for the gateway so kill -0 / kill -TERM are
    // exercised for real; its claimed cmdline comes from the proc fixture.
    "command sleep 60 &",
    "FAKE_GATEWAY_PID=$!",
    "FAKE_GATEWAY_START=1001",
    `mkdir -p ${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID`,
    `printf '%s' ${JSON.stringify(opts.cmdline ?? "openclaw-gateway")} >${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID/cmdline`,
    `write_proc_stat "$FAKE_GATEWAY_PID" "$$" "$FAKE_GATEWAY_START" >${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID/stat`,
    watchdogFunctions(wedgeLogFile),
    'capture_openclaw_pid_start_identity() { printf -v "$2" "%s" "watchdog-test"; }',
    'record_gateway_pid "$FAKE_GATEWAY_PID" "$FAKE_GATEWAY_START"',
    "start_gateway_serving_watchdog",
    'printf "WATCHDOG_PID=%s\\n" "$GATEWAY_WATCHDOG_PID"',
    ...(opts.expectKill
      ? [
          // Poll until the watchdog kills the fake gateway (or time out).
          "for _ in $(command seq 1 300); do",
          '  kill -0 "$FAKE_GATEWAY_PID" 2>/dev/null || break',
          "  command sleep 0.02",
          "done",
        ]
      : [`command sleep ${settle}`]),
    'if kill -0 "$FAKE_GATEWAY_PID" 2>/dev/null; then printf "FAKE_ALIVE=1\\n"; else printf "FAKE_ALIVE=0\\n"; fi',
    // Disown before killing: bash's asynchronous job-termination report
    // includes the full job command text (the watchdog subshell body), which
    // would pollute stderr assertions.
    "disown -a 2>/dev/null || true",
    'kill -KILL "$GATEWAY_WATCHDOG_PID" 2>/dev/null || true',
    'kill -KILL "$FAKE_GATEWAY_PID" 2>/dev/null || true',
    "command sleep 0.05",
  ].join("\n");

  const script = path.join(tmpDir, "run.sh");
  fs.writeFileSync(script, wrapper, { mode: 0o755 });

  const result = spawnSync("bash", [script], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const fakeAlive = /^FAKE_ALIVE=1$/m.test(stdout);
  const wedgeLog = readFileIfPresent(wedgeLogFile) ?? "";
  return { result, fakeAlive, wedgeLog, tmpDir };
}

describe("gateway serving watchdog (#4710)", () => {
  it("kills an alive-but-deaf gateway after sustained connection-refused and logs CRITICAL", () => {
    const { result, fakeAlive, wedgeLog, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 7],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("dropped its HTTP listener on port 18789");
      expect(wedgeLog).toContain("[gateway-watchdog] CRITICAL");
      expect(wedgeLog).toContain("dropped its HTTP listener on port 18789");
      expect(wedgeLog).toContain("(#4710)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("never arms — and never kills — when the gateway has not served yet", () => {
    // A gateway that is still booting (or failed to boot) refuses from the
    // start; that case belongs to the respawn loop and the Docker
    // HEALTHCHECK, not the watchdog.
    const { result, fakeAlive, wedgeLog, tmpDir } = runWatchdog({
      curlPlan: [7],
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).not.toContain("dropped its HTTP listener on port 18789");
      expect(wedgeLog).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resets the refused streak when a probe succeeds again", () => {
    // Three refusals (below the threshold of four), recovery, three more —
    // the streak must reset at each success and the gateway must survive.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 0, 7, 7, 7, 0],
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).not.toContain("dropped its HTTP listener on port 18789");
      expect(result.stderr).toContain("refused connection (1/4)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats curl timeout and HTTP-error outcomes as listener-present", () => {
    // curl 28 (timeout) and 22 (HTTP error) prove a listener exists; they
    // arm the watchdog but never count toward the refused streak — a wedged
    // listener that still accepts connections stays the HEALTHCHECK's call.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [28, 22, 28, 22, 28, 22, 28, 22],
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).not.toContain("dropped its HTTP listener on port 18789");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not kill a PID whose cmdline no longer looks like the gateway", () => {
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 7],
      cmdline: "vim notes.txt",
      expectKill: false,
      settleSeconds: 1.2,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain("no longer looks like the openclaw gateway");
      expect(result.stderr).not.toContain("dropped its HTTP listener on port 18789");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors the refused-threshold env override", () => {
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD: "2" },
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("2 consecutive refused probes");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to defaults when the env knobs are not positive integers", () => {
    // A zero/garbage interval would busy-loop the probe; a zero threshold
    // would kill on the first refusal. Both must be rejected with a warning
    // while the watchdog keeps working on the defaults.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 7],
      env: {
        NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS: "0",
        NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD: "banana",
      },
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(result.stderr).toContain(
        "invalid NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS='0'; defaulting to 30",
      );
      expect(result.stderr).toContain(
        "invalid NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD='banana'; defaulting to 4",
      );
      // Default threshold of 4 still applies.
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("4 consecutive refused probes");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not inherit the armed state when the pidfile switches to a new gateway PID", () => {
    // A fast respawn can replace the pidfile between probes without the
    // watchdog ever observing the old PID as dead. The new gateway must earn
    // its own armed state — otherwise its boot-time refusals would count
    // against the predecessor's serve history and it could be killed while
    // still starting up.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-swap-"));
    try {
      const planFile = path.join(tmpDir, "curl-plan.txt");
      const probeLog = path.join(tmpDir, "probes.log");
      const wedgeLogFile = path.join(tmpDir, "gateway.log");
      fs.writeFileSync(wedgeLogFile, "", { mode: 0o644 });
      const pidFile = path.join(tmpDir, "gateway.pid");
      const procRoot = path.join(tmpDir, "proc");
      // First probe arms on gateway A; everything after refuses.
      fs.writeFileSync(planFile, "0\n7\n");

      const wrapper = [
        "#!/usr/bin/env bash",
        "set -o pipefail",
        `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
        "_DASHBOARD_PORT=18789",
        `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
        `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(path.join(tmpDir, "gateway.log"))}`,
        writeProcStatFunction,
        // A low threshold makes an inherited armed state lethal within a few
        // cycles, so survival proves the per-PID reset.
        "export NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD=2",
        "sleep() { command sleep 0.01; }",
        `_CURL_PLAN=${JSON.stringify(planFile)}`,
        "curl() {",
        "  local next rest",
        '  next="$(head -n1 "$_CURL_PLAN" 2>/dev/null)"',
        '  [ -n "$next" ] || next=0',
        '  rest="$(tail -n +2 "$_CURL_PLAN" 2>/dev/null)"',
        '  if [ -n "$rest" ]; then printf "%s\\n" "$rest" >"$_CURL_PLAN"; fi',
        `  printf 'probe\\n' >> ${JSON.stringify(probeLog)}`,
        '  case "$next" in',
        '    0) record_gateway_pid "$GATEWAY_B" "$GATEWAY_B_START" ;;',
        "  esac",
        '  return "$next"',
        "}",
        "command sleep 60 &",
        "GATEWAY_A=$!",
        "command sleep 60 &",
        "GATEWAY_B=$!",
        "GATEWAY_A_START=2001",
        "GATEWAY_B_START=2002",
        `mkdir -p ${JSON.stringify(procRoot)}/$GATEWAY_A ${JSON.stringify(procRoot)}/$GATEWAY_B`,
        `printf 'openclaw-gateway' >${JSON.stringify(procRoot)}/$GATEWAY_A/cmdline`,
        `printf 'openclaw-gateway' >${JSON.stringify(procRoot)}/$GATEWAY_B/cmdline`,
        `write_proc_stat "$GATEWAY_A" "$$" "$GATEWAY_A_START" >${JSON.stringify(procRoot)}/$GATEWAY_A/stat`,
        `write_proc_stat "$GATEWAY_B" "$$" "$GATEWAY_B_START" >${JSON.stringify(procRoot)}/$GATEWAY_B/stat`,
        watchdogFunctions(wedgeLogFile),
        'capture_openclaw_pid_start_identity() { printf -v "$2" "%s" "watchdog-test"; }',
        'record_gateway_pid "$GATEWAY_A" "$GATEWAY_A_START"',
        "start_gateway_serving_watchdog",
        // The curl stub swaps to gateway B during A's successful probe,
        // before the watchdog can start counting refused probes again.
        'printf "B_PID=%s\\n" "$GATEWAY_B"',
        "command sleep 0.6",
        'if kill -0 "$GATEWAY_B" 2>/dev/null; then printf "B_ALIVE=1\\n"; else printf "B_ALIVE=0\\n"; fi',
        "disown -a 2>/dev/null || true",
        'kill -KILL "$GATEWAY_WATCHDOG_PID" "$GATEWAY_A" "$GATEWAY_B" 2>/dev/null || true',
        "command sleep 0.05",
      ].join("\n");

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(script, wrapper, { mode: 0o755 });
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 30000 });

      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      // Without the per-PID reset, B inherits armed=1 and dies after two
      // refused probes (threshold 2, 10ms cycles) well inside the 600ms
      // observation window.
      expect(stdout).toContain("B_ALIVE=1");
      const bPid = stdout.match(/^B_PID=(\d+)$/m)?.[1];
      expect(bPid).toBeDefined();
      expect(result.stderr).not.toContain(
        `gateway pid ${bPid} is alive but dropped its HTTP listener on port 18789`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("tracks the replacement before a termination signal interrupts restart health wait", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restart-signal-race-"));
    const eventLog = path.join(tmpDir, "events.log");
    const scriptPath = path.join(tmpDir, "run.sh");

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `EVENT_LOG=${JSON.stringify(eventLog)}`,
        "GATEWAY_PID=101",
        "GATEWAY_PID_START_IDENTITY=old-start",
        "SANDBOX_WAIT_PID=101",
        "SANDBOX_CHILD_PIDS=(101)",
        "GATEWAY_CONTROL_ACTION=restart",
        "GATEWAY_CONTROL_SIGNAL_PENDING=0",
        "gateway_control_take_request() { :; }",
        'openclaw_supervised_pid_is_live() { case "$1:$2" in "101:old-start"|"202:new-start") return 0 ;; *) return 1 ;; esac; }',
        "gateway_control_stop_tracked_pid() {",
        '  printf "stop:%s:%s\\n" "$1" "$2" >>"$EVENT_LOG"',
        "  return 0",
        "}",
        "prepare_openclaw_gateway_restart() { :; }",
        "run_openclaw_config_guard() { :; }",
        "restore_openclaw_restart_config() { :; }",
        "cleanup_openclaw_gateway_locks() { :; }",
        "launch_openclaw_gateway() {",
        "  GATEWAY_PID=202",
        "  GATEWAY_PID_START_IDENTITY=new-start",
        "  SANDBOX_WAIT_PID=202",
        "}",
        "wait_for_openclaw_gateway_internal() {",
        '  kill -TERM "$$"',
        "  return 1",
        "}",
        "start_plugin_registry_refresh() { :; }",
        "gateway_control_complete() { :; }",
        "gateway_control_fail() { :; }",
        "cleanup_on_signal() {",
        '  printf "cleanup:wait=%s:children=%s\\n" "$SANDBOX_WAIT_PID" "${SANDBOX_CHILD_PIDS[*]}" >>"$EVENT_LOG"',
        '  [ "$SANDBOX_WAIT_PID" -eq 202 ]',
        '  [ "${SANDBOX_CHILD_PIDS[*]}" = "202" ]',
        "  exit 0",
        "}",
        "trap cleanup_on_signal SIGTERM SIGINT",
        extractShellFunction(src, "openclaw_supervised_aux_pid_is_live"),
        extractShellFunction(src, "stop_openclaw_supervised_gateway"),
        extractShellFunction(src, "refresh_openclaw_supervised_child_pids"),
        extractShellFunction(src, "mark_openclaw_gateway_stopped"),
        extractShellFunction(src, "stop_openclaw_gateway_fail_closed"),
        extractShellFunction(src, "retire_openclaw_supervised_gateway"),
        extractShellFunction(src, "handle_openclaw_gateway_control_request"),
        "handle_openclaw_gateway_control_request",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.readFileSync(eventLog, "utf-8")).toBe(
        "stop:101:old-start\ncleanup:wait=202:children=202\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("OpenClaw supervised child PID identity", () => {
  it("does not re-admit a recycled plugin-refresh PID owned by another process", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-aux-pid-identity-"));
    const procRoot = path.join(tmpDir, "proc");
    const scriptPath = path.join(tmpDir, "run.sh");

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
        writeProcStatFunction,
        'mkdir -p "$_NEMOCLAW_PROC_ROOT/303" "$_NEMOCLAW_PROC_ROOT/404"',
        'write_proc_stat 303 "$$" 3003 >"$_NEMOCLAW_PROC_ROOT/303/stat"',
        'write_proc_stat 404 "$$" 4999 >"$_NEMOCLAW_PROC_ROOT/404/stat"',
        pidIdentityFunctions(src),
        'gateway_control_pid_is_live() { case "$1" in 303|404) return 0 ;; *) return 1 ;; esac; }',
        "GATEWAY_PID=",
        "GATEWAY_PID_START_IDENTITY=",
        "AUTO_PAIR_PID=303",
        "AUTO_PAIR_PID_START_IDENTITY=3003",
        "GATEWAY_LOG_TAIL_PID=",
        "GATEWAY_LOG_TAIL_PID_START_IDENTITY=",
        "GATEWAY_LOG_PERSIST_PID=",
        "GATEWAY_LOG_PERSIST_PID_START_IDENTITY=",
        "PLUGIN_REFRESH_PID=404",
        "PLUGIN_REFRESH_PID_START_IDENTITY=4004",
        "GATEWAY_WATCHDOG_PID=",
        "GATEWAY_WATCHDOG_PID_START_IDENTITY=",
        'gateway_control_stop_tracked_pid() { printf "unsafe-stop\\n"; }',
        extractShellFunction(src, "openclaw_supervised_aux_pid_is_live"),
        extractShellFunction(src, "stop_openclaw_supervised_gateway"),
        extractShellFunction(src, "refresh_openclaw_supervised_child_pids"),
        "refresh_openclaw_supervised_child_pids",
        'printf "%s\\n" "${SANDBOX_CHILD_PIDS[*]}"',
        'if stop_openclaw_supervised_gateway 404 4004; then printf "STOPPED\\n"; else printf "STOP_REJECTED\\n"; fi',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("303\nSTOP_REJECTED\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not accept a tracked-stop success while the numeric gateway PID remains live", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -uo pipefail",
      "openclaw_supervised_pid_is_live() { return 0; }",
      'gateway_control_stop_tracked_pid() { printf "stop:%s:%s\\n" "$1" "$2"; return 0; }',
      'kill() { [ "$1" = "-0" ] && return 0; printf "unexpected-signal\\n"; }',
      extractShellFunction(source, "stop_openclaw_supervised_gateway"),
      "rc=0; stop_openclaw_supervised_gateway 4242 777 || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("stop:4242:777\nrc:1\n");
    expect(result.stderr).toContain("remains live after tracked stop");
    expect(result.stdout).not.toContain("unexpected-signal");
  });

  it("exits PID 1 instead of marking an unproven OpenClaw gateway stopped", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -uo pipefail",
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      "stop_openclaw_supervised_gateway() { printf 'stop-refused\\n'; return 1; }",
      "mark_openclaw_gateway_stopped() { printf 'unexpected-mark\\n'; }",
      extractShellFunction(source, "stop_openclaw_gateway_fail_closed"),
      "stop_openclaw_gateway_fail_closed",
      "printf 'unexpected-return\\n'",
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("stop-refused\n");
    expect(result.stderr).toContain("exiting PID 1 for whole-container cleanup");
    expect(result.stdout).not.toContain("unexpected-mark");
    expect(result.stdout).not.toContain("unexpected-return");
  });

  it.each([
    ["a live PID with a different start identity", 'printf "888\\n"', "S"],
    ["a live PID whose identity is temporarily unavailable", "return 1", "S"],
  ])("refuses to reap %s", (_label, identityBody, state) => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      "GATEWAY_CONTROL_SIGNAL_PENDING=0",
      `openclaw_pid_start_identity() { ${identityBody}; }`,
      'kill() { [ "$1" = "-0" ] && return 0; return 1; }',
      `gateway_control_pid_state() { printf "${state}\\n"; }`,
      'wait() { printf "unexpected-wait:%s\\n" "$1"; }',
      "openclaw_supervised_pid_is_live() { return 1; }",
      "gateway_pid_is_openclaw_gateway() { return 1; }",
      "mark_openclaw_gateway_stopped() { printf 'unexpected-mark\\n'; }",
      extractShellFunction(source, "openclaw_reap_exited_gateway"),
      "rc=0; openclaw_reap_exited_gateway || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("rc:2\n");
    expect(result.stderr).toContain("refusing to");
    expect(result.stdout).not.toContain("unexpected-wait");
    expect(result.stdout).not.toContain("unexpected-mark");
  });
});

describe("managed gateway restart config boundary", () => {
  it("routes unrecoverable seal failure through whole-container gateway revocation", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -uo pipefail",
      "GATEWAY_PID=4242",
      'GATEWAY_PID_START_IDENTITY="777"',
      "gateway_control_take_request() { GATEWAY_CONTROL_ACTION=restart; printf 'take-request\\n'; }",
      "prepare_openclaw_gateway_restart() { printf 'prepare\\n'; return 0; }",
      'run_openclaw_config_guard() { printf "guard:%s\\n" "$1"; [ "$1" != "seal-restart" ]; }',
      "restore_openclaw_restart_config() { printf 'restore-failed\\n'; return 1; }",
      "stop_openclaw_gateway_fail_closed() { printf 'fail-closed-stop\\n'; }",
      'gateway_control_fail() { printf "fail:%s:%s\\n" "$1" "$2"; }',
      extractShellFunction(source, "handle_openclaw_gateway_control_request"),
      "rc=0; handle_openclaw_gateway_control_request || rc=$?",
      'printf "rc:%s\\n" "$rc"',
    ].join("\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "take-request",
      "prepare",
      "guard:seal-restart",
      "restore-failed",
      "fail-closed-stop",
      "fail:unsafe-config:4242",
      "rc:1",
    ]);
  });

  it("removes only regular gateway locks and refuses a matching attacker directory", () => {
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-lock-cleanup-"));
    const parent = path.join(tmpDir, "openclaw-test");
    const regularLock = path.join(parent, "gateway.good.lock");
    const plantedDirectory = path.join(parent, "gateway.evil.lock");
    const sentinel = path.join(plantedDirectory, "sentinel");
    fs.mkdirSync(plantedDirectory, { recursive: true });
    fs.writeFileSync(regularLock, "lock\n");
    fs.writeFileSync(sentinel, "keep\n");

    const cleanup = extractShellFunction(source, "cleanup_openclaw_gateway_locks").replace(
      'os.open("/tmp", directory_flags)',
      `os.open(${JSON.stringify(tmpDir)}, directory_flags)`,
    );
    const script = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      script,
      ["#!/usr/bin/env bash", "set -euo pipefail", cleanup, "cleanup_openclaw_gateway_locks"].join(
        "\n",
      ),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(regularLock)).toBe(false);
      expect(fs.readFileSync(sentinel, "utf-8")).toBe("keep\n");
      expect(result.stderr).toContain("refusing non-regular lock entry");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("record_gateway_pid", () => {
  it("replaces a planted symlink without writing through it during the pidfile race (#4710)", () => {
    // In root mode the pidfile lives in sticky /tmp; a sandbox process can
    // plant a symlink at that path between respawns. The update must replace
    // the symlink as a directory entry (atomic rename), never open it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-pid-symlink-"));
    try {
      const pidFile = path.join(tmpDir, "gateway.pid");
      const sensitiveTarget = path.join(tmpDir, "sensitive.txt");
      fs.writeFileSync(sensitiveTarget, "do not touch", { mode: 0o600 });
      fs.symlinkSync(sensitiveTarget, pidFile);

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
          safeTmpHelpers(fs.readFileSync(START_SCRIPT, "utf-8")),
          extractShellFunction(fs.readFileSync(START_SCRIPT, "utf-8"), "record_gateway_pid"),
          "record_gateway_pid 4242 987654",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      // O_NOFOLLOW makes a single open both the not-a-symlink assertion and
      // the content read — no check-then-use window.
      const fd = fs.openSync(pidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(fs.readFileSync(fd, "utf-8")).toBe("4242 987654\n");
      } finally {
        fs.closeSync(fd);
      }
      // The symlink target was never opened, written, or chmod-ed.
      expect(fs.readFileSync(sensitiveTarget, "utf-8")).toBe("do not touch");
      expect((fs.statSync(sensitiveTarget).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes the pidfile with 600 permissions, replacing any preexisting file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-pid-"));
    try {
      const pidFile = path.join(tmpDir, "gateway.pid");
      // Adversarial preexisting file: wrong content, restrictive mode.
      fs.writeFileSync(pidFile, "99999", { mode: 0o600 });

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
          safeTmpHelpers(fs.readFileSync(START_SCRIPT, "utf-8")),
          extractShellFunction(fs.readFileSync(START_SCRIPT, "utf-8"), "record_gateway_pid"),
          "record_gateway_pid 4242 987654",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.readFileSync(pidFile, "utf-8")).toBe("4242 987654\n");
      expect((fs.statSync(pidFile).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("clears the pid/starttime record when the tracked gateway is marked stopped", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-pid-clear-"));
    const pidFile = path.join(tmpDir, "gateway.pid");
    const script = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
        "GATEWAY_PID=4242",
        "GATEWAY_PID_START_IDENTITY=987654",
        "SANDBOX_WAIT_PID=4242",
        safeTmpHelpers(src),
        extractShellFunction(src, "record_gateway_pid"),
        extractShellFunction(src, "clear_gateway_pid_record"),
        "refresh_openclaw_supervised_child_pids() { SANDBOX_CHILD_PIDS=(); }",
        extractShellFunction(src, "mark_openclaw_gateway_stopped"),
        'record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"',
        "mark_openclaw_gateway_stopped",
        'printf "PID=%s ID=%s WAIT=%s\\n" "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY" "$SANDBOX_WAIT_PID"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("PID=0 ID= WAIT=\n");
      expect(fs.readFileSync(pidFile, "utf-8")).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("gateway_pid_is_openclaw_gateway", () => {
  function checkCmdline(rawCmdline: Buffer | null): number | null {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-cmdline-"));
    try {
      const procRoot = path.join(tmpDir, "proc");
      for (const cmdline of rawCmdline === null ? [] : [rawCmdline]) {
        fs.mkdirSync(path.join(procRoot, "4242"), { recursive: true });
        fs.writeFileSync(path.join(procRoot, "4242", "cmdline"), cmdline);
      }
      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
          extractShellFunction(
            fs.readFileSync(START_SCRIPT, "utf-8"),
            "gateway_pid_is_openclaw_gateway",
          ),
          "gateway_pid_is_openclaw_gateway 4242",
        ].join("\n"),
        { mode: 0o755 },
      );
      return spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 }).status;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const nulArgv = (...argv: string[]): Buffer => Buffer.from(`${argv.join("\u0000")}\u0000`);

  it("matches the launch argv and both rewritten process-title forms", () => {
    // Launch argv as /proc presents it: NUL-separated.
    expect(
      checkCmdline(nulArgv("node", "/usr/local/bin/openclaw", "gateway", "run", "--port", "18789")),
    ).toBe(0);
    // Rewritten titles observed across OpenClaw builds (#4710).
    expect(checkCmdline(nulArgv("openclaw-gateway"))).toBe(0);
    expect(checkCmdline(nulArgv("openclaw"))).toBe(0);
  });

  it("rejects reused PIDs, empty cmdlines, and missing proc entries", () => {
    expect(checkCmdline(nulArgv("vim", "notes.txt"))).not.toBe(0);
    expect(checkCmdline(nulArgv("sleep", "60"))).not.toBe(0);
    expect(checkCmdline(Buffer.from(""))).not.toBe(0);
    expect(checkCmdline(null)).not.toBe(0);
  });
});

describe("openclaw_gateway_healthy listener ownership", () => {
  function checkHealth(listenerOwned: boolean): {
    result: ReturnType<typeof spawnSync>;
    events: string;
  } {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-health-owner-"));
    const eventLog = path.join(tmpDir, "events.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "_DASHBOARD_PORT=19000",
        `EVENT_LOG=${JSON.stringify(eventLog)}`,
        `LISTENER_OWNED=${listenerOwned ? "1" : "0"}`,
        "openclaw_gateway_pid_owns_listener() {",
        '  printf "owner-check:%s:%s\\n" "$1" "$2" >>"$EVENT_LOG"',
        '  [ "$LISTENER_OWNED" -eq 1 ]',
        "}",
        "curl() {",
        '  printf "http-probe\\n" >>"$EVENT_LOG"',
        '  printf "200"',
        "}",
        'openclaw_supervised_pid_is_live() { [ "$1:$2" = "4242:valid-start" ]; }',
        extractShellFunction(src, "openclaw_gateway_healthy"),
        'if openclaw_gateway_healthy 4242 valid-start; then printf "healthy\\n"; else printf "unhealthy\\n"; fi',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      return { result, events: readFileIfPresent(eventLog) ?? "" };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("rejects HTTP 200 from a listener not owned by the tracked gateway process", () => {
    const { result, events } = checkHealth(false);
    expect(result.status, `script failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("unhealthy\n");
    expect(events).toBe("http-probe\nowner-check:4242:19000\n");
  });

  it("accepts HTTP 200 only after listener ownership is established", () => {
    const { result, events } = checkHealth(true);
    expect(result.status, `script failed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe("healthy\n");
    expect(events).toBe("http-probe\nowner-check:4242:19000\n");
  });

  it("rejects a PID1-adopted recycled PID even when its cmdline and listener look valid", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-reused-identity-"));
    const procRoot = path.join(tmpDir, "proc");
    const eventLog = path.join(tmpDir, "events.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(path.join(procRoot, "4242"), { recursive: true });
    fs.writeFileSync(path.join(procRoot, "4242", "cmdline"), "openclaw-gateway\0");

    const supervisedAsPid1 = extractShellFunction(src, "openclaw_supervised_pid_is_live").replace(
      '"$$"',
      '"1"',
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `_NEMOCLAW_PROC_ROOT=${JSON.stringify(procRoot)}`,
        `_DASHBOARD_PORT=19000`,
        `EVENT_LOG=${JSON.stringify(eventLog)}`,
        writeProcStatFunction,
        'write_proc_stat 4242 1 222222 >"$_NEMOCLAW_PROC_ROOT/4242/stat"',
        pidIdentityFunctions(src),
        supervisedAsPid1,
        extractShellFunction(src, "gateway_pid_is_openclaw_gateway"),
        'openclaw_gateway_pid_owns_listener() { printf "listener-called\\n" >>"$EVENT_LOG"; return 0; }',
        'curl() { printf "200"; }',
        extractShellFunction(src, "openclaw_gateway_healthy"),
        'gateway_pid_is_openclaw_gateway 4242 && printf "LOOKS_OPENCLAW=1\\n"',
        'if openclaw_gateway_healthy 4242 111111; then printf "HEALTHY=1\\n"; else printf "HEALTHY=0\\n"; fi',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("LOOKS_OPENCLAW=1\nHEALTHY=0\n");
      expect(readFileIfPresent(eventLog)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("healthcheck marker (#4503, #4710)", () => {
  // Behavioral test of the marker function: confirms the helper itself writes
  // an empty file at the target path and is a no-op when the path is already
  // present (idempotent restart-loop semantics). The launch-wiring suite
  // below proves the marker is dropped by the launch path itself (and only
  // there), independent of env hints like OPENSHELL_DRIVERS.
  it("mark_in_container_gateway writes the marker file idempotently (#4710)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gw-marker-"));
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const fnSrc = extractShellFunction(src, "mark_in_container_gateway").replaceAll(
      "/tmp/nemoclaw-gateway-local",
      markerPath,
    );

    try {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        safeTmpHelpers(src),
        fnSrc,
        "mark_in_container_gateway",
        "mark_in_container_gateway", // second call must be a no-op
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      // statSync throws when the marker is missing, so this single call
      // asserts both existence and emptiness (`:` redirected, not appended).
      expect(fs.statSync(markerPath).size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Behavioral wiring coverage: run the real launch block of each entrypoint
// mode with the real marker/pidfile/watchdog helpers and assert their
// runtime effects. This replaces source-text assertions (banned by
// ci/source-shape-test-budget.json) and locks the #4748 regression
// behaviorally: OPENSHELL_DRIVERS is exported during the run and must have
// no influence on whether the marker is dropped.
describe("gateway launch wiring (#4710)", () => {
  it("exits PID 1 without signaling when gateway identity capture fails", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const launch = extractShellFunction(src, "launch_openclaw_gateway");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launch-capture-failure-"));
    const eventLog = path.join(tmpDir, "events.log");
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        [
          "set -uo pipefail",
          `EVENT_LOG=${JSON.stringify(eventLog)}`,
          "STEP_DOWN_PREFIX_GATEWAY=()",
          "OPENCLAW=/usr/bin/true",
          "_DASHBOARD_PORT=19000",
          "GATEWAY_PID=0",
          "GATEWAY_PID_START_IDENTITY=",
          "mark_in_container_gateway() { :; }",
          "capture_openclaw_pid_start_identity() { return 1; }",
          'clear_gateway_pid_record() { printf "clear\\n" >>"$EVENT_LOG"; }',
          'kill() { printf "unexpected-kill:%s\\n" "$*" >>"$EVENT_LOG"; }',
          'wait() { printf "unexpected-wait:%s\\n" "$*" >>"$EVENT_LOG"; }',
          launch,
          "launch_openclaw_gateway",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not capture gateway process identity");
    expect(fs.readFileSync(eventLog, "utf-8")).toBe("clear\n");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function launchBlock(src: string, kind: "non-root" | "root"): string {
    const startMarker =
      kind === "non-root"
        ? "# Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const start = src.indexOf(startMarker);
    const trap = src.indexOf("trap cleanup_openclaw_on_signal SIGTERM SIGINT", start);
    expect(start, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(
      -1,
    );
    expect(trap, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(-1);
    return src.slice(start, src.indexOf("\n", trap));
  }

  function runLaunchWiring(kind: "non-root" | "root") {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-launch-wiring-${kind}-`));
    const fakeBin = path.join(tmpDir, "bin");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const pidFile = path.join(tmpDir, "gateway.pid");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(openclawLog)}\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, "gosu"), `#!/usr/bin/env bash\nshift\nexec "$@"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(gatewayLog, "gateway booting\n");

    const realFunctions = [
      safeTmpHelpers(src),
      extractShellFunction(src, "mark_in_container_gateway").replaceAll(
        "/tmp/nemoclaw-gateway-local",
        markerPath,
      ),
      extractShellFunction(src, "record_gateway_pid"),
      extractShellFunction(src, "gateway_pid_is_openclaw_gateway"),
      extractShellFunction(src, "gateway_watchdog_positive_int_ok"),
      extractShellFunction(src, "start_gateway_serving_watchdog"),
      rootGatewayLifecycleFunctions(src, gatewayLog),
    ].join("\n");

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export PATH=${JSON.stringify(`${fakeBin}:${process.env.PATH || ""}`)}`,
        `OPENCLAW=${JSON.stringify(path.join(fakeBin, "openclaw"))}`,
        '_DASHBOARD_PORT="19000"',
        // #4748 regression lock: the env hint must have NO influence on the
        // marker — it is dropped because this block launches the gateway.
        "export OPENSHELL_DRIVERS=docker",
        `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
        // Keep the watchdog idle for the duration of the test run.
        "export NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS=300",
        'start_persistent_gateway_log_mirror() { command sleep 30 & GATEWAY_LOG_PERSIST_PID=$!; capture_openclaw_pid_start_identity "$GATEWAY_LOG_PERSIST_PID" GATEWAY_LOG_PERSIST_PID_START_IDENTITY; }',
        'start_auto_pair() { command sleep 30 & AUTO_PAIR_PID=$!; capture_openclaw_pid_start_identity "$AUTO_PAIR_PID" AUTO_PAIR_PID_START_IDENTITY; }',
        "start_plugin_registry_refresh() { :; }",
        "cleanup_on_signal() { :; }",
        "STEP_DOWN_PREFIX_SANDBOX=(gosu sandbox)",
        "STEP_DOWN_PREFIX_GATEWAY=(gosu gateway)",
        realFunctions,
        launchBlock(src, kind).replaceAll("/tmp/gateway.log", gatewayLog),
        `for _ in $(command seq 1 100); do [ -s ${JSON.stringify(openclawLog)} ] && break; command sleep 0.1; done`,
        'printf "GATEWAY_PID=%s\\n" "$GATEWAY_PID"',
        'printf "WATCHDOG_PID=%s\\n" "${GATEWAY_WATCHDOG_PID:-}"',
        'printf "CHILD_PIDS=%s\\n" "${SANDBOX_CHILD_PIDS[*]}"',
        'if [ -n "${GATEWAY_WATCHDOG_PID:-}" ] && kill -0 "$GATEWAY_WATCHDOG_PID" 2>/dev/null; then printf "WATCHDOG_ALIVE=1\\n"; fi',
        "disown -a 2>/dev/null || true",
        'for pid in "${SANDBOX_CHILD_PIDS[@]}"; do pkill -P "$pid" 2>/dev/null || true; kill -9 "$pid" 2>/dev/null || true; done',
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 15_000 });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const gatewayPid = stdout.match(/^GATEWAY_PID=(\d+)$/m)?.[1];
    const watchdogPid = stdout.match(/^WATCHDOG_PID=(\d+)$/m)?.[1];
    const childPids = (stdout.match(/^CHILD_PIDS=(.+)$/m)?.[1] ?? "").split(/\s+/);
    const pidFileContent = readFileIfPresent(pidFile)?.trim() ?? null;
    const markerExists = readFileIfPresent(markerPath) !== null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, stdout, gatewayPid, watchdogPid, childPids, pidFileContent, markerExists };
  }

  it.each([
    "non-root",
    "root",
  ] as const)("%s launch drops the marker, records the gateway PID, and starts the tracked watchdog", (kind) => {
    const run = runLaunchWiring(kind);
    expect(run.result.status, `script failed: ${run.result.stderr}`).toBe(0);
    // Marker dropped by the launch site, even with OPENSHELL_DRIVERS=docker
    // exported — env hints must not gate it (#4748 was a no-op for this).
    expect(run.markerExists).toBe(true);
    // The watchdog reads the gateway PID from the pidfile each cycle.
    expect(run.gatewayPid).toBeDefined();
    expect(run.pidFileContent?.split(" ")[0]).toBe(run.gatewayPid);
    // The watchdog runs and is registered for SIGTERM cleanup.
    expect(run.watchdogPid).toBeDefined();
    expect(run.stdout).toContain("WATCHDOG_ALIVE=1");
    expect(run.childPids).toContain(run.watchdogPid);
    expect(run.childPids).toContain(run.gatewayPid);
  });
});

// The respawn loop reassigns GATEWAY_PID when it relaunches a dead gateway;
// it must refresh the pidfile too, or the watchdog would keep reading the
// dead PID and go inert for the rest of the sandbox's life.
describe("respawn loop pidfile refresh (#4710)", () => {
  function respawnLoop(src: string, kind: "non-root" | "root"): string {
    const first = src.indexOf("RESPAWN_TIMES=()");
    const start = kind === "non-root" ? first : src.indexOf("RESPAWN_TIMES=()", first + 1);
    expect(start, `Expected ${kind} respawn loop in scripts/nemoclaw-start.sh`).not.toBe(-1);
    const endToken = kind === "non-root" ? "\n  done" : "\ndone";
    const end = src.indexOf(endToken, start);
    expect(end, `Expected ${kind} respawn loop terminator in scripts/nemoclaw-start.sh`).not.toBe(
      -1,
    );
    return src.slice(start, end + endToken.length);
  }

  it.each([
    "non-root",
    "root",
  ] as const)("%s respawn records the relaunched gateway PID in the pidfile", (kind) => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-respawn-${kind}-`));
    const fakeBin = path.join(tmpDir, "bin");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const pidFile = path.join(tmpDir, "gateway.pid");
    const initialPidFile = path.join(tmpDir, "initial.pid");
    const restoreSentinel = path.join(tmpDir, "runtime-guards-restored");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\n[ -f ${JSON.stringify(restoreSentinel)} ] || exit 97\nprintf '%s\\n' "$*" >> ${JSON.stringify(openclawLog)}\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(fakeBin, "gosu"), `#!/usr/bin/env bash\nshift\nexec "$@"\n`, {
      mode: 0o755,
    });

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -o pipefail",
        `export PATH=${JSON.stringify(`${fakeBin}:${process.env.PATH || ""}`)}`,
        `OPENCLAW=${JSON.stringify(path.join(fakeBin, "openclaw"))}`,
        '_DASHBOARD_PORT="19000"',
        `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
        "STEP_DOWN_PREFIX_GATEWAY=(gosu gateway)",
        `prepare_openclaw_automatic_respawn() { printf restored >${JSON.stringify(restoreSentinel)}; }`,
        // The loop sleeps 2s between respawns; keep the test fast.
        "sleep() { command sleep 0.05; }",
        safeTmpHelpers(src),
        extractShellFunction(src, "record_gateway_pid"),
        extractShellFunction(src, "clear_gateway_pid_record"),
        rootGatewayLifecycleFunctions(src, gatewayLog),
        kind === "root" ? "mark_in_container_gateway() { :; }" : "",
        kind === "root" ? "GATEWAY_CONTROL_SIGNAL_PENDING=0" : "",
        kind === "root" ? "handle_openclaw_gateway_control_request() { :; }" : "",
        kind === "root"
          ? 'openclaw_supervised_pid_is_live() { local current; gateway_control_pid_is_live "$1" || return 1; current="$(openclaw_pid_start_identity "$1")" || return 1; [ "$current" = "$2" ]; }'
          : "",
        kind === "root" ? "gateway_pid_is_openclaw_gateway() { return 0; }" : "",
        "SANDBOX_CHILD_PIDS=()",
        "SANDBOX_WAIT_PID=",
        "(",
        // A gateway that dies immediately with a non-zero status drives
        // exactly one respawn iteration.
        '  bash -c "sleep 0.1; exit 7" &',
        "  GATEWAY_PID=$!",
        '  GATEWAY_PID_START_IDENTITY="$(openclaw_pid_start_identity "$GATEWAY_PID")"',
        '  record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"',
        `  printf '%s' "$GATEWAY_PID" > ${JSON.stringify(initialPidFile)}`,
        respawnLoop(src, kind).replaceAll("/tmp/gateway.log", gatewayLog),
        ") &",
        "LOOP_PID=$!",
        'INITIAL=""; CURRENT=""',
        "for _ in $(command seq 1 200); do",
        `  INITIAL="$(cat ${JSON.stringify(initialPidFile)} 2>/dev/null || true)"`,
        `  CURRENT="$(awk '{ print $1 }' ${JSON.stringify(pidFile)} 2>/dev/null || true)"`,
        '  if [ -n "$INITIAL" ] && [ -n "$CURRENT" ] && [ "$CURRENT" != "$INITIAL" ]; then break; fi',
        "  command sleep 0.05",
        "done",
        // The pidfile is refreshed at spawn time; give the respawned stub a
        // moment to actually execute and write its argv log before cleanup.
        `for _ in $(command seq 1 100); do [ -s ${JSON.stringify(openclawLog)} ] && break; command sleep 0.05; done`,
        'printf "INITIAL=%s\\n" "$INITIAL"',
        'printf "CURRENT=%s\\n" "$CURRENT"',
        'if [ -n "$CURRENT" ] && kill -0 "$CURRENT" 2>/dev/null; then printf "RESPAWNED_ALIVE=1\\n"; fi',
        "disown -a 2>/dev/null || true",
        // Kill the loop before its gateway so it cannot respawn again.
        'kill -9 "$LOOP_PID" 2>/dev/null || true',
        'pkill -P "$LOOP_PID" 2>/dev/null || true',
        '[ -n "$CURRENT" ] && kill -9 "$CURRENT" 2>/dev/null || true',
        "exit 0",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 20_000 });
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      const initial = stdout.match(/^INITIAL=(\d+)$/m)?.[1];
      const current = stdout.match(/^CURRENT=(\d+)$/m)?.[1];
      expect(initial, `no initial pid in: ${stdout}`).toBeDefined();
      expect(current, `no current pid in: ${stdout}`).toBeDefined();
      expect(current).not.toBe(initial);
      expect(stdout).toContain("RESPAWNED_ALIVE=1");
      expect(fs.readFileSync(restoreSentinel, "utf-8")).toBe("restored");
      expect(fs.readFileSync(openclawLog, "utf-8")).toContain("gateway run --port 19000");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("services a supervisor request that interrupts root respawn backoff before relaunch", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const supervisor = fs.readFileSync(GATEWAY_SUPERVISOR, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-respawn-control-race-"));
    const eventLog = path.join(tmpDir, "events.log");
    const launchPidFile = path.join(tmpDir, "automatic-launch.pid");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const scriptPath = path.join(tmpDir, "run.sh");

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `EVENT_LOG=${JSON.stringify(eventLog)}`,
        `LAUNCH_PID_FILE=${JSON.stringify(launchPidFile)}`,
        "GATEWAY_CONTROL_SIGNAL_PENDING=0",
        "GATEWAY_PID_START_IDENTITY=reused-start",
        "GATEWAY_REAPED=0",
        "REUSED_GATEWAY_PID=0",
        // Model USR1 interrupting the two-second crash backoff. Returning a
        // signal-like status also proves the production sleep is guarded from
        // errexit before it inspects the pending flag.
        "sleep() {",
        '  if [ "${1:-}" = "2" ]; then',
        '    printf "backoff-interrupted\\n" >>"$EVENT_LOG"',
        "    GATEWAY_CONTROL_SIGNAL_PENDING=1",
        "    return 130",
        "  fi",
        "  command sleep 0.02",
        "}",
        extractShellFunction(supervisor, "gateway_control_pid_is_live").replace(
          "gateway_control_pid_is_live() {",
          "gateway_control_pid_is_live_real() {",
        ),
        "gateway_control_pid_is_live() {",
        '  if [ "$GATEWAY_REAPED" -eq 1 ] && [ "$1" = "$REUSED_GATEWAY_PID" ]; then return 0; fi',
        '  gateway_control_pid_is_live_real "$1"',
        "}",
        "gateway_control_pid_state() { printf 'Z\\n'; }",
        'openclaw_pid_start_identity() { printf "%s\\n" "$GATEWAY_PID_START_IDENTITY"; }',
        "openclaw_supervised_pid_is_live() { return 1; }",
        "gateway_pid_is_openclaw_gateway() { return 1; }",
        "wait() {",
        "  local rc=0",
        '  builtin wait "$@" || rc=$?',
        "  GATEWAY_REAPED=1",
        '  return "$rc"',
        "}",
        "handle_openclaw_gateway_control_request() {",
        '  printf "request-handled:tracked=%s\\n" "$GATEWAY_PID" >>"$EVENT_LOG"',
        '  [ "$GATEWAY_PID" -eq 0 ] || exit 91',
        // End the extracted infinite PID 1 loop once the assertion event has
        // occurred. The surrounding subshell lets the harness continue.
        "  exit 0",
        "}",
        "launch_openclaw_gateway() {",
        '  printf "automatic-relaunch\\n" >>"$EVENT_LOG"',
        "  command sleep 30 &",
        "  GATEWAY_PID=$!",
        '  printf "%s\\n" "$GATEWAY_PID" >"$LAUNCH_PID_FILE"',
        "}",
        "refresh_openclaw_supervised_child_pids() { :; }",
        extractShellFunction(src, "mark_openclaw_gateway_stopped"),
        extractShellFunction(src, "openclaw_reap_exited_gateway"),
        "(",
        '  bash -c "exit 7" &',
        "  GATEWAY_PID=$!",
        '  REUSED_GATEWAY_PID="$GATEWAY_PID"',
        respawnLoop(src, "root").replaceAll("/tmp/gateway.log", gatewayLog),
        ")",
        // Defensive cleanup makes the harness safe against a regression that
        // performs the automatic relaunch before servicing the request.
        'if [ -s "$LAUNCH_PID_FILE" ]; then kill -9 "$(cat "$LAUNCH_PID_FILE")" 2>/dev/null || true; fi',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.readFileSync(eventLog, "utf-8")).toBe(
        "backoff-interrupted\nrequest-handled:tracked=0\n",
      );
      expect(readFileIfPresent(launchPidFile)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Launch-path signal handling and child-PID tracking for both entrypoint
// modes. Moved from test/nemoclaw-start.test.ts so the legacy file stays
// under its ratcheted size budget; this file owns gateway-launch coverage.
describe("nemoclaw-start gateway launch signal handling", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function launchBlock(kind: "non-root" | "root", gatewayLog: string): string {
    const startMarker =
      kind === "non-root"
        ? "# Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const start = src.indexOf(startMarker);
    const trap = src.indexOf("trap cleanup_openclaw_on_signal SIGTERM SIGINT", start);
    expect(start, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(
      -1,
    );
    expect(trap, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(-1);
    const lineEnd = src.indexOf("\n", trap);
    return src.slice(start, lineEnd).replaceAll("/tmp/gateway.log", gatewayLog);
  }

  function runLaunchBlock(kind: "non-root" | "root") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-launch-${kind}-`));
    const fakeBin = path.join(tmpDir, "bin");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const gosuLog = path.join(tmpDir, "gosu.log");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const markerPath = path.join(tmpDir, "nemoclaw-gateway-local");
    const scriptPath = path.join(tmpDir, "run.sh");
    const waitForLaunchLogIterations = Array.from({ length: 100 }, (_, i) => String(i + 1)).join(
      " ",
    );
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(openclawLog)}\nif [ -f ${JSON.stringify(markerPath)} ]; then printf 'marker=present\\n' >> ${JSON.stringify(openclawLog)}; else printf 'marker=absent\\n' >> ${JSON.stringify(openclawLog)}; fi\nprintf 'state=%s oauth=%s home=%s config=%s\\n' "$OPENCLAW_STATE_DIR" "$OPENCLAW_OAUTH_DIR" "$OPENCLAW_HOME" "$OPENCLAW_CONFIG_PATH" >> ${JSON.stringify(openclawLog)}\nprintf 'gateway stdout marker\\n'\nprintf 'gateway stderr marker\\n' >&2\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "gosu"),
      `#!/usr/bin/env bash\nprintf 'user=%s args=%s\\n' "$1" "${"$*"}" >> ${JSON.stringify(gosuLog)}\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(gatewayLog, "gateway booting\n");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export PATH=${JSON.stringify(`${fakeBin}:${process.env.PATH || ""}`)}`,
        `OPENCLAW=${JSON.stringify(path.join(fakeBin, "openclaw"))}`,
        "export OPENCLAW_HOME=/sandbox",
        "export OPENCLAW_STATE_DIR=/sandbox/.openclaw",
        "export OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json",
        "export OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials",
        '_DASHBOARD_PORT="19000"',
        'start_persistent_gateway_log_mirror() { sleep 30 & GATEWAY_LOG_PERSIST_PID=$!; capture_openclaw_pid_start_identity "$GATEWAY_LOG_PERSIST_PID" GATEWAY_LOG_PERSIST_PID_START_IDENTITY; }',
        'start_auto_pair() { sleep 30 & AUTO_PAIR_PID=$!; capture_openclaw_pid_start_identity "$AUTO_PAIR_PID" AUTO_PAIR_PID_START_IDENTITY; }',
        "start_plugin_registry_refresh() { :; }",
        "cleanup_on_signal() { :; }",
        safeTmpHelpers(src),
        extractShellFunction(src, "mark_in_container_gateway").replaceAll(
          "/tmp/nemoclaw-gateway-local",
          markerPath,
        ),
        // #4710: the launch block also records the gateway PID for the
        // serving watchdog and starts the watchdog alongside the other
        // background services. Stub both — watchdog behavior has its own
        // suite in test/nemoclaw-start-gateway-health.test.ts.
        "record_gateway_pid() { :; }",
        'start_gateway_serving_watchdog() { sleep 30 & GATEWAY_WATCHDOG_PID=$!; capture_openclaw_pid_start_identity "$GATEWAY_WATCHDOG_PID" GATEWAY_WATCHDOG_PID_START_IDENTITY; }',
        rootGatewayLifecycleFunctions(src, gatewayLog),
        "STEP_DOWN_PREFIX_SANDBOX=(gosu sandbox)",
        "STEP_DOWN_PREFIX_GATEWAY=(gosu gateway)",
        launchBlock(kind, gatewayLog),
        kind === "root"
          ? `for _ in ${waitForLaunchLogIterations}; do [ -s ${JSON.stringify(gosuLog)} ] && [ -s ${JSON.stringify(openclawLog)} ] && break; sleep 0.1; done`
          : `for _ in ${waitForLaunchLogIterations}; do [ -s ${JSON.stringify(openclawLog)} ] && break; sleep 0.1; done`,
        'printf "GATEWAY_PID=%s\\n" "$GATEWAY_PID"',
        'printf "AUTO_PAIR_PID=%s\\n" "${AUTO_PAIR_PID:-}"',
        'printf "TAIL_PID=%s\\n" "${GATEWAY_LOG_TAIL_PID:-}"',
        'printf "PERSIST_PID=%s\\n" "${GATEWAY_LOG_PERSIST_PID:-}"',
        'printf "WAIT_PID=%s\\n" "$SANDBOX_WAIT_PID"',
        'printf "CHILD_PIDS=%s\\n" "${SANDBOX_CHILD_PIDS[*]}"',
        "trap -p SIGTERM",
        'for pid in "${SANDBOX_CHILD_PIDS[@]}"; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done',
        'for pid in "${SANDBOX_CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done',
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 15_000 });
    const openclaw = readFileIfPresent(openclawLog) ?? "";
    const gosu = readFileIfPresent(gosuLog) ?? "";
    const gateway = readFileIfPresent(gatewayLog) ?? "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, openclaw, gosu, gateway };
  }

  it("registers child PIDs, redirects gateway output, and traps signals in non-root mode", () => {
    const { result, openclaw, gateway } = runLaunchBlock("non-root");
    expect(result.status).toBe(0);
    expect(openclaw).toContain("gateway run --port 19000");
    expect(openclaw).toContain("marker=present");
    expect(openclaw).not.toContain("marker=absent");
    expect(openclaw).toContain(
      "state=/sandbox/.openclaw oauth=/sandbox/.openclaw/credentials home=/sandbox config=/sandbox/.openclaw/openclaw.json",
    );
    expect(gateway).toContain("gateway stdout marker");
    expect(gateway).toContain("gateway stderr marker");
    expect(result.stdout).not.toContain("gateway stdout marker");
    const stdout = result.stdout;
    const gatewayPid = stdout.match(/GATEWAY_PID=(\d+)/)?.[1];
    expect(gatewayPid).toBeTruthy();
    expect(stdout).toContain(`WAIT_PID=${gatewayPid}`);
    expect(stdout).toContain(`CHILD_PIDS=${gatewayPid}`);
    expect(stdout).toMatch(/AUTO_PAIR_PID=\d+/);
    expect(stdout).toMatch(/TAIL_PID=\d+/);
    expect(stdout).toMatch(/PERSIST_PID=\d+/);
    expect(stdout).toContain("cleanup_openclaw_on_signal");
  });

  it("launches the root gateway through gosu with the configured port and tracks child PIDs", () => {
    const { result, openclaw, gosu } = runLaunchBlock("root");
    expect(result.status).toBe(0);
    expect(gosu).toContain("user=gateway");
    expect(gosu).toContain("gateway run --port 19000");
    expect(openclaw).toContain("marker=present");
    expect(openclaw).not.toContain("marker=absent");
    expect(openclaw).toContain(
      "state=/sandbox/.openclaw oauth=/sandbox/.openclaw/credentials home=/sandbox config=/sandbox/.openclaw/openclaw.json",
    );
    const gatewayPid = result.stdout.match(/GATEWAY_PID=(\d+)/)?.[1];
    expect(gatewayPid).toBeTruthy();
    expect(result.stdout).toContain(`WAIT_PID=${gatewayPid}`);
    expect(result.stdout).toContain(`CHILD_PIDS=${gatewayPid}`);
    expect(result.stdout).toMatch(/AUTO_PAIR_PID=\d+/);
    expect(result.stdout).toMatch(/TAIL_PID=\d+/);
    expect(result.stdout).toMatch(/PERSIST_PID=\d+/);
    expect(result.stdout).toContain("cleanup_openclaw_on_signal");
  });
});
