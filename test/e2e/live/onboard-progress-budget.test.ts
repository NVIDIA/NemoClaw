// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//
// Live acceptance test for issue #6002: a real worktree-CLI onboard must
//   1. never leave a phase silent longer than the heartbeat interval (a
//      heartbeat line is emitted during the long sandbox build), and
//   2. build the sandbox image with BuildKit (the prebuild path), and
//   3. print the end-of-onboard "Phase timings" summary, and
//   4. complete within a configurable wall-clock budget (records the elapsed
//      time; fails when it exceeds NEMOCLAW_E2E_ONBOARD_BUDGET_SECS).
//
// It drives the real ./bin/nemoclaw.js against a fake OpenAI-compatible endpoint
// (no hosted inference / API key required), so it exercises the full
// build+create+finalize lifecycle on the Docker driver.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_E2E_PROGRESS_SANDBOX ?? "e2e-progress-budget";
const ONBOARD_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_PHASE_TIMEOUT_MS ?? 1_200) * 1_000;
const HEARTBEAT_MS = Number(process.env.NEMOCLAW_E2E_ONBOARD_HEARTBEAT_MS ?? 3_000);
// Wall-clock budget for the whole onboard. Defaults to the issue's ≤3-minute
// acceptance goal (180s) so the test enforces it by default; constrained
// hardware / cold-cache runners can raise NEMOCLAW_E2E_ONBOARD_BUDGET_SECS.
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

function onboardEnv(fakeBaseUrl: string): NodeJS.ProcessEnv {
  return commandEnv({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
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
  "onboard emits heartbeats + a phase-timings summary and completes within budget (#6002)",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox }) => {
    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(docker.exitCode, resultText(docker)).toBe(0);

    const fake = await startFakeOpenAiCompatibleServer({
      port: Number(process.env.NEMOCLAW_FAKE_PORT ?? 0),
    });
    cleanup.add("close fake OpenAI-compatible endpoint", async () => {
      await fake.close();
    });
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
        env: onboardEnv(fake.baseUrl),
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const elapsedSecs = Math.round((Date.now() - startedAt) / 1000);
    const output = resultText(onboard);

    // Strip ANSI so the text assertions are colour-independent.
    const plain = output.replace(/\[[0-9;]*m/g, "");
    const heartbeatCount = (plain.match(/Still working on /g) ?? []).length;
    const usedBuildKitPrebuild = /Building sandbox image with BuildKit/.test(plain);
    const printedTimings = /Phase timings/.test(plain);
    const classicBuildSteps = (plain.match(/Step \d+\/\d+ :/g) ?? []).length;

    await artifacts.writeJson("onboard-progress-budget.json", {
      sandbox: SANDBOX_NAME,
      exitCode: onboard.exitCode,
      elapsedSecs,
      budgetSecs: BUDGET_SECS,
      heartbeatCount,
      usedBuildKitPrebuild,
      printedTimings,
      classicBuildSteps,
    });

    expect(onboard.exitCode, plain).toBe(0);
    // (2) BuildKit prebuild path ran (the actual speed fix), not the classic
    // in-gateway builder.
    expect(usedBuildKitPrebuild, "expected the BuildKit prebuild to run").toBe(true);
    expect(classicBuildSteps, "expected no classic per-instruction build steps").toBe(0);
    // (1) No silent phase: a heartbeat was emitted during the long build.
    expect(heartbeatCount, "expected at least one progress heartbeat").toBeGreaterThan(0);
    // (3) The end-of-onboard timing summary was printed.
    expect(printedTimings, "expected the 'Phase timings' summary").toBe(true);
    // (4) Wall-clock budget: enforced by default at the issue's ≤3-minute goal
    // (180s); constrained runners raise NEMOCLAW_E2E_ONBOARD_BUDGET_SECS.
    expect(
      elapsedSecs,
      `onboard took ${elapsedSecs}s, over the ${BUDGET_SECS}s budget`,
    ).toBeLessThanOrEqual(BUDGET_SECS);
  },
);
