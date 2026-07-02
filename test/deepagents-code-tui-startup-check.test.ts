// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CONTEXT_PATTERNS, TOKEN_PREFIX_PATTERNS } from "../src/lib/security/secret-patterns.ts";

const tuiStartupCheckPath = path.join(
  process.cwd(),
  "test",
  "e2e",
  "e2e-cloud-experimental",
  "checks",
  "10-deepagents-code-tui-startup.sh",
);
const tuiStartupCheckSource = fs
  .readFileSync(tuiStartupCheckPath, "utf8")
  .replace('\nif [[ "${BASH_SOURCE[0]}" == "$0" ]]; then\n  main "$@"\nfi\n', "\n");
const tuiExpectProgram =
  tuiStartupCheckSource.match(/expect <<'EXPECT'\n([\s\S]*?)\nEXPECT/)?.[1] ??
  (() => {
    throw new Error("Deep Agents Code TUI check is missing its embedded Expect program");
  })();

function runTuiStartupCheckHelper(snippet: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: `${tuiStartupCheckSource}\n${snippet}\n`,
  });
}

function runTuiStartupCheckHelperResult(
  snippet: string,
  env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: `${tuiStartupCheckSource}\n${snippet}\n`,
  });
}

function fingerprint(pattern: RegExp): string {
  return `${pattern.source}::${pattern.flags}`;
}

function secretFixture(...parts: string[]): string {
  return parts.join("");
}

type TuiExpectEvent = "eof" | "exit" | "onboarding" | "ready" | "timeout";

const tclEventLiterals: Record<TuiExpectEvent, string> = {
  eof: "{eof}",
  exit: "{exit}",
  onboarding: "{onboarding}",
  ready: "{ready}",
  timeout: "{timeout}",
};
const tclshAvailable =
  spawnSync("tclsh", ["-"], { encoding: "utf8", input: "exit 0\n" }).status === 0;
const itWithTclsh = it.runIf(tclshAvailable);

function runTuiExpectStateMachine(
  events: TuiExpectEvent[],
  options: { closeAfterFirstCtrlC?: boolean } = {},
) {
  const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-expect-"));
  const capture = path.join(captureDir, "raw.log");
  const markers = path.join(captureDir, "markers.log");
  const trace = path.join(captureDir, "trace.log");
  fs.writeFileSync(capture, "");
  fs.writeFileSync(markers, "");

  const prelude = String.raw`
rename after real_after
rename exit real_exit
set ::fake_events [list ${events.map((event) => tclEventLiterals[event]).join(" ")}]
set ::fake_sent {}
set ::fake_closed 0

proc log_file {args} {}
proc spawn {args} {}
proc after {args} {}
proc send {args} {
  binary scan [lindex $args end] H* key_hex
  if {$::fake_closed} {
    error "fake spawn id is closed"
  }
  lappend ::fake_sent $key_hex
  if {$key_hex eq "03" && $::env(NEMOCLAW_TUI_CLOSE_AFTER_FIRST_CTRL_C) eq "1"} {
    set ::fake_closed 1
  }
}
proc expect {branches} {
  if {[llength $::fake_events] == 0} {
    error "fake Expect event queue exhausted"
  }
  set event [lindex $::fake_events 0]
  set ::fake_events [lrange $::fake_events 1 end]
  switch -- $event {
    onboarding {
      set branch_index [lsearch -exact $branches {$onboarding_pattern}]
      set ::expect_out(0,string) "Your name (optional)"
    }
    ready {
      set branch_index [lsearch -exact $branches {$ready_pattern}]
      set ::expect_out(0,string) "What would you like to build?"
    }
    exit {
      set branch_index [lsearch -glob $branches {NEMOCLAW_TUI_EXIT:*}]
      set ::expect_out(0,string) "NEMOCLAW_TUI_EXIT:0"
      set ::expect_out(1,string) "0"
    }
    timeout {
      set branch_index [lsearch -exact $branches timeout]
    }
    eof {
      set branch_index [lsearch -exact $branches eof]
    }
    default {
      error "unsupported fake Expect event: $event"
    }
  }
  if {$branch_index < 0} {
    error "fake Expect event $event has no matching branch"
  }
  uplevel 1 [lindex $branches [expr {$branch_index + 1}]]
}
proc exit {{code 0}} {
  set trace_file [open $::env(NEMOCLAW_TUI_TRACE) w]
  puts $trace_file [join $::fake_sent ,]
  close $trace_file
  real_exit $code
}
`;
  const result = spawnSync("tclsh", ["-"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_TUI_CAPTURE: capture,
      NEMOCLAW_TUI_CLOSE_AFTER_FIRST_CTRL_C: options.closeAfterFirstCtrlC ? "1" : "0",
      NEMOCLAW_TUI_MARKERS: markers,
      NEMOCLAW_TUI_ONBOARDING_PATTERN:
        "(your name \\(optional\\)|what should deep agents call you)",
      NEMOCLAW_TUI_READY_PATTERN:
        "(what would you like|enter (your )?(task|message|prompt)|how can i help)",
      NEMOCLAW_TUI_SANDBOX_NAME: "fake-deepagents",
      NEMOCLAW_TUI_TIMEOUT: "5",
      NEMOCLAW_TUI_TRACE: trace,
    },
    input: `${prelude}\n${tuiExpectProgram}\n`,
  });

  const markerText = fs.readFileSync(markers, "utf8");
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim() : "";
  fs.rmSync(captureDir, { force: true, recursive: true });
  return { markerText, result, traceText };
}

describe("Deep Agents Code TUI startup check helpers", () => {
  it("rejects unsafe TUI startup timeout values before sandbox execution", () => {
    const validate = (timeout: string) =>
      runTuiStartupCheckHelper(
        'if is_positive_integer "$TUI_TIMEOUT"; then printf valid; else printf invalid; fi',
        { DEEPAGENTS_TUI_TIMEOUT: timeout },
      );

    expect(validate("90")).toBe("valid");
    expect(validate("0")).toBe("invalid");
    expect(validate("1; touch /tmp/nemoclaw-tui-timeout-injection")).toBe("invalid");
  });

  it("skips non-Deep-Agents sandboxes before requiring expect", () => {
    const result = runTuiStartupCheckHelperResult(
      [
        "PASSED=0",
        "FAILED=0",
        "sandbox_exec() { printf 'NEMOCLAW_DCODE_PROBE:other\\n'; }",
        'command() { if [ "$1" = -v ] && [ "${2:-}" = expect ]; then return 1; fi; builtin command "$@"; }',
        "main",
      ].join("; "),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP: sandbox");
    expect(result.stderr).not.toContain("expect is required");
  });

  it("fails closed when expect installation fallback cannot provide expect", () => {
    const result = runTuiStartupCheckHelperResult(
      [
        "command() { case \"$*\" in '-v expect') return 1 ;; '-v sudo'|'-v apt-get') return 0 ;; *) builtin command \"$@\" ;; esac; }",
        "sudo() { return 42; }",
        "ensure_expect_available",
      ].join("; "),
      { GITHUB_ACTIONS: "true" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("installing expect");
  });

  it("matches prompt-shaped TUI readiness text without accepting banner-only startup text", () => {
    const readiness = (capture: string) =>
      runTuiStartupCheckHelper(
        'if printf "%s" "$CAPTURE" | is_tui_ready_capture; then printf ready; else printf not-ready; fi',
        { CAPTURE: capture },
      );

    expect(readiness("Deep Agents Code starting...\nLoading tools...")).toBe("not-ready");
    expect(readiness("Press Enter to continue")).toBe("not-ready");
    expect(readiness("Your name (optional)")).toBe("not-ready");
    expect(readiness("What should Deep Agents call you?")).toBe("not-ready");
    expect(readiness("What would you like to do next?")).toBe("ready");
    expect(readiness("Enter your task, then press Enter")).toBe("ready");
    expect(readiness("How can I help with the codebase today?")).toBe("ready");
  });

  it("matches only the pinned first-run onboarding name screen", () => {
    const isOnboarding = (capture: string) =>
      runTuiStartupCheckHelper(
        'if printf "%s" "$CAPTURE" | grep -Eiq "$TUI_ONBOARDING_PATTERN"; then printf onboarding; else printf other; fi',
        { CAPTURE: capture },
      );

    expect(isOnboarding("Your name (optional)")).toBe("onboarding");
    expect(isOnboarding("What should Deep Agents call you?")).toBe("onboarding");
    expect(isOnboarding("Your project name")).toBe("other");
    expect(isOnboarding("What would you like to build?")).toBe("other");
  });

  itWithTclsh("skips first-run onboarding before marking the real TUI prompt ready (tclsh)", () => {
    const { markerText, result, traceText } = runTuiExpectStateMachine([
      "onboarding",
      "ready",
      "exit",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(traceText).toBe("1b,03,03");
    expect(markerText).toContain("Your name (optional)");
    expect(markerText).toContain("What would you like to build?");
    expect(markerText).toContain("NEMOCLAW_TUI_ONBOARDING_SKIPPED");
    expect(markerText).toContain("NEMOCLAW_TUI_READY");
    expect(markerText.indexOf("NEMOCLAW_TUI_ONBOARDING_SKIPPED")).toBeLessThan(
      markerText.indexOf("NEMOCLAW_TUI_READY"),
    );
    expect(markerText).toContain("NEMOCLAW_TUI_EXIT_CAPTURED:0");
  });

  itWithTclsh(
    "does not mark the TUI ready when the coding prompt times out after onboarding (tclsh)",
    () => {
      const { markerText, result, traceText } = runTuiExpectStateMachine(["onboarding", "timeout"]);

      expect(result.status, result.stderr).toBe(20);
      expect(traceText).toBe("1b,03");
      expect(markerText).toContain("NEMOCLAW_TUI_ONBOARDING_SKIPPED");
      expect(markerText).toContain("NEMOCLAW_TUI_TIMEOUT");
      expect(markerText).not.toContain("NEMOCLAW_TUI_READY");
    },
  );

  itWithTclsh("captures a clean exit when dcode closes after the first Ctrl-C (tclsh)", () => {
    const { markerText, result, traceText } = runTuiExpectStateMachine(["ready", "exit"], {
      closeAfterFirstCtrlC: true,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(traceText).toBe("03");
    expect(markerText).toContain("NEMOCLAW_TUI_READY");
    expect(markerText).toContain("NEMOCLAW_TUI_EXIT_CAPTURED:0");
  });

  it("does not treat generic TUI exit status 1 as a clean Ctrl-C exit", () => {
    const assertExit = (exitCode: string) =>
      runTuiStartupCheckHelper(
        [
          "PASSED=0",
          "FAILED=0",
          'capture="$(mktemp)"',
          'printf "NEMOCLAW_TUI_EXIT_CAPTURED:%s\\n" "$EXIT_CODE" >"$capture"',
          'assert_clean_exit_code "$capture" 2>/dev/null',
          'rm -f -- "$capture"',
          'printf "passed=%s failed=%s" "$PASSED" "$FAILED"',
        ].join("; "),
        { EXIT_CODE: exitCode },
      );

    expect(assertExit("0")).toBe(
      "10-deepagents-code-tui-startup: OK (dcode TUI exited cleanly after Ctrl-C (exit 0))\npassed=1 failed=0",
    );
    expect(assertExit("130")).toBe(
      "10-deepagents-code-tui-startup: OK (dcode TUI exited cleanly after Ctrl-C (exit 130))\npassed=1 failed=0",
    );
    expect(assertExit("1")).toBe("passed=0 failed=1");
  });

  it("preserves TUI lifecycle markers in the sanitized capture artifact", () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-markers-"));
    const sanitizedCapture = path.join(captureDir, "10-deepagents-code-tui-startup.sanitized.log");

    try {
      const result = runTuiStartupCheckHelperResult(
        [
          "sandbox_exec() { printf 'NEMOCLAW_DCODE_PROBE:deepagents\\n'; }",
          "ensure_expect_available() { return 0; }",
          "run_tui_expect() {",
          '  printf "Your name (optional)\\nNEMOCLAW_TUI_ONBOARDING_SKIPPED\\nWhat would you like to do next?\\nNEMOCLAW_TUI_READY\\nNEMOCLAW_TUI_EXIT_CAPTURED:130\\n" >>"$2"',
          "  return 0",
          "}",
          "main",
        ].join("\n"),
        { DEEPAGENTS_TUI_CAPTURE_DIR: captureDir },
      );

      const sanitizedText = fs.readFileSync(sanitizedCapture, "utf8");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("finite expect harness reached startup and observed exit");
      expect(result.stdout).toContain("dcode TUI rendered a usable startup prompt signature");
      expect(result.stdout).toContain("dcode TUI exited cleanly after Ctrl-C (exit 130)");
      expect(sanitizedText).toContain("NEMOCLAW_TUI_ONBOARDING_SKIPPED");
      expect(sanitizedText).toContain("NEMOCLAW_TUI_READY");
      expect(sanitizedText).toContain("NEMOCLAW_TUI_EXIT_CAPTURED:130");
    } finally {
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it("preserves a failed expect status and emits only the sanitized capture excerpt", () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-failure-"));

    try {
      const result = runTuiStartupCheckHelperResult(
        [
          "sandbox_exec() { printf 'NEMOCLAW_DCODE_PROBE:deepagents\\n'; }",
          "ensure_expect_available() { return 0; }",
          "run_tui_expect() {",
          '  printf "NEMOCLAW_TUI_EOF_BEFORE_READY\\n" >>"$2"',
          "  return 21",
          "}",
          "main",
        ].join("\n"),
        { DEEPAGENTS_TUI_CAPTURE_DIR: captureDir },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("finite expect harness exited 21");
      expect(result.stderr).toContain("sanitized capture excerpt (last 20000 bytes)");
      expect(result.stderr).toContain("NEMOCLAW_TUI_EOF_BEFORE_READY");
    } finally {
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it("suppresses the capture excerpt when secret-shaped data remains", () => {
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-secret-"));
    const capture = path.join(captureDir, "sanitized.log");
    const secret = `sk-${"A".repeat(20)}`;

    try {
      fs.writeFileSync(capture, `diagnostic body\n${secret}\n`);
      const result = runTuiStartupCheckHelperResult('print_sanitized_capture_excerpt "$CAPTURE"', {
        CAPTURE: capture,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "sanitized TUI capture omitted because secret-shaped data remains",
      );
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain("sanitized capture excerpt");
      expect(result.stderr).not.toContain("diagnostic body");
    } finally {
      fs.rmSync(captureDir, { force: true, recursive: true });
    }
  });

  it("detects and redacts every canonical secret family in TUI startup artifacts", () => {
    const detectsSecret = (token: string) =>
      runTuiStartupCheckHelper(
        'if printf "%s" "$TOKEN" | contains_secret; then printf secret; else printf clean; fi',
        { TOKEN: token },
      );
    const redactsSecret = (token: string) =>
      runTuiStartupCheckHelper('printf "%s" "$TOKEN" | redact_secrets', { TOKEN: token });
    const langsmithPt = `lsv2_pt_${"a".repeat(36)}_${"b".repeat(10)}`;
    const langsmithSk = `lsv2_sk_${"a".repeat(36)}_${"c".repeat(10)}`;
    const canonicalSamples = new Map<string, { name: string; sample: string; rawSecret?: string }>([
      [fingerprint(TOKEN_PREFIX_PATTERNS[0]), { name: "nvapi", sample: "nvapi-abcdefghijklmnop" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[1]), { name: "nvcf", sample: "nvcf-abcdefghijklmnopq" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[2]), { name: "ghp", sample: "ghp_abcdefghijklmnopqr" }],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[3]),
        { name: "github_pat", sample: "github_pat_abcdefghijklmnopqrstuvwxyz0123" },
      ],
      [fingerprint(TOKEN_PREFIX_PATTERNS[4]), { name: "sk_proj", sample: "sk-proj-abcdefghij" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[5]), { name: "sk_ant", sample: "sk-ant-abcdefghijk" }],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[6]),
        { name: "sk", sample: "sk-abcdefghijklmnopqrstuvwx" },
      ],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[7]),
        { name: "xoxb", sample: secretFixture("xox", "b", "-", "1234567890") },
      ],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[8]),
        { name: "akia", sample: secretFixture("AK", "IA", "ABCDEFGHIJKLMNOP") },
      ],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[8]),
        { name: "asia", sample: secretFixture("AS", "IA", "ABCDEFGHIJKLMNOP") },
      ],
      [fingerprint(TOKEN_PREFIX_PATTERNS[9]), { name: "hf", sample: "hf_abcdefghijklmnopq" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[10]), { name: "glpat", sample: "glpat-abcdefghijklmn" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[11]), { name: "gsk", sample: "gsk_abcdefghijklmnop" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[12]), { name: "pypi", sample: "pypi-abcdefghijklmnop" }],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[13]),
        { name: "telegram_bot", sample: "bot123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      ],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[14]),
        { name: "telegram", sample: "123456789:AbcDefGhiJklMnoPqrStuVwxYz012345678" },
      ],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[15]),
        {
          name: "discord",
          sample: "ABCDEFGHIJKLMNOPQRSTUVWX.Abcdef.ZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        },
      ],
      [fingerprint(TOKEN_PREFIX_PATTERNS[16]), { name: "tvly", sample: "tvly-abcdefghijklmnop" }],
      [
        fingerprint(TOKEN_PREFIX_PATTERNS[17]),
        {
          name: "langsmith_pt",
          sample: langsmithPt,
        },
      ],
      [
        fingerprint(CONTEXT_PATTERNS[0]),
        {
          name: "bearer_context",
          sample: "Authorization: Bearer abcdefghijklmnopqrst",
          rawSecret: "abcdefghijklmnopqrst",
        },
      ],
      [
        fingerprint(CONTEXT_PATTERNS[1]),
        {
          name: "api_key_context",
          sample: "API_KEY=abcdefghijklmnopqrst",
          rawSecret: "abcdefghijklmnopqrst",
        },
      ],
    ]);
    const extraSamples = [
      { name: "akia", sample: secretFixture("AK", "IA", "ABCDEFGHIJKLMNOP") },
      { name: "xoxp", sample: secretFixture("xox", "p", "-", "1234567890") },
      { name: "xoxa", sample: secretFixture("xox", "a", "-", "1234567890") },
      { name: "xoxs", sample: secretFixture("xox", "s", "-", "1234567890") },
      {
        name: "xapp",
        sample: secretFixture("x", "app", "-", "1", "-", "A1B2C3", "-", "12345", "-", "abcde"),
      },
      {
        name: "langsmith_sk",
        sample: langsmithSk,
      },
      {
        name: "token_context",
        sample: "TOKEN=abcdefghijklmnopqrst",
        rawSecret: "abcdefghijklmnopqrst",
      },
      {
        name: "secret_context",
        sample: "SECRET=abcdefghijklmnopqrst",
        rawSecret: "abcdefghijklmnopqrst",
      },
      {
        name: "password_context",
        sample: "PASSWORD=abcdefghijklmnopqrst",
        rawSecret: "abcdefghijklmnopqrst",
      },
      {
        name: "credential_context",
        sample: "CREDENTIAL=abcdefghijklmnopqrst",
        rawSecret: "abcdefghijklmnopqrst",
      },
      {
        name: "suffix_key_context",
        sample: "SERVICE_KEY=abcdefghijklmnopqrst",
        rawSecret: "abcdefghijklmnopqrst",
      },
    ];

    const canonicalFingerprints = [...TOKEN_PREFIX_PATTERNS, ...CONTEXT_PATTERNS].map(fingerprint);
    expect([...canonicalSamples.keys()]).toEqual(canonicalFingerprints);

    for (const { name, sample, rawSecret } of [...canonicalSamples.values(), ...extraSamples]) {
      expect(detectsSecret(sample), `${name} should be detected`).toBe("secret");
      const redacted = redactsSecret(sample);
      expect(redacted, `${name} should include a redaction marker`).toContain("[REDACTED_SECRET]");
      expect(redacted, `${name} should not retain the raw secret`).not.toContain(
        rawSecret ?? sample,
      );
    }
    expect(redactsSecret(langsmithPt)).toBe("[REDACTED_SECRET]");
    expect(redactsSecret(langsmithSk)).toBe("[REDACTED_SECRET]");
    expect(detectsSecret("plain startup text")).toBe("clean");
  });

  it("removes raw TUI startup artifacts after writing the sanitized capture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-"));
    const rawCapture = path.join(tempDir, "raw.log");
    const markerCapture = path.join(tempDir, "markers.log");
    const expectLog = path.join(tempDir, "expect.log");
    const combinedCapture = path.join(tempDir, "combined.log");
    const sanitizedCapture = path.join(tempDir, "sanitized.log");

    try {
      const output = runTuiStartupCheckHelper(
        [
          'raw_capture_file="$RAW_CAPTURE"',
          'marker_capture_file="$MARKER_CAPTURE"',
          'expect_log_file="$EXPECT_LOG"',
          'combined_capture_file="$COMBINED_CAPTURE"',
          'plain_capture_file="$SANITIZED_CAPTURE"',
          'SENSITIVE_CAPTURE_FILES=("$raw_capture_file" "$marker_capture_file" "$expect_log_file" "$combined_capture_file")',
          'printf "%s\\n" "$SECRET_TOKEN" >"$raw_capture_file"',
          'printf "%s\\n" "NEMOCLAW_TUI_READY" >"$marker_capture_file"',
          'printf "%s\\n" "expect output" >"$expect_log_file"',
          'cat "$raw_capture_file" "$expect_log_file" "$marker_capture_file" >"$combined_capture_file"',
          'strip_terminal_control_sequences <"$combined_capture_file" >"$plain_capture_file"',
          "cleanup_sensitive_captures",
          'for artifact in "$raw_capture_file" "$marker_capture_file" "$expect_log_file" "$combined_capture_file"; do if [ -e "$artifact" ]; then printf "leaked:%s" "$artifact"; exit 1; fi; done',
          'if [ -e "$plain_capture_file" ]; then printf sanitized; else printf missing; fi',
        ].join("; "),
        {
          COMBINED_CAPTURE: combinedCapture,
          EXPECT_LOG: expectLog,
          MARKER_CAPTURE: markerCapture,
          RAW_CAPTURE: rawCapture,
          SANITIZED_CAPTURE: sanitizedCapture,
          SECRET_TOKEN: `sk-${"A".repeat(20)}`,
        },
      );

      expect(output).toBe("sanitized");
      expect(fs.existsSync(rawCapture)).toBe(false);
      expect(fs.existsSync(markerCapture)).toBe(false);
      expect(fs.existsSync(expectLog)).toBe(false);
      expect(fs.existsSync(combinedCapture)).toBe(false);
      expect(fs.existsSync(sanitizedCapture)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("redacts retained TUI startup capture when a secret scan fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-redact-"));
    const rawCapture = path.join(tempDir, "raw.log");
    const expectLog = path.join(tempDir, "expect.log");
    const combinedCapture = path.join(tempDir, "combined.log");
    const sanitizedCapture = path.join(tempDir, "sanitized.log");
    const prefixedToken = `sk-${"A".repeat(20)}`;
    const bearerToken = "b".repeat(20);
    const apiKey = "c".repeat(20);

    try {
      const result = runTuiStartupCheckHelperResult(
        [
          'raw_capture_file="$RAW_CAPTURE"',
          'expect_log_file="$EXPECT_LOG"',
          'combined_capture_file="$COMBINED_CAPTURE"',
          'plain_capture_file="$SANITIZED_CAPTURE"',
          'SENSITIVE_CAPTURE_FILES=("$raw_capture_file" "$expect_log_file" "$combined_capture_file")',
          'printf "%s\\nAuthorization: Bearer %s\\nAPI_KEY=%s\\n" "$PREFIXED_TOKEN" "$BEARER_TOKEN" "$API_KEY_VALUE" >"$raw_capture_file"',
          'printf "%s\\n" "expect output" >"$expect_log_file"',
          'cat "$raw_capture_file" "$expect_log_file" >"$combined_capture_file"',
          'strip_terminal_control_sequences <"$combined_capture_file" >"$plain_capture_file"',
          "secret_detected=0",
          'if contains_secret <"$plain_capture_file"; then secret_detected=1; redact_secrets_in_file "$plain_capture_file"; fi',
          "cleanup_sensitive_captures",
          'if [ "$secret_detected" -eq 1 ]; then fail_test "secret-shaped value found in sanitized TUI capture"; fi',
          'printf "secret_detected=%s failed=%s\\n" "$secret_detected" "$FAILED"',
          '[ "$FAILED" -eq 0 ]',
        ].join("; "),
        {
          API_KEY_VALUE: apiKey,
          BEARER_TOKEN: bearerToken,
          COMBINED_CAPTURE: combinedCapture,
          EXPECT_LOG: expectLog,
          PREFIXED_TOKEN: prefixedToken,
          RAW_CAPTURE: rawCapture,
          SANITIZED_CAPTURE: sanitizedCapture,
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      const sanitizedText = fs.readFileSync(sanitizedCapture, "utf8");
      expect(result.status).not.toBe(0);
      expect(output).toContain("secret_detected=1 failed=1");
      expect(output).not.toContain(prefixedToken);
      expect(output).not.toContain(bearerToken);
      expect(output).not.toContain(apiKey);
      expect(sanitizedText).not.toContain(prefixedToken);
      expect(sanitizedText).not.toContain(bearerToken);
      expect(sanitizedText).not.toContain(apiKey);
      expect(sanitizedText).toContain("Authorization: Bearer [REDACTED_SECRET]");
      expect(sanitizedText).toContain("API_KEY=[REDACTED_SECRET]");
      expect(fs.existsSync(rawCapture)).toBe(false);
      expect(fs.existsSync(expectLog)).toBe(false);
      expect(fs.existsSync(combinedCapture)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("truncates retained TUI startup capture when redaction fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-redact-fail-"));
    const sanitizedCapture = path.join(tempDir, "sanitized.log");
    const prefixedToken = `sk-${"A".repeat(20)}`;

    try {
      const result = runTuiStartupCheckHelperResult(
        [
          'plain_capture_file="$SANITIZED_CAPTURE"',
          'printf "%s\\n" "$PREFIXED_TOKEN" >"$plain_capture_file"',
          "redact_secrets() { return 1; }",
          'if ! redact_secrets_in_file "$plain_capture_file"; then printf "redaction_failed=1\\n"; fi',
          'if [ -e "$plain_capture_file" ] && grep -Fq "$PREFIXED_TOKEN" "$plain_capture_file"; then printf "leaked=1\\n"; fi',
          'printf "failed=%s\\n" "$FAILED"',
        ].join("; "),
        {
          PREFIXED_TOKEN: prefixedToken,
          SANITIZED_CAPTURE: sanitizedCapture,
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      const sanitizedText = fs.readFileSync(sanitizedCapture, "utf8");
      expect(result.status).toBe(0);
      expect(output).toContain("redaction_failed=1");
      expect(output).toContain("failed=1");
      expect(output).not.toContain(prefixedToken);
      expect(output).not.toContain("leaked=1");
      expect(sanitizedText).toBe("[redaction failed; sanitized capture unavailable]\n");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
