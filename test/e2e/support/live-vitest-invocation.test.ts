// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLiveVitestArgs,
  HERMES_E2E_SWAP_BYTES,
  HERMES_E2E_SWAP_FILE,
  HERMES_E2E_SWAP_SCRIPT,
  LIVE_VITEST_PROJECT,
  type LiveVitestSpawner,
  needsHermesE2ESwap,
  RISK_SIGNAL_REPORTER,
  runLiveVitestCommand,
  validateLiveProject,
  validateLiveSelector,
  validateLiveTestPath,
} from "../../../tools/e2e/live-vitest-invocation.mts";

const LIVE_VITEST_TOOL = path.resolve("tools/e2e/live-vitest-invocation.mts");
const TSX = path.resolve("node_modules", ".bin", "tsx");
const EXACT_HEAD_SHA = "a".repeat(40);

interface FakeSwapScriptOptions {
  failCleanupQuery?: boolean;
  failSwapoff?: boolean;
}

interface FakeSwapScriptResult {
  calls: string[];
  status: number | null;
  stderr: string;
}

function writeFakeCommand(directory: string, name: string, lines: string[]): void {
  const commandPath = path.join(directory, name);
  writeFileSync(commandPath, `${["#!/bin/sh", "set -eu", ...lines].join("\n")}\n`);
  chmodSync(commandPath, 0o755);
}

function runHermesSwapScriptFailure(options: FakeSwapScriptOptions = {}): FakeSwapScriptResult {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-swap-"));
  const callLog = path.join(fakeBin, "calls.log");
  const swapState = path.join(fakeBin, "swap-state");
  const nameQueryCount = path.join(fakeBin, "name-query-count");
  writeFileSync(swapState, "inactive\n");

  writeFakeCommand(fakeBin, "swapon", [
    `printf 'swapon:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
    'case "$*" in',
    '  *"--output SIZE"*)',
    `    printf '1\\n'`,
    "    ;;",
    '  *"--output NAME"*)',
    "    query_count=0",
    '    if [ -f "$FAKE_NAME_QUERY_COUNT_FILE" ]; then',
    '      IFS= read -r query_count < "$FAKE_NAME_QUERY_COUNT_FILE" || query_count=0',
    "    fi",
    "    query_count=$((query_count + 1))",
    `    printf '%s\\n' "$query_count" > "$FAKE_NAME_QUERY_COUNT_FILE"`,
    '    if [ "${FAKE_FAIL_NAME_QUERY_AT:-0}" -eq "$query_count" ]; then',
    `      printf 'swapon-name-query:%s:fail\\n' "$query_count" >> "$FAKE_CALL_LOG"`,
    "      exit 41",
    "    fi",
    '    swap_state="inactive"',
    '    if [ -f "$FAKE_SWAP_STATE_FILE" ]; then',
    '      IFS= read -r swap_state < "$FAKE_SWAP_STATE_FILE" || swap_state="inactive"',
    "    fi",
    `    printf 'swapon-name-query:%s:%s\\n' "$query_count" "$swap_state" >> "$FAKE_CALL_LOG"`,
    '    if [ "$swap_state" = "active" ]; then',
    `      printf '%s\\n' "$FAKE_FIXED_SWAP"`,
    "    fi",
    "    ;;",
    "  *)",
    `    printf 'active\\n' > "$FAKE_SWAP_STATE_FILE"`,
    `    printf 'swapon-activate:%s\\n' "$1" >> "$FAKE_CALL_LOG"`,
    "    ;;",
    "esac",
  ]);
  writeFakeCommand(fakeBin, "awk", ["while IFS= read -r _line; do :; done", `printf '1\\n'`]);
  writeFakeCommand(fakeBin, "swapoff", [
    `printf 'swapoff:%s\\n' "$1" >> "$FAKE_CALL_LOG"`,
    'if [ "${FAKE_FAIL_SWAPOFF:-0}" = "1" ]; then',
    "  exit 42",
    "fi",
    `printf 'inactive\\n' > "$FAKE_SWAP_STATE_FILE"`,
  ]);
  writeFakeCommand(fakeBin, "rm", [`printf 'rm:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]);
  writeFakeCommand(fakeBin, "fallocate", [`printf 'fallocate:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]);
  writeFakeCommand(fakeBin, "chmod", [`printf 'chmod:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]);
  writeFakeCommand(fakeBin, "mkswap", [`printf 'mkswap:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]);

  try {
    const result = spawnSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        HERMES_E2E_SWAP_SCRIPT,
        "hermes-e2e-swap-test",
        HERMES_E2E_SWAP_FILE,
        String(HERMES_E2E_SWAP_BYTES),
      ],
      {
        encoding: "utf8",
        env: {
          FAKE_CALL_LOG: callLog,
          FAKE_FAIL_NAME_QUERY_AT: options.failCleanupQuery ? "2" : "0",
          FAKE_FAIL_SWAPOFF: options.failSwapoff ? "1" : "0",
          FAKE_FIXED_SWAP: HERMES_E2E_SWAP_FILE,
          FAKE_NAME_QUERY_COUNT_FILE: nameQueryCount,
          FAKE_SWAP_STATE_FILE: swapState,
          LC_ALL: "C",
          PATH: fakeBin,
        },
      },
    );
    expect(result.error).toBeUndefined();
    const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").trimEnd().split("\n") : [];
    return { calls, status: result.status, stderr: result.stderr };
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
}

describe("validateLiveProject (#6961)", () => {
  it("accepts the live project and defaults to it", () => {
    expect(validateLiveProject("e2e-live")).toBe(LIVE_VITEST_PROJECT);
    expect(validateLiveProject(undefined)).toBe(LIVE_VITEST_PROJECT);
  });

  it("rejects any other project", () => {
    for (const project of ["cli", "e2e-support", "e2e-live-extra", "integration"]) {
      expect(() => validateLiveProject(project)).toThrow(/unsupported vitest project/);
    }
  });
});

describe("validateLiveTestPath (#6961)", () => {
  it("accepts a real live test path", () => {
    expect(validateLiveTestPath("test/e2e/live/registry-targets.test.ts")).toBe(
      "test/e2e/live/registry-targets.test.ts",
    );
  });

  it("rejects paths outside the live test root", () => {
    expect(() => validateLiveTestPath("test/e2e/support/thing.test.ts")).toThrow(
      /must be under test\/e2e\/live/,
    );
    expect(() => validateLiveTestPath("src/lib/onboard.ts")).toThrow(/must be under/);
  });

  it("rejects '..' traversal", () => {
    expect(() => validateLiveTestPath("test/e2e/live/../support/x.test.ts")).toThrow(/traverse/);
  });

  it("rejects absolute paths", () => {
    expect(() => validateLiveTestPath("/etc/passwd")).toThrow(/unsupported character|absolute/);
  });

  it("rejects shell metacharacters", () => {
    for (const bad of [
      "test/e2e/live/x.test.ts; rm -rf /",
      "test/e2e/live/$(whoami).test.ts",
      "test/e2e/live/x.test.ts && curl evil",
      "test/e2e/live/`id`.test.ts",
      "test/e2e/live/x.test.ts|cat",
    ]) {
      expect(() => validateLiveTestPath(bad)).toThrow(/unsupported character/);
    }
  });

  it("requires a .test.ts file", () => {
    expect(() => validateLiveTestPath("test/e2e/live/fixtures")).toThrow(/\.test\.ts/);
  });

  it("requires a non-empty path", () => {
    expect(() => validateLiveTestPath("")).toThrow(/required/);
    expect(() => validateLiveTestPath(undefined)).toThrow(/required/);
  });
});

describe("validateLiveSelector (#6961)", () => {
  it("accepts anchored title patterns", () => {
    expect(validateLiveSelector("^ubuntu-repo-cloud-openclaw$")).toBe(
      "^ubuntu-repo-cloud-openclaw$",
    );
    expect(validateLiveSelector("^skill-agent$")).toBe("^skill-agent$");
  });

  it("treats an absent or empty selector as no selector", () => {
    expect(validateLiveSelector(undefined)).toBeUndefined();
    expect(validateLiveSelector("")).toBeUndefined();
    expect(validateLiveSelector("   ")).toBeUndefined();
  });

  it("rejects shell metacharacters in the expanded selector", () => {
    for (const bad of [
      "^$(touch pwned)$",
      "^x$; rm -rf /",
      "^x$ && evil",
      "^`id`$",
      "^x|y$",
      "^x>out$",
    ]) {
      expect(() => validateLiveSelector(bad)).toThrow(/unsupported character/);
    }
  });
});

describe("buildLiveVitestArgs (#6961)", () => {
  it("builds the standard invocation with a selector", () => {
    expect(
      buildLiveVitestArgs({
        testPath: "test/e2e/live/registry-targets.test.ts",
        selector: "^ubuntu-repo-cloud-openclaw$",
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      "test/e2e/live/registry-targets.test.ts",
      "-t",
      "^ubuntu-repo-cloud-openclaw$",
      "--silent=false",
      "--reporter=default",
      `--reporter=${RISK_SIGNAL_REPORTER}`,
    ]);
  });

  it("omits the selector arguments for a single-file target", () => {
    expect(
      buildLiveVitestArgs({
        testPath: "test/e2e/live/diagnostics.test.ts",
      }),
    ).toEqual([
      "vitest",
      "run",
      "--project",
      "e2e-live",
      "test/e2e/live/diagnostics.test.ts",
      "--silent=false",
      "--reporter=default",
      `--reporter=${RISK_SIGNAL_REPORTER}`,
    ]);
  });

  it("fails closed on an invalid input before producing any argv", () => {
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/live/x.test.ts",
        selector: "^x$; rm -rf /",
      }),
    ).toThrow(/unsupported character/);
    expect(() =>
      buildLiveVitestArgs({
        testPath: "test/e2e/support/x.test.ts",
        selector: "^x$",
        project: "e2e-live",
      }),
    ).toThrow(/must be under/);
  });
});

describe("runLiveVitestCommand (#6961)", () => {
  const validArgs = ["run", "--test-path", "test/e2e/live/diagnostics.test.ts"];

  it.each([
    ["child status", { status: 7, signal: null }, 7],
    ["child signal", { status: null, signal: "SIGTERM" as NodeJS.Signals }, 143],
    ["missing status and signal", { status: null, signal: null }, 1],
  ])("preserves %s", (_label, result, expected) => {
    let spawned: Parameters<LiveVitestSpawner> | undefined;
    const spawn: LiveVitestSpawner = (...args) => {
      spawned = args;
      return result;
    };

    expect(runLiveVitestCommand(validArgs, spawn)).toBe(expected);
    expect(spawned).toEqual([
      "npx",
      [
        "vitest",
        "run",
        "--project",
        "e2e-live",
        "test/e2e/live/diagnostics.test.ts",
        "--silent=false",
        "--reporter=default",
        `--reporter=${RISK_SIGNAL_REPORTER}`,
      ],
      { stdio: "inherit" },
    ]);
  });

  it("surfaces child launch failures", () => {
    const launchError = new Error("spawn npx ENOENT");
    const spawn: LiveVitestSpawner = () => ({
      status: null,
      signal: null,
      error: launchError,
    });

    expect(() => runLiveVitestCommand(validArgs, spawn)).toThrow(launchError);
  });

  it.each([
    [
      "unknown option",
      ["run", "--test-path", "test/e2e/live/diagnostics.test.ts", "--selctor", "^x$"],
    ],
    ["bare selector", [...validArgs, "--selector"]],
  ])("rejects an %s before spawning Vitest", (_label, args) => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() => runLiveVitestCommand(args, spawn)).toThrow(/unsupported.*option|requires a value/);
    expect(spawned).toBe(false);
  });

  it("rejects a repeated supported option before spawning Vitest", () => {
    let spawned = false;
    const spawn: LiveVitestSpawner = () => {
      spawned = true;
      return { status: 0 };
    };

    expect(() =>
      runLiveVitestCommand(
        [...validArgs, "--test-path", "test/e2e/live/registry-targets.test.ts"],
        spawn,
      ),
    ).toThrow(/must not be repeated/);
    expect(spawned).toBe(false);
  });

  it.each([
    ["missing", []],
    ["unsupported", ["runx"]],
  ])("fails the workflow CLI for a %s subcommand", (_label, args) => {
    const result = spawnSync(TSX, [LIVE_VITEST_TOOL, ...args], { encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected "run"');
  });
});

describe("runLiveVitestCommand Hermes resource setup (#7145)", () => {
  it("provisions bounded idempotent swap before a hosted Hermes build", () => {
    const calls: Array<Parameters<LiveVitestSpawner>> = [];
    const spawn: LiveVitestSpawner = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    expect(
      runLiveVitestCommand(
        ["run", "--test-path", "test/e2e/live/hermes-inference-switch.test.ts"],
        spawn,
        {
          GITHUB_ACTIONS: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: EXACT_HEAD_SHA,
        },
      ),
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe("/usr/bin/sudo");
    expect(HERMES_E2E_SWAP_BYTES).toBe(34_359_738_368);
    expect(HERMES_E2E_SWAP_FILE).toBe("/mnt/nemoclaw-hermes-e2e.swap");
    expect(calls[0]?.[1].slice(0, 9)).toEqual([
      "-n",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      "LC_ALL=C",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
    ]);
    expect(calls[0]?.[1].slice(10)).toEqual([
      "nemoclaw-hermes-e2e-swap",
      HERMES_E2E_SWAP_FILE,
      String(HERMES_E2E_SWAP_BYTES),
    ]);
    const script = calls[0]?.[1][9] ?? "";
    expect(
      spawnSync("/bin/bash", ["--noprofile", "--norc", "-n"], {
        input: script,
      }).status,
    ).toBe(0);
    expect(script).toContain("if (( active_swap_bytes >= swap_size_bytes )); then");
    expect(script).toContain(
      'active_swap_names="$(swapon --show --noheadings --raw --output NAME)"',
    );
    expect(script).toContain('if [[ "$active_swap_name" == "$swap_file" ]]; then');
    expect(script).toContain(
      'if (( fixed_swap_active == 1 )); then\n  swapoff "$swap_file"\nfi\nrm -f -- "$swap_file"',
    );
    expect(script).toContain(
      'if cleanup_swap_names="$(swapon --show --noheadings --raw --output NAME 2>/dev/null)"; then',
    );
    expect(script).toContain('if swapoff "$swap_file" 2>/dev/null; then');
    expect(script).toContain("Preserving active Hermes E2E swap after setup failure");
    expect(script).toContain("Preserving Hermes E2E swap because active swap could not be queried");
    expect(script).not.toContain('swapoff "$swap_file" 2>/dev/null || true');
    expect(script).not.toContain("swap_enabled");
    expect(script).toContain('fallocate -l "$swap_size_bytes" "$swap_file"');
    expect(script).toContain("if (( active_swap_bytes < swap_size_bytes )); then");
    expect(calls[1]?.[0]).toBe("npx");
  });

  it("fails closed before Vitest when Hermes swap provisioning fails", () => {
    const calls: string[] = [];
    const spawn: LiveVitestSpawner = (command) => {
      calls.push(command);
      return { status: 23 };
    };

    expect(
      runLiveVitestCommand(
        ["run", "--test-path", "test/e2e/live/hermes-shields-config.test.ts"],
        spawn,
        {
          GITHUB_ACTIONS: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: EXACT_HEAD_SHA,
        },
      ),
    ).toBe(23);
    expect(calls).toEqual(["/usr/bin/sudo"]);
  });

  it.each([
    ["scheduled main", undefined],
    ["manual main without a checkout SHA", ""],
    ["a malformed checkout SHA", "A".repeat(40)],
  ])("does not provision swap for %s", (_label, expectedSha) => {
    const calls: string[] = [];
    const spawn: LiveVitestSpawner = (command) => {
      calls.push(command);
      return { status: 0 };
    };

    expect(
      runLiveVitestCommand(
        ["run", "--test-path", "test/e2e/live/hermes-inference-switch.test.ts"],
        spawn,
        {
          GITHUB_ACTIONS: "true",
          NEMOCLAW_E2E_EXPECTED_SHA: expectedSha,
        },
      ),
    ).toBe(0);
    expect(calls).toEqual(["npx"]);
  });
});

describe("HERMES_E2E_SWAP_SCRIPT failure cleanup (#7145)", () => {
  const provisioningFailureCalls = [
    "swapon:--show --bytes --noheadings --output SIZE",
    "swapon:--show --noheadings --raw --output NAME",
    "swapon-name-query:1:inactive",
    `rm:-f -- ${HERMES_E2E_SWAP_FILE}`,
    `fallocate:-l ${HERMES_E2E_SWAP_BYTES} ${HERMES_E2E_SWAP_FILE}`,
    `chmod:0600 ${HERMES_E2E_SWAP_FILE}`,
    `mkswap:${HERMES_E2E_SWAP_FILE}`,
    `swapon:${HERMES_E2E_SWAP_FILE}`,
    `swapon-activate:${HERMES_E2E_SWAP_FILE}`,
    "swapon:--show --bytes --noheadings --output SIZE",
    "swapon:--show --noheadings --raw --output NAME",
  ];

  it("removes the active fixed swap only after cleanup swapoff succeeds", () => {
    const result = runHermesSwapScriptFailure();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hermes E2E swap provisioning failed");
    expect(result.calls).toEqual([
      ...provisioningFailureCalls,
      "swapon-name-query:2:active",
      `swapoff:${HERMES_E2E_SWAP_FILE}`,
      `rm:-f -- ${HERMES_E2E_SWAP_FILE}`,
    ]);
  }, 15_000);

  it("preserves the active fixed swap when cleanup swapoff fails", () => {
    const result = runHermesSwapScriptFailure({ failSwapoff: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Preserving active Hermes E2E swap after setup failure");
    expect(result.calls).toEqual([
      ...provisioningFailureCalls,
      "swapon-name-query:2:active",
      `swapoff:${HERMES_E2E_SWAP_FILE}`,
    ]);
    expect(
      result.calls
        .slice(result.calls.indexOf(`swapon-activate:${HERMES_E2E_SWAP_FILE}`) + 1)
        .filter((call) => call.startsWith("rm:")),
    ).toEqual([]);
  }, 15_000);

  it("preserves the fixed swap when cleanup cannot query active swap", () => {
    const result = runHermesSwapScriptFailure({ failCleanupQuery: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Preserving Hermes E2E swap because active swap could not be queried",
    );
    expect(result.calls).toEqual([...provisioningFailureCalls, "swapon-name-query:2:fail"]);
    expect(
      result.calls
        .slice(result.calls.indexOf(`swapon-activate:${HERMES_E2E_SWAP_FILE}`) + 1)
        .filter((call) => call.startsWith("rm:")),
    ).toEqual([]);
  }, 15_000);
});

describe("needsHermesE2ESwap (#7145)", () => {
  const exactHeadEnv = {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_E2E_EXPECTED_SHA: EXACT_HEAD_SHA,
  };

  it.each([
    ["Hermes inference switch", "test/e2e/live/hermes-inference-switch.test.ts", {}],
    ["Hermes shields", "test/e2e/live/hermes-shields-config.test.ts", {}],
    ["agent turn latency", "test/e2e/live/agent-turn-latency.test.ts", {}],
    [
      "Hermes Bedrock",
      "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
      { NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "Hermes E2E",
      "test/e2e/live/hermes-e2e.test.ts",
      { E2E_TARGET_ID: "hermes-e2e", NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "Hermes dashboard",
      "test/e2e/live/hermes-e2e.test.ts",
      { E2E_TARGET_ID: "hermes-dashboard", NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "Hermes security posture",
      "test/e2e/live/hermes-e2e.test.ts",
      { E2E_TARGET_ID: "security-posture", NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "Hermes MCP",
      "test/e2e/live/mcp-bridge.test.ts",
      { E2E_TARGET_ID: "mcp-bridge", NEMOCLAW_MCP_BRIDGE_AGENT: "hermes" },
    ],
  ])("selects the exact-head hosted %s build", (_label, testPath, env) => {
    expect(needsHermesE2ESwap(testPath, { ...exactHeadEnv, ...env })).toBe(true);
  });

  it.each([
    [
      "a non-GitHub runner",
      "test/e2e/live/hermes-inference-switch.test.ts",
      { GITHUB_ACTIONS: "" },
    ],
    [
      "a scheduled main run",
      "test/e2e/live/hermes-inference-switch.test.ts",
      { NEMOCLAW_E2E_EXPECTED_SHA: undefined },
    ],
    [
      "a manual main run without a checkout SHA",
      "test/e2e/live/hermes-inference-switch.test.ts",
      { NEMOCLAW_E2E_EXPECTED_SHA: "" },
    ],
    [
      "an uppercase checkout SHA",
      "test/e2e/live/hermes-inference-switch.test.ts",
      { NEMOCLAW_E2E_EXPECTED_SHA: "A".repeat(40) },
    ],
    [
      "the OpenClaw Bedrock shard",
      "test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts",
      { GITHUB_ACTIONS: "true", NEMOCLAW_AGENT: "openclaw" },
    ],
    [
      "the OpenClaw security posture shard",
      "test/e2e/live/hermes-e2e.test.ts",
      {
        E2E_TARGET_ID: "security-posture",
        GITHUB_ACTIONS: "true",
        NEMOCLAW_AGENT: "openclaw",
      },
    ],
    [
      "an unlisted Hermes target sharing the test file",
      "test/e2e/live/hermes-e2e.test.ts",
      { E2E_TARGET_ID: "future-hermes-job", NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "a non-Hermes MCP shard",
      "test/e2e/live/mcp-bridge.test.ts",
      {
        E2E_TARGET_ID: "mcp-bridge",
        GITHUB_ACTIONS: "true",
        NEMOCLAW_MCP_BRIDGE_AGENT: "deepagents",
      },
    ],
    [
      "the explicit-only MCP dev lane",
      "test/e2e/live/mcp-bridge.test.ts",
      {
        E2E_TARGET_ID: "mcp-bridge-dev",
        GITHUB_ACTIONS: "true",
        NEMOCLAW_MCP_BRIDGE_AGENT: "hermes",
      },
    ],
    [
      "a rebuild lane with workflow-managed swap",
      "test/e2e/live/rebuild-hermes.test.ts",
      { GITHUB_ACTIONS: "true", NEMOCLAW_AGENT: "hermes" },
    ],
    [
      "a self-hosted Hermes lane",
      "test/e2e/live/hermes-slack-e2e.test.ts",
      { GITHUB_ACTIONS: "true", NEMOCLAW_AGENT: "hermes" },
    ],
  ])("does not select %s", (_label, testPath, env) => {
    expect(needsHermesE2ESwap(testPath, { ...exactHeadEnv, ...env })).toBe(false);
  });
});
