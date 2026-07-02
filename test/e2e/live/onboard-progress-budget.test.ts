// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//
// Live acceptance test for issue #6002. It measures the issue's actual
// acceptance path — onboard step [1/8] through the FIRST agent response — and
// asserts a real worktree-CLI onboard:
//   1. never leaves a phase silent longer than the heartbeat interval (a
//      heartbeat line is emitted during the long sandbox build), and
//   2. builds the sandbox image with BuildKit (the prebuild speed path), and
//   3. prints the end-of-onboard "Phase timings" summary, and
//   4. reaches the first agent response (a headless `openclaw agent` turn that
//      returns a real hosted-inference reply), and
//   5. does all of that within the ≤3-minute budget (NEMOCLAW_E2E_ONBOARD_BUDGET_SECS).
//
// Uses real hosted inference (NVIDIA_INFERENCE_API_KEY) because a genuine first
// response requires a real LLM turn — a stub endpoint completes onboarding's
// inference smoke but cannot drive a full agent turn. Opt-in via
// NEMOCLAW_RUN_LIVE_E2E=1; requires the hosted-inference key.

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const HOSTED_INFERENCE_SECRET = "NVIDIA_INFERENCE_API_KEY";
const SANDBOX_NAME = process.env.NEMOCLAW_E2E_PROGRESS_SANDBOX ?? "e2e-progress-budget";
const ONBOARD_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const FIRST_TURN_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_FIRST_TURN_TIMEOUT_MS ?? 240) * 1_000;
const HEARTBEAT_MS = Number(process.env.NEMOCLAW_E2E_ONBOARD_HEARTBEAT_MS ?? 3_000);
// Budget for the whole [1/8]-to-first-response path. Defaults to the issue's
// ≤3-minute goal (180s); constrained / cold-cache runners can raise
// NEMOCLAW_E2E_ONBOARD_BUDGET_SECS.
const BUDGET_SECS = Number(process.env.NEMOCLAW_E2E_ONBOARD_BUDGET_SECS ?? 180);
const TEST_TIMEOUT_MS = 45 * 60_000;
// Gated at declaration (no in-body `if`): live E2E opt-in AND the built CLI is
// present (repo CLI targets need `npm run build:cli`).
const liveTest = shouldRunLiveE2E() && fs.existsSync(CLI_DIST_ENTRYPOINT) ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
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
    // Force the observability + BuildKit-prebuild paths on regardless of TTY.
    NEMOCLAW_ONBOARD_PROGRESS: "1",
    NEMOCLAW_SANDBOX_PREBUILD: "1",
    NEMOCLAW_ONBOARD_HEARTBEAT_MS: String(HEARTBEAT_MS),
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
  "onboard-to-first-response: heartbeats + BuildKit + timings within the ≤3-min budget (#6002)",
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

    const startedAt = Date.now();
    const onboard: ShellProbeResult = await host.command(
      process.execPath,
      [CLI_ENTRYPOINT, "onboard", "--non-interactive", "--no-gpu"],
      {
        artifactName: "onboard-progress-budget",
        env: onboardEnv(apiKey),
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const onboardSecs = Math.round((Date.now() - startedAt) / 1000);

    // Strip ANSI so text assertions are colour-independent (ESC built from a
    // char code so there is no control literal in source).
    const ansiSgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const plain = resultText(onboard).replace(ansiSgr, "");
    const heartbeatCount = (plain.match(/Still working on /g) ?? []).length;
    const usedBuildKitPrebuild = /Building sandbox image with BuildKit/.test(plain);
    const printedTimings = /Phase timings/.test(plain);
    const classicBuildSteps = (plain.match(/Step \d+\/\d+ :/g) ?? []).length;

    expect(onboard.exitCode, plain).toBe(0);
    // (2) BuildKit prebuild ran (the speed fix), not the classic in-gateway builder.
    expect(usedBuildKitPrebuild, "expected the BuildKit prebuild to run").toBe(true);
    expect(classicBuildSteps, "expected no classic per-instruction build steps").toBe(0);
    // (1) No silent phase: a heartbeat was emitted during the long build.
    expect(heartbeatCount, "expected at least one progress heartbeat").toBeGreaterThan(0);
    // (3) The end-of-onboard timing summary was printed.
    expect(printedTimings, "expected the 'Phase timings' summary").toBe(true);

    // (4) First agent response: a real headless `openclaw agent` turn.
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
    const totalSecs = Math.round((Date.now() - startedAt) / 1000);
    const turnText = resultText(turn);
    const responseChars = turnText.replace(/\s+/g, "").length;

    await artifacts.writeJson("onboard-progress-budget.json", {
      sandbox: SANDBOX_NAME,
      onboardExitCode: onboard.exitCode,
      firstTurnExitCode: turn.exitCode,
      onboardSecs,
      totalSecs,
      budgetSecs: BUDGET_SECS,
      heartbeatCount,
      usedBuildKitPrebuild,
      printedTimings,
      classicBuildSteps,
      responseChars,
    });

    expect(turn.exitCode, turnText).toBe(0);
    // A real, non-empty first response came back (not just a completed onboard).
    expect(responseChars, "expected a non-empty first agent response").toBeGreaterThan(0);

    // (5) Whole [1/8]-to-first-response path within the ≤3-minute budget.
    expect(
      totalSecs,
      `[1/8]-to-first-response took ${totalSecs}s, over the ${BUDGET_SECS}s budget`,
    ).toBeLessThanOrEqual(BUDGET_SECS);
  },
);
