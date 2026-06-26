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

  it("matches prompt-shaped TUI readiness text without accepting banner-only startup text", () => {
    const readiness = (capture: string) =>
      runTuiStartupCheckHelper(
        'if printf "%s" "$CAPTURE" | is_tui_ready_capture; then printf ready; else printf not-ready; fi',
        { CAPTURE: capture },
      );

    expect(readiness("Deep Agents Code starting...\nLoading tools...")).toBe("not-ready");
    expect(readiness("Press Enter to continue")).toBe("not-ready");
    expect(readiness("What would you like to do next?")).toBe("ready");
    expect(readiness("Enter your task, then press Enter")).toBe("ready");
    expect(readiness("How can I help with the codebase today?")).toBe("ready");
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

  it("detects and redacts every canonical secret family in TUI startup artifacts", () => {
    const detectsSecret = (token: string) =>
      runTuiStartupCheckHelper(
        'if printf "%s" "$TOKEN" | contains_secret; then printf secret; else printf clean; fi',
        { TOKEN: token },
      );
    const redactsSecret = (token: string) =>
      runTuiStartupCheckHelper('printf "%s" "$TOKEN" | redact_secrets', { TOKEN: token });
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
      [fingerprint(TOKEN_PREFIX_PATTERNS[8]), { name: "akia", sample: "AKIAABCDEFGHIJKLMNOP" }],
      [fingerprint(TOKEN_PREFIX_PATTERNS[8]), { name: "asia", sample: "ASIAABCDEFGHIJKLMNOP" }],
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
      { name: "akia", sample: "AKIAABCDEFGHIJKLMNOP" },
      { name: "xoxp", sample: secretFixture("xox", "p", "-", "1234567890") },
      { name: "xoxa", sample: secretFixture("xox", "a", "-", "1234567890") },
      { name: "xoxs", sample: secretFixture("xox", "s", "-", "1234567890") },
      {
        name: "xapp",
        sample: secretFixture("x", "app", "-", "1", "-", "A1B2C3", "-", "12345", "-", "abcde"),
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
    expect(detectsSecret("plain startup text")).toBe("clean");
  });

  it("removes raw TUI startup artifacts after writing the sanitized capture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-tui-"));
    const rawCapture = path.join(tempDir, "raw.log");
    const expectLog = path.join(tempDir, "expect.log");
    const combinedCapture = path.join(tempDir, "combined.log");
    const sanitizedCapture = path.join(tempDir, "sanitized.log");

    try {
      const output = runTuiStartupCheckHelper(
        [
          'raw_capture_file="$RAW_CAPTURE"',
          'expect_log_file="$EXPECT_LOG"',
          'combined_capture_file="$COMBINED_CAPTURE"',
          'plain_capture_file="$SANITIZED_CAPTURE"',
          'SENSITIVE_CAPTURE_FILES=("$raw_capture_file" "$expect_log_file" "$combined_capture_file")',
          'printf "%s\\n" "$SECRET_TOKEN" >"$raw_capture_file"',
          'printf "%s\\n" "expect output" >"$expect_log_file"',
          'cat "$raw_capture_file" "$expect_log_file" >"$combined_capture_file"',
          'strip_terminal_control_sequences <"$combined_capture_file" >"$plain_capture_file"',
          "cleanup_sensitive_captures",
          'for artifact in "$raw_capture_file" "$expect_log_file" "$combined_capture_file"; do if [ -e "$artifact" ]; then printf "leaked:%s" "$artifact"; exit 1; fi; done',
          'if [ -e "$plain_capture_file" ]; then printf sanitized; else printf missing; fi',
        ].join("; "),
        {
          COMBINED_CAPTURE: combinedCapture,
          EXPECT_LOG: expectLog,
          RAW_CAPTURE: rawCapture,
          SANITIZED_CAPTURE: sanitizedCapture,
          SECRET_TOKEN: `sk-${"A".repeat(20)}`,
        },
      );

      expect(output).toBe("sanitized");
      expect(fs.existsSync(rawCapture)).toBe(false);
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
