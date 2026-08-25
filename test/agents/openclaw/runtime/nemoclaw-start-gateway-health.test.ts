// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Gateway-health coverage for scripts/nemoclaw-start.sh (#4503, #4710):
// the Docker HEALTHCHECK marker invariants and the supervised gateway
// lifecycle. The serving watchdog that recovers an alive-but-not-serving
// gateway is covered in test/runtime/gateway/gateway-serving-watchdog.test.ts. Marker tests
// are split from test/agents/openclaw/runtime/nemoclaw-start.test.ts, which is at its size budget
// (ci/test-file-size-budget.json).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractShellFunction,
  GATEWAY_SUPERVISOR,
  pidIdentityFunctions,
  readFileIfPresent,
  START_SCRIPT,
  safeTmpHelpers,
  writeProcStatFunction,
} from "../../../nemoclaw-start-gateway.test-helpers";

function gatewayMarkerFunction(src: string, name: string, markerPath: string): string {
  return extractShellFunction(src, name).replaceAll("/tmp/nemoclaw-gateway-local", markerPath);
}

function rootGatewayLifecycleFunctions(src: string, gatewayLog: string): string {
  return [
    pidIdentityFunctions(src),
    extractShellFunction(src, "arm_openclaw_gateway_supervisor_cleanup"),
    extractShellFunction(src, "launch_openclaw_gateway_process").replaceAll(
      "/tmp/gateway.log",
      gatewayLog,
    ),
    extractShellFunction(src, "launch_openclaw_gateway").replaceAll("/tmp/gateway.log", gatewayLog),
    extractShellFunction(src, "openclaw_supervised_aux_pid_is_live"),
    extractShellFunction(src, "stop_openclaw_supervised_gateway"),
    extractShellFunction(src, "refresh_openclaw_supervised_child_pids"),
    extractShellFunction(src, "mark_openclaw_gateway_stopped"),
    extractShellFunction(src, "stop_openclaw_gateway_fail_closed"),
    extractShellFunction(src, "openclaw_reap_exited_gateway"),
  ].join("\n");
}

function gatewayLaunchBlock(src: string, kind: "non-root" | "root", gatewayLog: string): string {
  const startMarker =
    kind === "non-root"
      ? "# Start gateway in background, auto-pair, then wait"
      : "# Start the gateway as the 'gateway' user.";
  const start = src.indexOf(startMarker);
  const end = src.indexOf('SANDBOX_WAIT_PID="$GATEWAY_PID"', start);
  expect(start, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(-1);
  expect(end, `Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`).not.toBe(-1);
  return src.slice(start, src.indexOf("\n", end)).replaceAll("/tmp/gateway.log", gatewayLog);
}

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

// Run both real launch paths with their marker, pidfile, and watchdog helpers.
// This behaviorally covers the driver-env marker regression (#4748).
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
          "STEP_DOWN_PREFIX_GATEWAY=(env)",
          "OPENCLAW=/usr/bin/true",
          "_DASHBOARD_PORT=19000",
          "GATEWAY_PID=0",
          "GATEWAY_PID_START_IDENTITY=",
          "mark_in_container_gateway() { :; }",
          "clear_in_container_gateway_marker() { :; }\ncleanup_openclaw_on_signal() { :; }",
          "capture_openclaw_pid_start_identity() { return 1; }",
          'clear_gateway_pid_record() { printf "clear\\n" >>"$EVENT_LOG"; }',
          'kill() { printf "unexpected-kill:%s\\n" "$*" >>"$EVENT_LOG"; }',
          'wait() { printf "unexpected-wait:%s\\n" "$*" >>"$EVENT_LOG"; }',
          safeTmpHelpers(src),
          extractShellFunction(src, "arm_openclaw_gateway_supervisor_cleanup"),
          extractShellFunction(src, "launch_openclaw_gateway_process"),
          launch,
          "launch_openclaw_gateway",
        ].join("\n"),
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("could not capture gateway process identity");
    expect(fs.readFileSync(eventLog, "utf-8")).toBe("clear\n");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
    fs.writeFileSync(
      path.join(fakeBin, "setpriv"),
      `#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      {
        mode: 0o755,
      },
    );
    fs.writeFileSync(gatewayLog, "gateway booting\n");

    const realFunctions = [
      safeTmpHelpers(src),
      gatewayMarkerFunction(src, "mark_in_container_gateway", markerPath),
      gatewayMarkerFunction(src, "clear_in_container_gateway_marker", markerPath),
      extractShellFunction(src, "_nemoclaw_capture_epoch_realtime"),
      "record_portable_openclaw_gateway_startup_timing() { :; }",
      extractShellFunction(src, "launch_openclaw_gateway_non_root").replaceAll(
        "/tmp/gateway.log",
        gatewayLog,
      ),
      extractShellFunction(src, "record_gateway_pid"),
      extractShellFunction(src, "clear_gateway_pid_record"),
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
        "STEP_DOWN_PREFIX_SANDBOX=(setpriv --reuid=sandbox --regid=sandbox --init-groups --)",
        "STEP_DOWN_PREFIX_GATEWAY=(setpriv --reuid=gateway --regid=gateway --init-groups --)",
        realFunctions,
        gatewayLaunchBlock(src, kind, gatewayLog),
        `if [ -f ${JSON.stringify(markerPath)} ]; then printf "MARKER_PRESENT=1\\n"; fi`,
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
    const markerPresent = stdout.includes("MARKER_PRESENT=1");
    const markerExists = readFileIfPresent(markerPath) !== null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
      result,
      stdout,
      gatewayPid,
      watchdogPid,
      childPids,
      pidFileContent,
      markerPresent,
      markerExists,
    };
  }

  it.each([
    "non-root",
    "root",
  ] as const)("%s launch clears the marker on supervisor exit after recording the gateway PID", (kind) => {
    const run = runLaunchWiring(kind);
    expect(run.result.status, `script failed: ${run.result.stderr}`).toBe(0);
    expect(run.markerPresent).toBe(true);
    // The supervisor EXIT trap clears the in-container marker when this fixture
    // exits, returning healthchecks to the marker-absent branch (#4952).
    expect(run.markerExists).toBe(false);
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
    fs.writeFileSync(
      path.join(fakeBin, "setpriv"),
      `#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      {
        mode: 0o755,
      },
    );
    fs.writeFileSync(gatewayLog, "gateway booting\n");

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -o pipefail",
        `export PATH=${JSON.stringify(`${fakeBin}:${process.env.PATH || ""}`)}`,
        `OPENCLAW=${JSON.stringify(path.join(fakeBin, "openclaw"))}`,
        '_DASHBOARD_PORT="19000"',
        `GATEWAY_PID_FILE=${JSON.stringify(pidFile)}`,
        "STEP_DOWN_PREFIX_GATEWAY=(setpriv --reuid=gateway --regid=gateway --init-groups --)",
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

// Launch-path signal handling and child-PID tracking for both entrypoint modes.
// This file owns gateway launch coverage to keep the legacy test within budget.
describe("nemoclaw-start gateway launch signal handling", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function runLaunchBlock(kind: "non-root" | "root") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-launch-${kind}-`));
    const fakeBin = path.join(tmpDir, "bin");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const setprivLog = path.join(tmpDir, "setpriv.log");
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
      path.join(fakeBin, "setpriv"),
      `#!/usr/bin/env bash\nprintf 'args=%s\\n' "${"$*"}" >> ${JSON.stringify(setprivLog)}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
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
        gatewayMarkerFunction(src, "mark_in_container_gateway", markerPath),
        gatewayMarkerFunction(src, "clear_in_container_gateway_marker", markerPath),
        extractShellFunction(src, "_nemoclaw_capture_epoch_realtime"),
        "record_portable_openclaw_gateway_startup_timing() { :; }",
        // Stub PID recording and the serving watchdog; each has focused tests
        // elsewhere in this suite (#4710).
        "record_gateway_pid() { :; }",
        "clear_gateway_pid_record() { :; }",
        'start_gateway_serving_watchdog() { sleep 30 & GATEWAY_WATCHDOG_PID=$!; capture_openclaw_pid_start_identity "$GATEWAY_WATCHDOG_PID" GATEWAY_WATCHDOG_PID_START_IDENTITY; }',
        extractShellFunction(src, "launch_openclaw_gateway_non_root").replaceAll(
          "/tmp/gateway.log",
          gatewayLog,
        ),
        rootGatewayLifecycleFunctions(src, gatewayLog),
        "STEP_DOWN_PREFIX_SANDBOX=(setpriv --reuid=sandbox --regid=sandbox --init-groups --)",
        "STEP_DOWN_PREFIX_GATEWAY=(setpriv --reuid=gateway --regid=gateway --init-groups --)",
        gatewayLaunchBlock(src, kind, gatewayLog),
        kind === "root"
          ? `for _ in ${waitForLaunchLogIterations}; do [ -s ${JSON.stringify(setprivLog)} ] && [ -s ${JSON.stringify(openclawLog)} ] && break; sleep 0.1; done`
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
    const setpriv = readFileIfPresent(setprivLog) ?? "";
    const gateway = readFileIfPresent(gatewayLog) ?? "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, openclaw, setpriv, gateway };
  }

  it("registers child PIDs, redirects gateway output, and traps signals in non-root mode", () => {
    const { result, openclaw, gateway } = runLaunchBlock("non-root");
    expect(result.status, result.stderr).toBe(0);
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

  it("launches the root gateway through setpriv with the configured port and tracks child PIDs", () => {
    const { result, openclaw, setpriv } = runLaunchBlock("root");
    expect(result.status, result.stderr).toBe(0);
    expect(setpriv).toContain("--reuid=gateway --regid=gateway --init-groups --");
    expect(setpriv).toContain("gateway run --port 19000");
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
