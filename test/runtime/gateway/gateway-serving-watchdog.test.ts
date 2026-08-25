// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Gateway serving watchdog coverage for scripts/nemoclaw-start.sh (#4710,
// #7377). The OpenClaw gateway can stop serving while its process stays alive
// (a failed in-process SIGUSR1 restart parks it with no usable listener), and
// the #2757 respawn loop only sees process exit. The watchdog must recognize
// every not-serving outcome: refused, timed out, reset, or an HTTP error
// response. It must kill the gateway so the respawn loop can relaunch it while
// preserving a never-served gateway through the boot grace window and never
// touching one whose probe could not run.
// Split from test/agents/openclaw/runtime/nemoclaw-start-gateway-health.test.ts, which is at its size
// budget (ci/test-file-size-budget.json).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractGatewayLogAppendFunction,
  extractShellFunction,
  pidIdentityFunctions,
  readFileIfPresent,
  START_SCRIPT,
  safeTmpHelpers,
  writeProcStatFunction,
} from "../../nemoclaw-start-gateway.test-helpers";

function watchdogFunctions(gatewayLog: string): string {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  return [
    safeTmpHelpers(src),
    pidIdentityFunctions(src),
    extractGatewayLogAppendFunction(src, gatewayLog),
    extractShellFunction(src, "record_gateway_pid"),
    extractShellFunction(src, "gateway_pid_is_openclaw_gateway"),
    extractShellFunction(src, "gateway_watchdog_positive_int_ok"),
    extractShellFunction(src, "gateway_watchdog_curl_reason"),
    extractShellFunction(src, "gateway_watchdog_probe_gateway"),
    extractShellFunction(src, "gateway_watchdog_pid_is_tracked_gateway"),
    extractShellFunction(src, "start_gateway_serving_watchdog"),
  ].join("\n");
}

// Drive the watchdog end-to-end against a real background process standing in
// for the gateway. `curlPlan` is the sequence of probe outcomes the stubbed
// curl returns, one per watchdog cycle; the last entry repeats forever. An
// entry is either a bare curl exit code (the stub then reports the HTTP status
// real curl would print: 200 on success, 000 on a transport failure) or an
// `"<exit>:<http-status>"` pair when the status itself is under test.
// The proc fixture under _NEMOCLAW_PROC_ROOT controls what the PID-identity
// check sees for the fake gateway.
// Set `curlUnavailable` to omit the stub and start the watchdog with an empty
// PATH, so its `command -v curl` guard sees no probe command at all. That is a
// different path from a probe that runs and fails, which `curlPlan` covers.
function runWatchdog(opts: {
  curlPlan: Array<number | string>;
  cmdline?: string;
  env?: Record<string, string>;
  // How long to let the watchdog run when no kill is expected (seconds).
  settleSeconds?: number;
  curlUnavailable?: boolean;
  // Claim a parent PID other than this shell, standing in for a gateway
  // that outlived its supervisor and was reparented.
  orphaned?: boolean;
  expectKill: boolean;
}): {
  result: ReturnType<typeof spawnSync>;
  fakeAlive: boolean;
  gatewayLog: string;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-"));
  const planFile = path.join(tmpDir, "curl-plan.txt");
  const gatewayLogFile = path.join(tmpDir, "gateway.log");
  fs.writeFileSync(gatewayLogFile, "", { mode: 0o644 });
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
    // curl stub: pop the next outcome off the plan; keep the last one. It
    // mirrors real `curl -w '%{http_code}'` by printing a status alongside the
    // exit code, which is what the watchdog's probe classifier reads.
    ...(opts.curlUnavailable
      ? []
      : [
          `_CURL_PLAN=${JSON.stringify(planFile)}`,
          "curl() {",
          "  local next rest code status",
          '  next="$(head -n1 "$_CURL_PLAN" 2>/dev/null)"',
          '  [ -n "$next" ] || next=0',
          '  rest="$(tail -n +2 "$_CURL_PLAN" 2>/dev/null)"',
          '  if [ -n "$rest" ]; then printf "%s\\n" "$rest" >"$_CURL_PLAN"; fi',
          '  code="${next%%:*}"',
          '  status="${next#*:}"',
          '  [ "$status" != "$next" ] || status=""',
          '  if [ -z "$status" ]; then',
          '    if [ "$code" = 0 ]; then status=200; else status=000; fi',
          "  fi",
          '  printf "%s" "$status"',
          '  return "$code"',
          "}",
        ]),
    // A real process stands in for the gateway so kill -0 / kill -TERM are
    // exercised for real; its claimed cmdline comes from the proc fixture.
    "command sleep 60 &",
    "FAKE_GATEWAY_PID=$!",
    "FAKE_GATEWAY_START=1001",
    `mkdir -p ${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID`,
    `printf '%s' ${JSON.stringify(opts.cmdline ?? "openclaw-gateway")} >${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID/cmdline`,
    `write_proc_stat "$FAKE_GATEWAY_PID" ${opts.orphaned ? "1" : '"$$"'} "$FAKE_GATEWAY_START" >${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID/stat`,
    watchdogFunctions(gatewayLogFile),
    'capture_openclaw_pid_start_identity() { printf -v "$2" "%s" "watchdog-test"; }',
    'record_gateway_pid "$FAKE_GATEWAY_PID" "$FAKE_GATEWAY_START"',
    ...(opts.curlUnavailable ? ['_SAVED_PATH="$PATH"', 'PATH=""'] : []),
    "start_gateway_serving_watchdog",
    ...(opts.curlUnavailable ? ['PATH="$_SAVED_PATH"'] : []),
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
  const gatewayLog = readFileIfPresent(gatewayLogFile) ?? "";
  return { result, fakeAlive, gatewayLog, tmpDir };
}

describe("gateway serving watchdog (#4710, #7377)", () => {
  it("kills a gateway after four refused probes following a serving response", () => {
    const { result, fakeAlive, gatewayLog, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 7],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("[gateway-watchdog] CRITICAL");
      expect(result.stderr).toContain("connection refused");
      expect(gatewayLog).toContain("[gateway-watchdog] CRITICAL");
      expect(gatewayLog).toContain("[gateway-watchdog] CRITICAL");
      expect(gatewayLog).toContain("(#7377)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps a gateway that has not served yet inside the boot grace window", () => {
    // A gateway that is still booting refuses from the start, and the watchdog
    // cannot tell that apart from one that came up broken. It must wait out the
    // slowest plausible boot before acting, while still reporting what it sees.
    const { result, fakeAlive, gatewayLog, tmpDir } = runWatchdog({
      curlPlan: [7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES: "100000" },
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain("having never served");
      expect(result.stderr).not.toContain("CRITICAL");
      expect(gatewayLog).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers a gateway that never served after the boot grace window passes (#7377)", () => {
    // The QA reproduction on v0.0.102: a freshly onboarded sandbox whose
    // gateway was alive with a refused listener from launch. Requiring a prior
    // serving response to arm meant the watchdog never acted and never logged,
    // so the sandbox stayed wedged with no explanation.
    const { result, fakeAlive, gatewayLog, tmpDir } = runWatchdog({
      curlPlan: [7, 7, 7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES: "3" },
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("having never served");
      expect(result.stderr).toContain("[gateway-watchdog] CRITICAL");
      expect(gatewayLog).toContain("having never served");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("holds a never-served gateway to the boot grace window, not the serving threshold", () => {
    // Four not-serving probes would already have crossed the post-serving
    // threshold. An unproven gateway must survive them.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [7, 7, 7, 7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES: "1000" },
      expectKill: false,
      settleSeconds: 1.2,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain("(4/1000 since launch, having never served)");
      expect(result.stderr).not.toContain("CRITICAL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("switches a slow gateway to the serving threshold once it serves", () => {
    // A boot that refuses and then comes up must not be killed for those early
    // refusals, and from its first serving response it is held to the tighter
    // post-serving threshold. The boot grace window is set to 5 so that
    // recovery on the fourth post-serving probe can only come from the
    // threshold switch, not from the window it was counting against before.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [7, 7, 7, 0, 7, 7, 7, 7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES: "5" },
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("(3/5 since launch, having never served)");
      expect(result.stderr).toContain("(1/4 since the last serving response)");
      expect(result.stderr).toContain("4 not-serving probes since the last serving response");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to the default boot grace window when the override is invalid", () => {
    const { result, tmpDir } = runWatchdog({
      curlPlan: [7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES: "0" },
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(result.stderr).toContain(
        "invalid NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES='0'; defaulting to 20",
      );
      expect(result.stderr).toContain("(1/20 since launch, having never served)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resets the not-serving count after a serving response", () => {
    // Three not-serving probes, a serving response, and three more leave each
    // count below the threshold of four, so the gateway must survive.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 7, 0, 7, 7, 7, 0],
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).not.toContain("[gateway-watchdog] CRITICAL");
      expect(result.stderr).toContain("connection refused (1/4 since the last serving response)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // One case per transport outcome gateway_watchdog_probe_gateway classifies as
  // not serving, so narrowing that set fails the suite rather than silently
  // leaving a not-serving outcome unrecovered.
  it.each([
    ["probe timeout", 28, "probe timeout"],
    ["empty reply", 52, "empty reply from gateway"],
    ["send error", 55, "send error"],
    ["connection reset", 56, "connection reset"],
  ])("recovers a gateway after repeated %s probes (#7377)", (_label, exitCode, reason) => {
    // A listener that accepts and then stalls or drops the connection is just
    // as unusable as a refused port. This is the `1006 abnormal closure`
    // signature users see from `openclaw health`. Before #7377 these outcomes
    // counted as "listener present", so the watchdog silently rearmed forever
    // and the sandbox never recovered.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, exitCode, exitCode, exitCode, exitCode],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain("[gateway-watchdog] CRITICAL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers a gateway that answers /health with an HTTP error (#7377)", () => {
    // The process replies but is not serving sessions. Only 200/401 count as
    // serving, matching the response requirement the boot-time readiness gate
    // uses.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, "0:503", "0:503", "0:503", "0:503"],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("HTTP 503");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("treats a 401 health response as serving", () => {
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: ["0:401"],
      expectKill: false,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).not.toContain("[gateway-watchdog] CRITICAL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("counts alternating not-serving outcomes toward the threshold (#7377)", () => {
    // The reported sandboxes showed a refused port on a manual probe yet were
    // never recovered: the old counter demanded four *consecutive* refusals,
    // so any intervening timeout or reset reset it to zero forever.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 28, 7, 56],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("(4 not-serving probes since the last serving response)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports an inconclusive probe sequence once without killing the gateway (#7377)", () => {
    // `curl` exit codes outside the transport set mean a broken probe, not a
    // broken gateway. Escalating them would turn a missing or failing curl
    // into an endless kill loop against a gateway that may still be serving.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 127, 127, 127, 127, 127],
      expectKill: false,
      settleSeconds: 1.2,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain("health probe inconclusive (curl exit 127)");
      expect(result.stderr).not.toContain("[gateway-watchdog] CRITICAL");
      expect(String(result.stderr).match(/health probe inconclusive/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("disables itself without signaling the gateway when curl is unavailable (#7377)", () => {
    // With no probe command there is no evidence either way, so the watchdog
    // must stand down rather than run blind against a live gateway.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0],
      curlUnavailable: true,
      expectKill: false,
      settleSeconds: 1.2,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain(
        "[gateway-watchdog] curl is unavailable; serving watchdog disabled (#7377)",
      );
      expect(result.stderr).not.toContain("[gateway-watchdog] CRITICAL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves the not-serving count across an inconclusive probe (#7377)", () => {
    // An inconclusive probe preserves the count rather than clearing it, so an
    // intermittent local probe failure cannot postpone recovery indefinitely.
    // Two not-serving probes, one inconclusive probe, and two more not-serving
    // probes reach the default threshold of four.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7, 127, 7, 7],
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("health probe inconclusive");
      expect(result.stderr).toContain("(4 not-serving probes since the last serving response)");
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
      expect(result.stderr).not.toContain("[gateway-watchdog] CRITICAL");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports an orphaned gateway once and never signals it (#7377)", () => {
    // A gateway that outlived its supervisor keeps its recorded identity but
    // is reparented, so the respawn loop recovery depends on is gone. The
    // watchdog must say so rather than loop silently, must say it once rather
    // than every probe, and must not signal a process it cannot get relaunched.
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [7],
      orphaned: true,
      expectKill: false,
      settleSeconds: 1.2,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(true);
      expect(result.stderr).toContain("this supervisor is no longer its parent");
      expect(result.stderr).not.toContain("killing it so the respawn loop can relaunch");
      expect(String(result.stderr).match(/no longer its parent/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("honors the refused-threshold environment variable", () => {
    const { result, fakeAlive, tmpDir } = runWatchdog({
      curlPlan: [0, 7, 7],
      env: { NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD: "2" },
      expectKill: true,
    });
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fakeAlive).toBe(false);
      expect(result.stderr).toContain("2 not-serving probes since the last serving response");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses defaults for invalid watchdog environment values", () => {
    // A zero or invalid interval would busy-loop the probe; a zero threshold
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
      expect(result.stderr).toContain("4 not-serving probes since the last serving response");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not inherit the armed state when the pidfile switches to a new gateway PID", () => {
    // A fast respawn can replace the pidfile between probes without the
    // watchdog ever observing the old PID as dead. The new gateway must earn
    // its own armed state. Otherwise, its boot-time refusals would count
    // against the predecessor's serve history and it could be killed while
    // still starting up.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-watchdog-swap-"));
    try {
      const planFile = path.join(tmpDir, "curl-plan.txt");
      const probeLog = path.join(tmpDir, "probes.log");
      const gatewayLogFile = path.join(tmpDir, "gateway.log");
      fs.writeFileSync(gatewayLogFile, "", { mode: 0o644 });
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
        // cycles, so survival proves the per-PID reset. The boot grace window
        // is pinned out of reach so this case isolates the armed-state reset
        // rather than the never-served bound, which has its own coverage.
        "export NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD=2",
        "export NEMOCLAW_GATEWAY_WATCHDOG_BOOT_GRACE_PROBES=100000",
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
        '    0) record_gateway_pid "$GATEWAY_B" "$GATEWAY_B_START"; printf 200 ;;',
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
        watchdogFunctions(gatewayLogFile),
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
      // B may report not-serving probes against the boot grace window, but it
      // must never be counted against A's serving history.
      expect(result.stderr).not.toContain(
        `gateway pid ${bPid} is alive but not serving port 18789: connection refused (1/2 since the last serving response)`,
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
