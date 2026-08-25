// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioral contract for the OPENCLAW_GATEWAY_TOKEN trust-anchor reconcile
// block emitted into /tmp/nemoclaw-proxy-env.sh by scripts/nemoclaw-start.sh.
// Exercises the actual generated file under POSIX sh and Bash. Regression: a
// blind assignment aborted sourcing with the shell's raw readonly error when
// the sourcing shell had already pinned OPENCLAW_GATEWAY_TOKEN readonly to a
// conflicting value (#8428).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../helpers/shell-source";

const OPENCLAW_START = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
const WRITE_RUNTIME_SHELL_ENV = extractShellFunctionFromSource(
  readFileSync(OPENCLAW_START, "utf-8"),
  "write_runtime_shell_env",
);
const REAL_TOKEN = "REAL-GATEWAY-TOKEN-abc123";
const SHELLS = ["sh", "bash"] as const;
const EMPTY_TOKEN_URLS = [
  "wss://remote.example.test",
  "wss://user:password@remote.example.test",
] as const;

const tmpRoots: string[] = [];
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Scenario {
  intended: string;
  shell?: (typeof SHELLS)[number];
  preset?: { value: string; readonly: boolean };
  repeatSources?: boolean;
  readonlyPrivateSentinel?: boolean;
  shadowTestCommand?: boolean;
  shadowStatusCommands?: boolean;
  sourceUrl?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runReconcile(scenario: Scenario): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "nemoclaw-token-reconcile-"));
  tmpRoots.push(dir);
  const envFile = join(dir, "proxy-env.sh");
  const generator = join(dir, "generate.sh");
  writeFileSync(
    generator,
    [
      "#!/usr/bin/env bash",
      "set -e",
      'emit_sandbox_sourced_file() { cat > "$1"; }',
      WRITE_RUNTIME_SHELL_ENV.replaceAll("/tmp/nemoclaw-proxy-env.sh", envFile),
      '_PROXY_URL="http://10.200.0.1:3128"',
      '_NO_PROXY_VAL="localhost,127.0.0.1,::1,10.200.0.1"',
      '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
      '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      "_TOOL_REDIRECTS=()",
      `OPENCLAW_GATEWAY_TOKEN=${shellQuote(scenario.intended)}`,
      "write_runtime_shell_env",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  spawnSync("bash", [generator], { encoding: "utf-8" });

  const setup = [
    scenario.preset
      ? `${scenario.preset.readonly ? "readonly " : ""}OPENCLAW_GATEWAY_TOKEN=${shellQuote(scenario.preset.value)}`
      : "",
    scenario.readonlyPrivateSentinel ? "readonly _nemoclaw_gateway_token='CALLER-SENTINEL'" : "",
    scenario.shadowTestCommand ? "function [ { return 0; }" : "",
    scenario.shadowStatusCommands
      ? "function return { builtin return 0; }; function exit { builtin return 0; }; function echo { builtin return 0; }"
      : "",
    scenario.sourceUrl ? `OPENCLAW_GATEWAY_URL=${shellQuote(scenario.sourceUrl)}` : "",
  ].filter(Boolean);
  const sourceAndPrint = [
    `. ${shellQuote(envFile)}`,
    "_nemoclaw_test_source_status=$?",
    `case "$_nemoclaw_test_source_status" in 0) /usr/bin/printf 'TOKEN=[%s] PRIVATE=[%s]\\n' "\${OPENCLAW_GATEWAY_TOKEN-<UNSET>}" "\${_nemoclaw_gateway_token-<UNSET>}" ;; *) /usr/bin/false ;; esac`,
  ];
  const commands = scenario.repeatSources
    ? [...setup, ...sourceAndPrint, ...sourceAndPrint]
    : [...setup, ...sourceAndPrint];
  return spawnSync(scenario.shell ?? "sh", ["-c", commands.join("; ")], {
    encoding: "utf-8",
  });
}

describe("proxy-env OPENCLAW_GATEWAY_TOKEN trust-anchor reconcile (#8428)", () => {
  it.each(SHELLS)("emits a controlled conflict diagnostic under %s", (shell) => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell,
      preset: { value: "SENTINEL_CONFLICT", readonly: true },
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Error: conflicting trust anchor");
    expect(stderr).not.toContain("read only");
    expect(`${stdout}\n${stderr}`).not.toContain(REAL_TOKEN);
    expect(stdout).not.toContain("TOKEN=");
  });

  it.each(SHELLS)("accepts an identical readonly trust anchor under %s", (shell) => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell,
      preset: { value: REAL_TOKEN, readonly: true },
    });
    expect(status).toBe(0);
    expect(stdout).toContain(`TOKEN=[${REAL_TOKEN}]`);
    expect(stderr).not.toContain("conflicting trust anchor");
    expect(stderr).not.toContain("read only");
  });

  it("rejects a conflicting readonly value when Bash shadows the test command", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell: "bash",
      preset: { value: "SENTINEL_CONFLICT", readonly: true },
      shadowTestCommand: true,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Error: conflicting trust anchor");
    expect(stderr).not.toContain("read only");
    expect(`${stdout}\n${stderr}`).not.toContain(REAL_TOKEN);
    expect(stdout).not.toContain("TOKEN=");
  });

  it("rejects a conflicting readonly value when Bash shadows status commands", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell: "bash",
      preset: { value: "SENTINEL_CONFLICT", readonly: true },
      shadowStatusCommands: true,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Error: conflicting trust anchor");
    expect(stderr).not.toContain("read only");
    expect(`${stdout}\n${stderr}`).not.toContain(REAL_TOKEN);
    expect(stdout).not.toContain("TOKEN=");
  });

  it.each(SHELLS)("advances a writable value across repeated sourcing under %s", (shell) => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell,
      preset: { value: "WRITABLE-SENTINEL", readonly: false },
      repeatSources: true,
    });
    expect(status).toBe(0);
    expect(stdout.match(new RegExp(`TOKEN=\\[${REAL_TOKEN}\\]`, "g"))).toHaveLength(2);
    expect(stderr).toBe("");
  });

  it("does not depend on a caller-controlled readonly temporary variable", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      readonlyPrivateSentinel: true,
    });
    expect(status).toBe(0);
    expect(stdout).toContain(`TOKEN=[${REAL_TOKEN}] PRIVATE=[CALLER-SENTINEL]`);
    expect(stderr).toBe("");
  });

  it("keeps the non-loopback case exported empty", () => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      sourceUrl: "wss://remote.example.test",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("TOKEN=[]");
    expect(stderr).toBe("");
  });

  it.each(
    SHELLS.flatMap((shell) => EMPTY_TOKEN_URLS.map((sourceUrl) => ({ shell, sourceUrl }))),
  )("rejects a readonly nonempty token for $sourceUrl under $shell", ({ shell, sourceUrl }) => {
    const { status, stdout, stderr } = runReconcile({
      intended: REAL_TOKEN,
      shell,
      preset: { value: "SENTINEL_CONFLICT", readonly: true },
      sourceUrl,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Error: conflicting trust anchor");
    expect(stderr).not.toContain("read only");
    expect(`${stdout}\n${stderr}`).not.toContain("SENTINEL_CONFLICT");
    expect(`${stdout}\n${stderr}`).not.toContain(REAL_TOKEN);
    expect(stdout).not.toContain("TOKEN=");
  });
});
