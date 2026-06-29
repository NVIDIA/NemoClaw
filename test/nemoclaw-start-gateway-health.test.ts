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

function safeTmpHelpers(src: string): string {
  const start = src.indexOf("_nemoclaw_safe_replace_tmp_file() {");
  const end = src.indexOf("_START_LOG=", Math.max(start, 0));
  expect(start, "Expected safe temp helpers in scripts/nemoclaw-start.sh").not.toBe(-1);
  expect(end, "Expected safe temp helpers in scripts/nemoclaw-start.sh").toBeGreaterThan(start);
  return src.slice(start, end);
}

function watchdogFunctions(): string {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  return [
    safeTmpHelpers(src),
    extractShellFunction(src, "record_gateway_pid"),
    extractShellFunction(src, "gateway_pid_is_openclaw_gateway"),
    extractShellFunction(src, "start_gateway_serving_watchdog"),
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
    `_NEMOCLAW_GATEWAY_LOG=${JSON.stringify(wedgeLogFile)}`,
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
    `mkdir -p ${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID`,
    `printf '%s' ${JSON.stringify(opts.cmdline ?? "openclaw-gateway")} >${JSON.stringify(procRoot)}/$FAKE_GATEWAY_PID/cmdline`,
    watchdogFunctions(),
    'record_gateway_pid "$FAKE_GATEWAY_PID"',
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
      settleSeconds: 0.8,
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
        '  return "$next"',
        "}",
        "command sleep 60 &",
        "GATEWAY_A=$!",
        "command sleep 60 &",
        "GATEWAY_B=$!",
        `mkdir -p ${JSON.stringify(procRoot)}/$GATEWAY_A ${JSON.stringify(procRoot)}/$GATEWAY_B`,
        `printf 'openclaw-gateway' >${JSON.stringify(procRoot)}/$GATEWAY_A/cmdline`,
        `printf 'openclaw-gateway' >${JSON.stringify(procRoot)}/$GATEWAY_B/cmdline`,
        watchdogFunctions(),
        'record_gateway_pid "$GATEWAY_A"',
        "start_gateway_serving_watchdog",
        // Wait until gateway A has been probed (and armed via the plan's 0),
        // then swap the pidfile to gateway B while refusals continue.
        `for _ in $(command seq 1 200); do [ -s ${JSON.stringify(probeLog)} ] && break; command sleep 0.02; done`,
        'record_gateway_pid "$GATEWAY_B"',
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
          "record_gateway_pid 4242",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      // O_NOFOLLOW makes a single open both the not-a-symlink assertion and
      // the content read — no check-then-use window.
      const fd = fs.openSync(pidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        expect(fs.readFileSync(fd, "utf-8")).toBe("4242\n");
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
          "record_gateway_pid 4242",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.readFileSync(pidFile, "utf-8")).toBe("4242\n");
      expect((fs.statSync(pidFile).mode & 0o777).toString(8)).toBe("600");
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
  function launchBlock(src: string, kind: "non-root" | "root"): string {
    const startMarker =
      kind === "non-root"
        ? "# Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const start = src.indexOf(startMarker);
    const trap = src.indexOf("trap cleanup_on_signal SIGTERM SIGINT", start);
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
      extractShellFunction(src, "start_gateway_serving_watchdog"),
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
        "start_persistent_gateway_log_mirror() { command sleep 30 & GATEWAY_LOG_PERSIST_PID=$!; }",
        "start_auto_pair() { command sleep 30 & AUTO_PAIR_PID=$!; }",
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
    expect(run.pidFileContent).toBe(run.gatewayPid);
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
        // The loop sleeps 2s between respawns; keep the test fast.
        "sleep() { command sleep 0.05; }",
        safeTmpHelpers(src),
        extractShellFunction(src, "record_gateway_pid"),
        "SANDBOX_CHILD_PIDS=()",
        "SANDBOX_WAIT_PID=",
        "(",
        // A gateway that dies immediately with a non-zero status drives
        // exactly one respawn iteration.
        '  bash -c "exit 7" &',
        "  GATEWAY_PID=$!",
        '  record_gateway_pid "$GATEWAY_PID"',
        `  printf '%s' "$GATEWAY_PID" > ${JSON.stringify(initialPidFile)}`,
        respawnLoop(src, kind).replaceAll("/tmp/gateway.log", gatewayLog),
        ") &",
        "LOOP_PID=$!",
        'INITIAL=""; CURRENT=""',
        "for _ in $(command seq 1 200); do",
        `  INITIAL="$(cat ${JSON.stringify(initialPidFile)} 2>/dev/null || true)"`,
        `  CURRENT="$(cat ${JSON.stringify(pidFile)} 2>/dev/null || true)"`,
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
      expect(fs.readFileSync(openclawLog, "utf-8")).toContain("gateway run --port 19000");
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
    const trap = src.indexOf("trap cleanup_on_signal SIGTERM SIGINT", start);
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
        "start_persistent_gateway_log_mirror() { sleep 30 & GATEWAY_LOG_PERSIST_PID=$!; }",
        "start_auto_pair() { sleep 30 & AUTO_PAIR_PID=$!; }",
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
        "start_gateway_serving_watchdog() { :; }",
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
    expect(stdout).toContain("cleanup_on_signal");
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
    expect(result.stdout).toContain("cleanup_on_signal");
  });
});
