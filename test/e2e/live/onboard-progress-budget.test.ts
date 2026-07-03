// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//
// Live acceptance test for issue #6002. It measures the issue's actual
// acceptance path — onboard step [1/8] through the first agent response — and
// asserts a real worktree-CLI onboard:
//   1. never leaves a wait-heavy phase silent longer than the 60s guarantee
//      (proved from timestamped stdout/stderr chunks), and
//   2. builds the sandbox image with BuildKit (the prebuild speed path), and
//   3. reaches the first agent response (a headless `openclaw agent` turn that
//      returns a real hosted-inference reply), and
//   4. does all of that within the ≤3-minute budget (NEMOCLAW_E2E_ONBOARD_BUDGET_SECS).
//
// Uses real hosted inference (NVIDIA_INFERENCE_API_KEY) because a genuine first
// response requires a real LLM turn — a stub endpoint completes onboarding's
// inference smoke but cannot drive a full agent turn. Opt-in via
// NEMOCLAW_RUN_LIVE_E2E=1; requires the hosted-inference key.

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeOutputEvent, ShellProbeResult } from "../fixtures/shell-probe.ts";
import { extractOpenClawAgentText } from "./agent-turn-latency-helpers.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const HOSTED_INFERENCE_SECRET = "NVIDIA_INFERENCE_API_KEY";
const SANDBOX_NAME = process.env.NEMOCLAW_E2E_PROGRESS_SANDBOX ?? "e2e-progress-budget";
// Timeout env vars are named *_SECS because their values are seconds (×1000
// below), matching their unit.
const ONBOARD_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_ONBOARD_TIMEOUT_SECS ?? 1_200) * 1_000;
const FIRST_TURN_TIMEOUT_MS =
  Number(process.env.NEMOCLAW_E2E_FIRST_TURN_TIMEOUT_SECS ?? 240) * 1_000;
// Budget for the whole [1/8]-to-first-response path. Defaults to the issue's
// ≤3-minute goal (180s); constrained / cold-cache runners can raise
// NEMOCLAW_E2E_ONBOARD_BUDGET_SECS.
const BUDGET_SECS = Number(process.env.NEMOCLAW_E2E_ONBOARD_BUDGET_SECS ?? 180);
// The issue's guarantee: no onboarding phase stays silent longer than this.
const MAX_SILENCE_SECS = Number(process.env.NEMOCLAW_E2E_MAX_SILENCE_SECS ?? 60);
const TEST_TIMEOUT_MS = 45 * 60_000;
// Gated at declaration (no in-body `if`): live E2E is explicitly opt-in.
const liveTest = shouldRunLiveE2E() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    OPENSHELL_GATEWAY: "nemoclaw",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
  };
}

function onboardEnv(apiKey: string): NodeJS.ProcessEnv {
  return commandEnv({
    // NVIDIA Endpoints hosted inference (default non-interactive provider).
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_DASHBOARD_PORT: "",
    CHAT_UI_URL: "",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    // Force the BuildKit prebuild path on under the Vitest-hosted live test.
    NEMOCLAW_SANDBOX_PREBUILD: "1",
  });
}

async function ignoreCleanupError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup; never mask the lifecycle assertions.
  }
}

async function cleanupProgressState(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await ignoreCleanupError(() =>
    host.command(process.execPath, [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy",
      env: commandEnv(),
      timeoutMs: 180_000,
    }),
  );
  await ignoreCleanupError(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await ignoreCleanupError(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

liveTest(
  "onboard [1/8] reaches a first response within 3 minutes without a 60-second output gap (#6002)",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    const apiKey = secrets.required(HOSTED_INFERENCE_SECRET);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    cleanup.add("remove progress-budget sandbox and gateway", async () => {
      await cleanupProgressState(host, sandbox);
    });
    await cleanupProgressState(host, sandbox);

    // Starting before process spawn is a conservative upper bound for the
    // issue's literal [1/8]-to-response budget; the output assertion below
    // proves that the expected wizard anchor was actually reached.
    const startedAt = Date.now();
    const outputEvents: ShellProbeOutputEvent[] = [];
    const onboard: ShellProbeResult = await host.command(
      process.execPath,
      [CLI_ENTRYPOINT, "onboard", "--non-interactive", "--no-gpu"],
      {
        artifactName: "onboard-progress-budget",
        env: onboardEnv(apiKey),
        onOutput: (event) => outputEvents.push(event),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardFinishedAt = Date.now();
    const onboardSecs = Math.round((onboardFinishedAt - startedAt) / 1000);

    // Strip ANSI so text assertions are colour-independent (ESC built from a
    // char code so there is no control literal in source).
    const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const plain = resultText(onboard).replace(ansiSgr, "");
    const heartbeatCount = (plain.match(/Still working on /g) ?? []).length;
    const usedBuildKitPrebuild = /Building sandbox image with BuildKit/.test(plain);
    const classicBuildSteps = (plain.match(/Step \d+\/\d+ :/g) ?? []).length;

    const outputTimes = [startedAt, ...outputEvents.map((event) => event.atMs), onboardFinishedAt];
    const maxSilenceSecs = Math.ceil(
      Math.max(...outputTimes.slice(1).map((atMs, index) => atMs - outputTimes[index])) / 1000,
    );

    expect(onboard.exitCode, plain).toBe(0);
    expect(plain, "expected literal wizard step [1/8] in onboard output").toContain("[1/8]");
    // (2) BuildKit prebuild ran (the speed fix), not the classic in-gateway builder.
    expect(usedBuildKitPrebuild, "expected the BuildKit prebuild to run").toBe(true);
    expect(classicBuildSteps, "expected no classic per-instruction build steps").toBe(0);
    // (1) Adjacent terminal output chunks never exceeded the 60-second
    // guarantee. Heartbeats account for otherwise quiet phases.
    expect(
      maxSilenceSecs,
      `longest silent gap ${maxSilenceSecs}s exceeds the ${MAX_SILENCE_SECS}s guarantee`,
    ).toBeLessThanOrEqual(MAX_SILENCE_SECS);
    // (3) First agent response: a real headless `openclaw agent` turn. This is
    // the scriptable equivalent of the issue's first TUI message.
    const turn = await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        "openclaw agent --agent main --json --thinking off --session-id e2e-6002 " +
          "-m 'Reply with a short acknowledgement.'",
      ),
      {
        artifactName: "onboard-first-agent-turn",
        env: commandEnv(),
        redactionValues: [apiKey],
        timeoutMs: FIRST_TURN_TIMEOUT_MS,
      },
    );
    const totalMs = Date.now() - startedAt;
    const totalSecs = Math.ceil(totalMs / 1000);
    const turnText = resultText(turn);
    // Parse the `--json` payload and measure the assistant reply text — a raw
    // non-empty output could just be a JSON envelope / log noise, so it would
    // not prove the agent actually returned content (CodeRabbit).
    const assistantReply = extractOpenClawAgentText(turnText);
    const responseChars = assistantReply.trim().length;

    await artifacts.writeJson("onboard-progress-budget.json", {
      sandbox: SANDBOX_NAME,
      onboardExitCode: onboard.exitCode,
      firstTurnExitCode: turn.exitCode,
      onboardSecs,
      totalMs,
      totalSecs,
      budgetSecs: BUDGET_SECS,
      heartbeatCount,
      maxSilenceSecs,
      maxSilenceBudgetSecs: MAX_SILENCE_SECS,
      usedBuildKitPrebuild,
      classicBuildSteps,
      responseChars,
    });

    expect(turn.exitCode, turnText).toBe(0);
    // A real, non-empty first response came back (not just a completed onboard).
    expect(
      responseChars,
      `expected a non-empty first agent reply, got: ${turnText}`,
    ).toBeGreaterThan(0);

    // (4) Process start is earlier than [1/8], so this is a stricter upper
    // bound than the issue's [1/8]-to-first-response budget.
    expect(
      totalMs,
      `[1/8]-to-first-response took ${totalSecs}s, over the ${BUDGET_SECS}s budget`,
    ).toBeLessThanOrEqual(BUDGET_SECS * 1_000);
  },
);
