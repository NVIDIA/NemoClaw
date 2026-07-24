// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  TRUSTED_HERMES_SWAP_SCRIPT,
  TRUSTED_HERMES_SWAP_STEP_NAME,
  validateTrustedHermesSwapWorkflow,
} from "../../../tools/e2e/trusted-hermes-swap-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { requireFixture } from "./require-fixture";

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
};

type SwapWorkflow = {
  jobs: Record<string, { needs?: string; steps?: WorkflowStep[] }>;
};

const PROTECTED_JOBS = [
  "agent-turn-latency",
  "bedrock-runtime-compatible-anthropic",
  "hermes-dashboard",
  "hermes-e2e",
  "hermes-inference-switch",
  "hermes-shields-config",
  "mcp-bridge",
  "security-posture",
] as const;

function trustedSwapStep(workflow: SwapWorkflow, jobName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps?.find(
    (candidate) => candidate.name === TRUSTED_HERMES_SWAP_STEP_NAME,
  );
  requireFixture(step, `${jobName} trusted Hermes swap step is missing`);
  return step;
}

type SwapHarnessOptions = {
  activeSwapBytes?: number;
  diskBytes?: number;
  failCleanupQuery?: boolean;
  failMkswap?: boolean;
  failSwapoff?: boolean;
  hiddenActivationReads?: number;
  provisionedSwapBytes?: number;
};

type SwapHarnessResult = {
  calls: string[];
  status: number | null;
  stderr: string;
};

function writeFakeCommand(directory: string, name: string, lines: string[]): string {
  const commandPath = path.join(directory, name);
  writeFileSync(commandPath, `${["#!/bin/sh", "set -eu", ...lines].join("\n")}\n`);
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function runTrustedSwapHarness(options: SwapHarnessOptions = {}): SwapHarnessResult {
  const fakeBin = mkdtempSync(path.join(tmpdir(), "nemoclaw-trusted-swap-"));
  const callLog = path.join(fakeBin, "calls.log");
  const queryCount = path.join(fakeBin, "query-count");
  const swapState = path.join(fakeBin, "swap-state");
  const swapFile = "/mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap";
  writeFileSync(swapState, "inactive\n");

  const commands = new Map<string, string>();
  commands.set(
    "/usr/sbin/swapon",
    writeFakeCommand(fakeBin, "swapon", [
      `printf 'swapon:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      'case "$*" in',
      '  *"--show=SIZE"*)',
      '    state="$(head -n 1 "$FAKE_SWAP_STATE")"',
      '    if [ "$state" = "active" ]; then',
      "      count=0",
      '      [ ! -f "$FAKE_QUERY_COUNT" ] || count="$(head -n 1 "$FAKE_QUERY_COUNT")"',
      '      if [ "$count" -le "$FAKE_HIDDEN_ACTIVATION_READS" ]; then',
      '        printf "0\\n"',
      "      else",
      '        printf "%s\\n" "$FAKE_PROVISIONED_SWAP_BYTES"',
      "      fi",
      "    else",
      '      printf "%s\\n" "$FAKE_ACTIVE_SWAP_BYTES"',
      "    fi",
      "    ;;",
      '  *"--show=NAME"*)',
      "    count=0",
      '    [ ! -f "$FAKE_QUERY_COUNT" ] || count="$(head -n 1 "$FAKE_QUERY_COUNT")"',
      "    count=$((count + 1))",
      '    printf "%s\\n" "$count" > "$FAKE_QUERY_COUNT"',
      '    if [ "${FAKE_FAIL_QUERY_AT:-0}" -eq "$count" ]; then exit 41; fi',
      '    state="$(head -n 1 "$FAKE_SWAP_STATE")"',
      '    if [ "$state" = "active" ] && [ "$count" -gt "$FAKE_HIDDEN_ACTIVATION_READS" ]; then',
      '      printf "%s\\n" "$FAKE_SWAP_FILE"',
      "    fi",
      "    ;;",
      '  "--show")',
      "    ;;",
      '  *"--show"*)',
      "    exit 42",
      "    ;;",
      "  *)",
      '    printf "active\\n" > "$FAKE_SWAP_STATE"',
      '    printf "swapon-activate:%s\\n" "$1" >> "$FAKE_CALL_LOG"',
      "    ;;",
      "esac",
    ]),
  );
  commands.set(
    "/usr/sbin/swapoff",
    writeFakeCommand(fakeBin, "swapoff", [
      `printf 'swapoff:%s\\n' "$1" >> "$FAKE_CALL_LOG"`,
      '[ "${FAKE_FAIL_SWAPOFF:-0}" != "1" ] || exit 42',
      'printf "inactive\\n" > "$FAKE_SWAP_STATE"',
    ]),
  );
  commands.set(
    "/usr/sbin/mkswap",
    writeFakeCommand(fakeBin, "mkswap", [
      `printf 'mkswap:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      '[ "${FAKE_FAIL_MKSWAP:-0}" != "1" ] || exit 43',
    ]),
  );
  commands.set(
    "/usr/bin/stat",
    writeFakeCommand(fakeBin, "stat", [
      `printf 'stat:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      'case "$*" in',
      '  *"%F:%u:%g:%a"*) printf "directory:0:0:700\\n" ;;',
      '  *"%F:%u:%g"*) printf "directory:0:0\\n" ;;',
      '  *"%u:%g:%a"*) printf "0:0:600\\n" ;;',
      '  *"%s"*) printf "34359742464\\n" ;;',
      "  *) exit 44 ;;",
      "esac",
    ]),
  );
  commands.set(
    "/usr/bin/df",
    writeFakeCommand(fakeBin, "df", [
      `printf 'df:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      'printf "Avail\\n%s\\n" "$FAKE_DISK_BYTES"',
    ]),
  );
  commands.set(
    "/usr/bin/test",
    writeFakeCommand(fakeBin, "test", [
      `printf 'test:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      'case "$1:$2" in',
      '  "-f:$FAKE_SWAP_FILE") exit 0 ;;',
      '  "-L:$FAKE_SWAP_FILE") exit 1 ;;',
      "  *) exit 1 ;;",
      "esac",
    ]),
  );
  commands.set(
    "/usr/bin/mktemp",
    writeFakeCommand(fakeBin, "mktemp", [
      `printf 'mktemp:%s\\n' "$*" >> "$FAKE_CALL_LOG"`,
      'printf "%s\\n" "$FAKE_SWAP_FILE"',
    ]),
  );
  commands.set(
    "/usr/bin/sleep",
    writeFakeCommand(fakeBin, "sleep", [`printf 'sleep:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]),
  );
  for (const command of ["mkdir", "fallocate", "rm", "rmdir"]) {
    commands.set(
      `/usr/bin/${command}`,
      writeFakeCommand(fakeBin, command, [`printf '${command}:%s\\n' "$*" >> "$FAKE_CALL_LOG"`]),
    );
  }

  let script = TRUSTED_HERMES_SWAP_SCRIPT.replaceAll("/usr/bin/sudo -n ", "");
  for (const [absolute, fake] of [...commands].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    script = script.replaceAll(absolute, fake);
  }

  try {
    const workflowSha = "b".repeat(40);
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      env: {
        BASH_ENV: "/dev/null",
        CHECKOUT_SHA: "a".repeat(40),
        DISPATCH_SHA: workflowSha,
        ENV: "/dev/null",
        EVENT_NAME: "workflow_dispatch",
        EXPECTED_WORKFLOW_SHA: workflowSha,
        FAKE_ACTIVE_SWAP_BYTES: String(options.activeSwapBytes ?? 0),
        FAKE_CALL_LOG: callLog,
        FAKE_DISK_BYTES: String(options.diskBytes ?? 100_000_000_000),
        FAKE_FAIL_MKSWAP: options.failMkswap ? "1" : "0",
        FAKE_FAIL_QUERY_AT: options.failCleanupQuery ? "6" : "0",
        FAKE_FAIL_SWAPOFF: options.failSwapoff ? "1" : "0",
        FAKE_HIDDEN_ACTIVATION_READS: String(options.hiddenActivationReads ?? 0),
        FAKE_PROVISIONED_SWAP_BYTES: String(options.provisionedSwapBytes ?? 1),
        FAKE_QUERY_COUNT: queryCount,
        FAKE_SWAP_FILE: swapFile,
        FAKE_SWAP_STATE: swapState,
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
        REF: "refs/heads/main",
        REPOSITORY: "NVIDIA/NemoClaw",
        RUNNER_ARCH_KIND: "X64",
        RUNNER_ENVIRONMENT_KIND: "github-hosted",
        RUNNER_OS_KIND: "Linux",
        WORKFLOW_SHA: workflowSha,
      },
    });
    const calls = readFileSync(callLog, "utf8").trimEnd().split("\n");
    return { calls, status: result.status, stderr: result.stderr };
  } finally {
    rmSync(fakeBin, { force: true, recursive: true });
  }
}

describe("trusted Hermes swap workflow boundary", () => {
  // source-shape-contract: security -- Pins the trusted privileged program to the first pre-checkout step in every eligible lane
  it("keeps the fixed privileged program before candidate checkout in every protected job (#7145)", () => {
    const workflow = readWorkflow() as SwapWorkflow;

    expect(validateTrustedHermesSwapWorkflow(workflow)).toEqual([]);
    for (const jobName of PROTECTED_JOBS) {
      const steps = workflow.jobs[jobName]!.steps!;
      const provision = trustedSwapStep(workflow, jobName);
      const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));

      expect(steps.indexOf(provision)).toBe(0);
      expect(steps.indexOf(checkout!)).toBeGreaterThan(0);
      expect(provision.run?.trimEnd()).toBe(TRUSTED_HERMES_SWAP_SCRIPT);
      expect(JSON.stringify(provision.env)).not.toContain("secrets.");
    }
  });

  it("keeps the trusted program fail-closed, bounded, and syntactically valid (#7145)", () => {
    expect(
      spawnSync("/bin/bash", ["--noprofile", "--norc", "-n"], {
        input: TRUSTED_HERMES_SWAP_SCRIPT,
      }).status,
    ).toBe(0);
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain('"${RUNNER_ENVIRONMENT_KIND}" != "github-hosted"');
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain("readonly required_swap_bytes=34359738368");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain("readonly swap_file_bytes=34359742464");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain("readonly reserve_bytes=17179869184");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain("readonly activation_observation_attempts=5");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain("readonly activation_observation_delay_seconds=1");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain(
      '/usr/bin/sudo -n /usr/bin/mktemp --tmpdir="${swap_dir}"',
    );
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain(
      '/usr/bin/sudo -n /usr/sbin/swapoff "${swap_file}"',
    );
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain(
      "/usr/bin/sudo -n /usr/sbin/swapon --show=SIZE --bytes --noheadings",
    );
    expect(TRUSTED_HERMES_SWAP_SCRIPT).toContain(
      "/usr/bin/sudo -n /usr/sbin/swapon --show=NAME --noheadings --raw",
    );
    expect(TRUSTED_HERMES_SWAP_SCRIPT).not.toContain("/usr/sbin/swapon --output");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).not.toContain("/bin/bash -c");
    expect(TRUSTED_HERMES_SWAP_SCRIPT).not.toContain("${{");
  });

  it("exits before privileged allocation when enough swap is already active (#7145)", () => {
    const result = runTrustedSwapHarness({ activeSwapBytes: 34_359_738_368 });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "stat:-c %F:%u:%g -- /mnt",
      "swapon:--show=SIZE --bytes --noheadings",
    ]);
  });

  it("provisions bounded swap without cleanup when setup succeeds (#7145)", () => {
    const result = runTrustedSwapHarness({ provisionedSwapBytes: 34_359_738_368 });

    expect(result.status).toBe(0);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        "fallocate:-l 34359742464 /mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
        "mkswap:--quiet /mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
        "swapon:/mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
        "swapon-activate:/mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
        "swapon:--show=NAME --noheadings --raw",
        "swapon:--show=SIZE --bytes --noheadings",
        "swapon:--show",
      ]),
    );
    expect(result.calls.filter((call) => call.startsWith("swapon-activate:"))).toHaveLength(1);
    expect(
      result.calls.filter(
        (call) =>
          call.startsWith("swapoff:") || call.startsWith("rm:") || call.startsWith("rmdir:"),
      ),
    ).toEqual([]);
  });

  it("waits for delayed activation visibility without repeating activation (#7145)", () => {
    const result = runTrustedSwapHarness({
      hiddenActivationReads: 2,
      provisionedSwapBytes: 34_359_738_368,
    });

    expect(result.status).toBe(0);
    expect(result.calls.filter((call) => call === "sleep:1")).toHaveLength(2);
    expect(result.calls.filter((call) => call.startsWith("swapon-activate:"))).toHaveLength(1);
    expect(result.calls.filter((call) => call.startsWith("swapoff:"))).toEqual([]);
  });

  it("removes an inactive partial allocation after setup fails (#7145)", () => {
    const result = runTrustedSwapHarness({ failMkswap: true });

    expect(result.status).toBe(43);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        "rm:-f -- /mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
        "rmdir:-- /mnt/nemoclaw-hermes-e2e-swap",
      ]),
    );
  });

  it("disables an active partial allocation before removing it (#7145)", () => {
    const result = runTrustedSwapHarness();
    const swapoffIndex = result.calls.indexOf(
      "swapoff:/mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
    );
    const removeIndex = result.calls.indexOf(
      "rm:-f -- /mnt/nemoclaw-hermes-e2e-swap/nemoclaw-hermes.fake.swap",
    );

    expect(result.status).toBe(1);
    expect(swapoffIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(swapoffIndex);
  });

  it.each([
    {
      expected: "Preserving Hermes E2E swap because active swap could not be queried",
      name: "the active-swap query fails",
      options: { failCleanupQuery: true },
    },
    {
      expected: "Preserving active Hermes E2E swap after setup failure",
      name: "activation visibility stays stale and swapoff fails",
      options: { failSwapoff: true, hiddenActivationReads: 5 },
    },
  ])("preserves the partial allocation when $name (#7145)", ({ expected, options }) => {
    const result = runTrustedSwapHarness(options);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.calls.filter((call) => call.startsWith("rm:"))).toEqual([]);
  });

  it("fails before allocation when disk reserve is unavailable (#7145)", () => {
    const result = runTrustedSwapHarness({ diskBytes: 1 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("insufficient disk capacity");
    expect(result.calls.some((call) => call.startsWith("mkdir:"))).toBe(false);
  });

  it("rejects eligibility, ordering, environment, and program drift (#7145)", () => {
    const workflow = readWorkflow() as SwapWorkflow;
    const latencySteps = workflow.jobs["agent-turn-latency"]!.steps!;
    const latencyProvision = trustedSwapStep(workflow, "agent-turn-latency");
    latencySteps.splice(latencySteps.indexOf(latencyProvision), 1);
    latencySteps.push(latencyProvision);
    workflow.jobs["agent-turn-latency"]!.needs = "candidate-plan";
    latencyProvision["continue-on-error"] = true;

    const securityProvision = trustedSwapStep(workflow, "security-posture");
    securityProvision.if = securityProvision.if!.replace(" && matrix.agent == 'hermes'", "");
    securityProvision.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    const bedrockProvision = trustedSwapStep(workflow, "bedrock-runtime-compatible-anthropic");
    bedrockProvision.run = "sudo bash tools/e2e/live-vitest-invocation.mts";

    const hermesE2eProvision = trustedSwapStep(workflow, "hermes-e2e");
    hermesE2eProvision.if = hermesE2eProvision.if!.replace(
      " && (contains(format(',{0},', inputs.jobs), ',hermes-e2e,') || contains(format(',{0},', inputs.targets), ',hermes-e2e,'))",
      "",
    );

    workflow.jobs["mcp-bridge-dev"]!.steps!.unshift({
      ...trustedSwapStep(workflow, "mcp-bridge"),
    });

    expect(validateTrustedHermesSwapWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "agent-turn-latency trusted Hermes swap job must depend on controller validation",
        "agent-turn-latency trusted Hermes swap step must preserve its fail-closed shape",
        "agent-turn-latency trusted Hermes swap step must run before candidate checkout",
        "hermes-e2e trusted Hermes swap step must preserve the exact-head main guard",
        "security-posture trusted Hermes swap step must preserve the exact-head main guard",
        "security-posture trusted Hermes swap step must bind only trusted workflow, checkout, and runner identity",
        "bedrock-runtime-compatible-anthropic trusted Hermes swap step must preserve the fixed privileged program",
        "mcp-bridge-dev job must not provision trusted Hermes swap",
      ]),
    );
  });
});
