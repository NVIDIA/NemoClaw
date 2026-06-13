// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Adds focused Vitest live coverage for test/e2e/test-onboard-resume.sh's
// disruption-recovery contract — regression for #446.
//
// Shape: drive the real `nemoclaw onboard` CLI through the deterministic E2E
// failure-injection hook (NEMOCLAW_E2E_FAILURE_INJECTION +
// NEMOCLAW_E2E_FORCE_FAIL_AT_STEP), then invoke
// `nemoclaw onboard --resume --non-interactive` with NVIDIA_INFERENCE_API_KEY stripped
// from the environment to prove the credential is hydrated from the onboard
// session file.
//
// This stays as a simple live Vitest test: assertions are inline, no registry,
// no migration ledger, no new shared helper, and no workflow replacement. The
// legacy bash workflow (`onboard-resume-e2e` in nightly-e2e.yaml) remains until
// a later retirement PR deletes/replaces that lane explicitly.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-resume";
validateSandboxName(SANDBOX_NAME);

// 15 minutes per onboard run; matches NEMOCLAW_E2E_DEFAULT_TIMEOUT in the
// legacy bash test (`export NEMOCLAW_E2E_DEFAULT_TIMEOUT=600` is per-step;
// the full onboard sequence dominates).
const ONBOARD_TIMEOUT_MS = 15 * 60_000;

interface SessionStateInterrupted {
  status: "failed";
  lastCompletedStep: "openclaw";
  failure: { step: "policies" };
}

interface SessionStateComplete {
  status: "complete";
  provider: "nvidia-prod";
  steps: Record<
    | "preflight"
    | "gateway"
    | "sandbox"
    | "provider_selection"
    | "inference"
    | "openclaw"
    | "policies"
    | "agent_setup",
    { status: "complete" }
  >;
}

function readSession<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function interruptedSessionSummary(session: SessionStateInterrupted): Record<string, unknown> {
  return {
    status: session.status,
    lastCompletedStep: session.lastCompletedStep,
    failureStep: session.failure?.step,
  };
}

function completeSessionSummary(session: SessionStateComplete): Record<string, unknown> {
  return {
    status: session.status,
    provider: session.provider,
    stepStatuses: Object.fromEntries(
      Object.entries(session.steps).map(([step, value]) => [step, value.status]),
    ),
  };
}

function containsExactJsonToken(value: unknown, token: string): boolean {
  if (typeof value === "string") return value === token;
  if (Array.isArray(value)) return value.some((item) => containsExactJsonToken(item, token));
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => key === token || containsExactJsonToken(item, token),
    );
  }
  return false;
}

// Gate the test on NEMOCLAW_RUN_E2E_SCENARIOS=1 so accidental cli-test-shard
// discovery does not run it without real `openshell`, Docker, or NVIDIA_INFERENCE_API_KEY.
// Live-only tests opt in to the same gate used by the `e2e-scenarios-live`
// project include glob in vitest.config.ts.
test.skipIf(!shouldRunLiveE2EScenarios())(
  "onboard-resume: interrupted onboard then --resume completes without redoing cached steps",
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    // ──────────────────────────────────────────────────────────────────
    // Phase 1: prerequisites (host-side, all faithful on ubuntu-latest)
    // ──────────────────────────────────────────────────────────────────

    // Assertion: cli-built — `bin/nemoclaw.js` exists in the repo checkout.
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      `bin/nemoclaw.js missing — ensure the workflow runs npm ci + npm run build:cli before this test`,
    ).toBe(true);

    // Assertion: docker-running — `docker info` exits 0. Pass fixture allowlist
    // env (includes PATH, HOME, etc.) so spawn can locate `docker`.
    // The shell-probe boundary defaults to no env inheritance; fixture spawns
    // must opt in via buildAvailabilityProbeEnv() to keep secret-passthrough
    // explicit (NVIDIA_INFERENCE_API_KEY is NOT in the allowlist; we layer it explicitly
    // in Phase 2 below).
    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(dockerInfo.exitCode, dockerInfo.stderr).toBe(0);

    // Assertion: openshell-installed — openshell CLI is on PATH (installed by
    // the live validation setup before this test runs).
    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "prereq-openshell-version",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(openshellVersion.exitCode, openshellVersion.stderr).toBe(0);

    // Assertion: nvidia-api-key-present — secrets.required(...) skips the test
    // if NVIDIA_INFERENCE_API_KEY is unset (correct behavior under workflow_dispatch
    // without the secret wired in).
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_INFERENCE_API_KEY must start with nvapi-").toBe(
      true,
    );

    // ──────────────────────────────────────────────────────────────────
    // Phase 0 (deferred): pre-cleanup of leftover sandbox/session state.
    // Done after the prereq gates pass so we don't mutate host state if
    // the test would have skipped anyway.
    // ──────────────────────────────────────────────────────────────────
    const probeEnv = buildAvailabilityProbeEnv();
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "pre-cleanup-openshell-sandbox-delete",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    await sandbox.openshell(["forward", "stop", "18789"], {
      artifactName: "pre-cleanup-openshell-forward-stop",
      env: probeEnv,
      timeoutMs: 30_000,
    });
    await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "pre-cleanup-openshell-gateway-destroy",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    fs.rmSync(SESSION_FILE, { force: true });

    // Register cleanup for the sandbox we are about to create. The cleanup
    // fixture runs these in LIFO at end-of-test regardless of pass/fail.
    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      const cleanupEnv = buildAvailabilityProbeEnv();
      await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "cleanup-nemoclaw-destroy",
        env: cleanupEnv,
        timeoutMs: 120_000,
      });
      await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: cleanupEnv,
        timeoutMs: 60_000,
      });
      await sandbox.openshell(["forward", "stop", "18789"], {
        artifactName: "cleanup-openshell-forward-stop",
        env: cleanupEnv,
        timeoutMs: 30_000,
      });
      await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "cleanup-openshell-gateway-destroy",
        env: cleanupEnv,
        timeoutMs: 60_000,
      });
      fs.rmSync(SESSION_FILE, { force: true });

      const sandboxAfterCleanup = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
        artifactName: "cleanup-openshell-sandbox-get-after-delete",
        env: cleanupEnv,
        timeoutMs: 30_000,
      });
      expect(
        sandboxAfterCleanup.exitCode,
        `sandbox ${SANDBOX_NAME} still exists after cleanup`,
      ).not.toBe(0);
      expect(fs.existsSync(SESSION_FILE), `${SESSION_FILE} still exists after cleanup`).toBe(false);
    });

    // ──────────────────────────────────────────────────────────────────
    // Phase 2: first onboard (forced failure at the policies step)
    // ──────────────────────────────────────────────────────────────────
    const firstRun = await host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
      artifactName: "phase-2-onboard-interrupted",
      env: {
        ...buildAvailabilityProbeEnv(),
        NVIDIA_INFERENCE_API_KEY: apiKey,
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_RECREATE_SANDBOX: "1",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
      },
      redactionValues: [apiKey],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
    const firstText = `${firstRun.stdout}\n${firstRun.stderr}`;

    // Assertion: interrupted-exit-1.
    expect(firstRun.exitCode, firstText).toBe(1);

    // Assertion: sandbox-created-log.
    expect(firstText).toContain(`Sandbox '${SANDBOX_NAME}' created`);

    // Assertion: forced-failure-log — failure injection fired at the policies step.
    expect(firstText).toContain("[e2e] Forced onboarding failure at step 'policies'.");

    // Assertion: sandbox-exists-after-interrupt — `openshell sandbox get` exits 0.
    // Keep this check local to the test instead of adding a shared helper for a
    // single assertion.
    const sandboxAfterInterrupt = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-2-openshell-sandbox-get",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(sandboxAfterInterrupt.exitCode, sandboxAfterInterrupt.stderr).toBe(0);

    // Assertion: session-file-present.
    expect(fs.existsSync(SESSION_FILE)).toBe(true);

    // Assertion: session-file-interrupted-state.
    const interrupted = readSession<SessionStateInterrupted>(SESSION_FILE);
    await artifacts.writeJson(
      "phase-2-session-summary.json",
      interruptedSessionSummary(interrupted),
    );
    expect(interrupted.status).toBe("failed");
    expect(interrupted.lastCompletedStep).toBe("openclaw");
    expect(interrupted.failure?.step).toBe("policies");

    // ──────────────────────────────────────────────────────────────────
    // Phase 3: resume — NVIDIA_INFERENCE_API_KEY removed from env so the resume run
    // must hydrate the credential from the session file.
    // ──────────────────────────────────────────────────────────────────
    const resumeRun = await host.command(
      "node",
      [CLI_ENTRYPOINT, "onboard", "--resume", "--non-interactive"],
      {
        artifactName: "phase-3-onboard-resume",
        // buildAvailabilityProbeEnv() does NOT pass NVIDIA_INFERENCE_API_KEY through —
        // it's outside the fixture env allowlist. Resume must hydrate the
        // credential from the session file. This is exactly the bash test's
        // `env -u NVIDIA_INFERENCE_API_KEY` invariant, expressed via explicit
        // secret-passthrough.
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_POLICY_MODE: "skip",
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        },
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const resumeText = `${resumeRun.stdout}\n${resumeRun.stderr}`;

    // Assertion: resume-exit-0.
    expect(resumeRun.exitCode, resumeText).toBe(0);

    // Assertion: resume-skipped-{preflight,gateway,sandbox}-log.
    expect(resumeText).toContain("[resume] Skipping preflight (cached)");
    expect(resumeText).toContain("[resume] Skipping gateway (running)");
    expect(resumeText).toContain(`[resume] Skipping sandbox (${SANDBOX_NAME})`);

    // Assertion: resume-no-{preflight,gateway,sandbox}-rerun.
    expect(resumeText).not.toContain("[1/8] Preflight checks");
    expect(resumeText).not.toContain("[2/8] Starting OpenShell gateway");
    expect(resumeText).not.toContain("[6/8] Creating sandbox");

    // Assertion: resume-inference-handled — first onboard completed through
    // openclaw before failing at policies. Inference was already configured
    // during that run, so the resume path either re-runs it or detects
    // readiness and skips. Both are valid.
    const ranInference = resumeText.includes("[4/8] Setting up inference provider");
    const skippedInference =
      resumeText.includes("[resume] Skipping inference") ||
      resumeText.includes("[reuse] Skipping inference");
    expect(ranInference || skippedInference, resumeText).toBe(true);

    // Assertion: sandbox-manageable-after-resume.
    const sandboxStatus = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(sandboxStatus.exitCode, sandboxStatus.stderr).toBe(0);

    // Assertion: session-file-complete-state.
    const complete = readSession<SessionStateComplete>(SESSION_FILE);
    await artifacts.writeJson("phase-3-session-summary.json", completeSessionSummary(complete));
    expect(complete.status).toBe("complete");
    expect(complete.provider).toBe("nvidia-prod");
    for (const step of [
      "preflight",
      "gateway",
      "sandbox",
      "provider_selection",
      "inference",
      "openclaw",
      "policies",
      "agent_setup",
    ] as const) {
      expect(complete.steps[step]?.status, `step ${step}`).toBe("complete");
    }

    // Assertion: registry-has-sandbox.
    expect(fs.existsSync(REGISTRY_FILE)).toBe(true);
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as unknown;
    expect(containsExactJsonToken(registry, SANDBOX_NAME)).toBe(true);
  },
);
