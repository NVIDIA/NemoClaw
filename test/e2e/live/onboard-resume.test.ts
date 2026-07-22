// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { trustedSandboxShellScript, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import {
  cleanupCorporateCaFixture,
  corporateCaMergeProbeScript,
  createCorporateCaFixture,
} from "../fixtures/corporate-ca.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  REGISTRY_FILE,
  readExtraProviders,
  updateExtraProviders,
} from "../fixtures/extra-providers-registry.ts";
import {
  type FakeOpenAiCompatibleServer,
  startFakeOpenAiCompatibleServer,
} from "../fixtures/fake-openai-compatible.ts";
import {
  expectSandboxProviderAttachment,
  upsertGenericGatewayProvider,
} from "../fixtures/gateway-providers.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";

// Disruption-recovery contract — regression for #446.
//
// Shape: start a local fake OpenAI-compatible endpoint, drive the real
// `nemoclaw onboard` CLI through the deterministic E2E failure-injection hook
// (NEMOCLAW_E2E_FAILURE_INJECTION + NEMOCLAW_E2E_FORCE_FAIL_AT_STEP), then
// invoke `nemoclaw onboard --resume --non-interactive` with both
// NVIDIA_INFERENCE_API_KEY and COMPATIBLE_API_KEY absent from the environment to
// prove the credential is hydrated from gateway/session state rather than hosted
// repository secrets.
//
// This stays as a simple live Vitest test: assertions are inline, with no
// registry, migration ledger, or new shared helper.

const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-resume";
const FAKE_COMPATIBLE_AUTH_VALUE = "e2e-compatible-auth-value";
const FAKE_COMPATIBLE_MODEL = "test-model";
const STALE_EXTRA_PROVIDER = "e2e-resume-stale-extra-provider";
const LIVE_EXTRA_PROVIDER = "e2e-resume-live-extra-provider";
const EXTRA_PROVIDER_TOKEN_ENV = "NEMOCLAW_E2E_EXTRA_PROVIDER_TOKEN";
const EXTRA_PROVIDER_TOKEN = "e2e-resume-extra-provider-token";
validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

// 15 minutes per onboard run; matches NEMOCLAW_E2E_DEFAULT_TIMEOUT in the
// former shell test (`export NEMOCLAW_E2E_DEFAULT_TIMEOUT=600` is per-step;
// the full onboard sequence dominates).
const ONBOARD_TIMEOUT_MS = 15 * 60_000;

interface SessionStateInterrupted {
  status: "failed";
  lastCompletedStep: "openclaw";
  failure: { step: "policies" };
}

interface SessionStateComplete {
  status: "complete";
  provider: string;
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

interface SessionStatePostVerify {
  status: "in_progress";
  resumable: true;
  machine: { state: "post_verify" };
}

interface MutableSessionState extends Record<string, unknown> {
  status?: string;
  resumable?: boolean;
}

function readSession<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function markSessionInProgress(file: string): void {
  const session = readSession<MutableSessionState>(file);
  session.status = "in_progress";
  session.resumable = true;
  fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf8");
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

function expectHermeticCompatibleEndpointUsed(
  fake: FakeOpenAiCompatibleServer,
  requestOffset: number,
): void {
  const requests = fake.requests().slice(requestOffset);
  expect(
    requests.some(
      (entry) =>
        entry.method === "POST" &&
        entry.path === "/v1/chat/completions" &&
        entry.authorizationSent === true &&
        entry.auth === "ok",
    ),
    `expected authenticated fake endpoint inference, got ${JSON.stringify(requests)}`,
  ).toBe(true);
}

// The e2e-live Vitest project owns the NEMOCLAW_RUN_LIVE_E2E collection gate,
// so accidental cli-test-shard discovery cannot run this without real
// `openshell`, Docker, or a sandbox-reachable fake OpenAI-compatible endpoint.
test("onboard-resume: interrupted onboard then --resume can recreate with cached setup", {
  meta: {
    e2ePhases: [
      "confirm runtime and compatible-endpoint prerequisites",
      "clear prior resumable onboarding state",
      "interrupt onboard after OpenClaw configuration",
      "resume cached setup with sandbox recreation",
      "validate resumed sandbox state and corporate trust",
      "retry final verification after route repair",
      "compare implicit resume with fresh onboard",
      "record the completed resume contract",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox }) => {
  const corporateCa = createCorporateCaFixture("host-anchor", "nemoclaw-resume-corporate-ca-");
  cleanup.trackDisposable("remove corporate CA fixture", () =>
    cleanupCorporateCaFixture(corporateCa),
  );
  await artifacts.writeJson("corporate-ca-source.json", {
    mode: corporateCa.mode,
    source: corporateCa.sourceLabel,
  });
  await artifacts.target.declare({
    id: "onboard-resume",
    sandboxName: SANDBOX_NAME,
    corporateCaSource: corporateCa.sourceLabel,
    contracts: [
      "forced policy-step failure leaves a resumable session",
      "resume recreates the sandbox on request without redoing cached preflight/gateway steps",
      "resume sandbox recreation filters stale extra providers while preserving live attachments",
      "resume proves recreated sandbox provider attachments are selectively reconciled",
      "host trust-store anchor corporate CA source is baked and merged after resume",
      "an unreachable committed route pauses at final verification and completes after repair",
      "implicit resume is detected and --fresh suppresses that auto-resume",
    ],
  });

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

  // Assertion: hermetic-compatible-endpoint-ready — the workflow does not
  // pass hosted NVIDIA inference secrets. Instead, this test exposes a local
  // fake OpenAI-compatible endpoint at a host address the OpenShell gateway and
  // sandbox can route to, matching test/e2e/lib/hermetic-compatible-inference.sh.
  const fakePublicHost = "host.openshell.internal";
  let fake = await startFakeOpenAiCompatibleServer({
    apiKey: FAKE_COMPATIBLE_AUTH_VALUE,
    host: "0.0.0.0",
    model: FAKE_COMPATIBLE_MODEL,
    publicHost: fakePublicHost,
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.trackDisposable("close fake OpenAI-compatible endpoint", async () => {
    await artifacts.writeJson("fake-openai-compatible-requests.json", fake.requests());
    await fake.close();
  });
  await artifacts.writeJson("fake-openai-compatible.json", {
    baseUrl: fake.baseUrl,
    model: FAKE_COMPATIBLE_MODEL,
    publicHost: fakePublicHost,
  });
  const localModelsUrl = new URL(`${fake.baseUrl}/models`);
  const fakePort = Number(localModelsUrl.port);
  localModelsUrl.hostname = "127.0.0.1";
  const modelsResponse = await fetch(localModelsUrl, {
    headers: { Authorization: `Bearer ${FAKE_COMPATIBLE_AUTH_VALUE}` },
  });
  expect(modelsResponse.ok, `fake endpoint ${fake.baseUrl}/models should be reachable`).toBe(true);
  const onboardingRequestOffset = fake.requests().length;

  // ──────────────────────────────────────────────────────────────────
  // Phase 0 (deferred): pre-cleanup of leftover sandbox/session state.
  // Done after the prereq gates pass so we don't mutate host state if
  // the test would have skipped anyway.
  // ──────────────────────────────────────────────────────────────────
  progress.phase("clear prior resumable onboarding state");
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
  await sandbox.openshell(["provider", "delete", "-g", "nemoclaw", LIVE_EXTRA_PROVIDER], {
    artifactName: "pre-cleanup-live-extra-provider-delete",
    env: { ...probeEnv, [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN },
    timeoutMs: 60_000,
  });
  await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
    artifactName: "pre-cleanup-openshell-gateway-destroy",
    env: probeEnv,
    timeoutMs: 60_000,
  });
  fs.rmSync(SESSION_FILE, { force: true });

  // Register resources in reverse dependency order. CleanupRegistry runs them
  // LIFO, so the sandbox is destroyed before its forward, provider, gateway,
  // and local resume state are removed.
  const cleanupEnv = buildAvailabilityProbeEnv();
  const cleanupRedactions = [FAKE_COMPATIBLE_AUTH_VALUE, EXTRA_PROVIDER_TOKEN];
  cleanup.trackDisposable("verify onboard-resume cleanup", async () => {
    const sandboxAfterCleanup = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-get-after-delete",
      env: cleanupEnv,
      redactionValues: cleanupRedactions,
      timeoutMs: 30_000,
    });
    expect(
      sandboxAfterCleanup.exitCode,
      `sandbox ${SANDBOX_NAME} still exists after cleanup`,
    ).not.toBe(0);
    expect(fs.existsSync(SESSION_FILE), `${SESSION_FILE} still exists after cleanup`).toBe(false);
  });
  cleanup.trackDisposable("remove onboard-resume local state", () => {
    fs.rmSync(SESSION_FILE, { force: true });
    updateExtraProviders((providers) => {
      providers.delete(STALE_EXTRA_PROVIDER);
      providers.delete(LIVE_EXTRA_PROVIDER);
    });
  });
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway-destroy",
    env: cleanupEnv,
    redactionValues: cleanupRedactions,
    timeoutMs: 60_000,
  });
  cleanup.trackDisposable(`remove provider ${LIVE_EXTRA_PROVIDER}`, async () => {
    const remove = await sandbox.openshell(
      ["provider", "delete", "-g", "nemoclaw", LIVE_EXTRA_PROVIDER],
      {
        artifactName: "cleanup-live-extra-provider-delete",
        env: { ...cleanupEnv, [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN },
        redactionValues: cleanupRedactions,
        timeoutMs: 60_000,
      },
    );
    assertCleanupSucceededOrAbsent(
      remove,
      /\bNotFound\b|provider[^\n]*(?:not found|does not exist)|no such provider/i,
      `cleanup provider ${LIVE_EXTRA_PROVIDER}`,
    );
  });
  cleanup.trackForward(host, 18789, {
    artifactName: "cleanup-openshell-forward-stop",
    env: cleanupEnv,
    redactionValues: cleanupRedactions,
    timeoutMs: 30_000,
  });
  cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: cleanupEnv,
      redactionValues: cleanupRedactions,
      timeoutMs: 60_000,
    }),
  );
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy",
    env: cleanupEnv,
    redactionValues: cleanupRedactions,
    timeoutMs: 120_000,
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 2: first onboard (forced failure at the policies step)
  // ──────────────────────────────────────────────────────────────────
  progress.phase("interrupt onboard after OpenClaw configuration");
  const firstRunEnv: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    COMPATIBLE_API_KEY: FAKE_COMPATIBLE_AUTH_VALUE,
    NEMOCLAW_COMPAT_MODEL: FAKE_COMPATIBLE_MODEL,
    NEMOCLAW_ENDPOINT_URL: fake.baseUrl,
    NEMOCLAW_MODEL: FAKE_COMPATIBLE_MODEL,
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_POLICY_MODE: "suggested",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_E2E_FAILURE_INJECTION: "1",
    NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
    ...corporateCa.env,
  };
  expect(firstRunEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  const firstRun = await host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
    artifactName: "phase-2-onboard-interrupted",
    env: firstRunEnv,
    redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
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

  // Exercise the configured route through the sandbox. The OpenShell gateway
  // must inject the stored compatible-endpoint credential upstream; this POST
  // is the positive auth proof and is deliberately newer than fixture startup
  // and the direct readiness fetch excluded by onboardingRequestOffset.
  const inferenceAfterInterrupt = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -fsS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
        {
          model: FAKE_COMPATIBLE_MODEL,
          messages: [{ role: "user", content: "reply with OK" }],
          max_tokens: 8,
        },
      )}'`,
    ),
    {
      artifactName: "phase-2-authenticated-inference-post",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(
    inferenceAfterInterrupt.exitCode,
    `${inferenceAfterInterrupt.stdout}\n${inferenceAfterInterrupt.stderr}`,
  ).toBe(0);

  // Assertion: session-file-present.
  expect(fs.existsSync(SESSION_FILE)).toBe(true);

  // Assertion: session-file-interrupted-state.
  const interrupted = readSession<SessionStateInterrupted>(SESSION_FILE);
  await artifacts.writeJson("phase-2-session-summary.json", interruptedSessionSummary(interrupted));
  expect(interrupted.status).toBe("failed");
  expect(interrupted.lastCompletedStep).toBe("openclaw");
  expect(interrupted.failure?.step).toBe("policies");

  await artifacts.writeJson("phase-2-fake-openai-compatible-requests.json", fake.requests());
  expectHermeticCompatibleEndpointUsed(fake, onboardingRequestOffset);

  await upsertGenericGatewayProvider(host, LIVE_EXTRA_PROVIDER, {
    artifactName: "phase-2-live-extra-provider-upsert",
    credentialEnv: EXTRA_PROVIDER_TOKEN_ENV,
    env: { ...buildAvailabilityProbeEnv(), [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN },
    redactionValues: [EXTRA_PROVIDER_TOKEN],
  });
  const seededExtraProviders = updateExtraProviders((providers) => {
    providers.add(STALE_EXTRA_PROVIDER);
    providers.add(LIVE_EXTRA_PROVIDER);
  });
  await artifacts.writeJson("phase-2-extra-providers-seeded.json", seededExtraProviders);
  expect(seededExtraProviders).toEqual(
    expect.arrayContaining([LIVE_EXTRA_PROVIDER, STALE_EXTRA_PROVIDER]),
  );

  // ──────────────────────────────────────────────────────────────────
  // Phase 3: resume — NVIDIA_INFERENCE_API_KEY and COMPATIBLE_API_KEY are
  // removed from env so the resume run must hydrate the credential from the
  // gateway/session state, then recreate the sandbox with stale extra-provider
  // attachments filtered out for this create attempt.
  // ──────────────────────────────────────────────────────────────────
  progress.phase("resume cached setup with sandbox recreation");
  const resumeEnv: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    ...corporateCa.env,
  };
  expect(resumeEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  expect(resumeEnv.COMPATIBLE_API_KEY).toBeUndefined();
  const resumeRun = await host.command(
    "node",
    [CLI_ENTRYPOINT, "onboard", "--resume", "--recreate-sandbox", "--non-interactive"],
    {
      artifactName: "phase-3-onboard-resume",
      env: resumeEnv,
      redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const resumeText = `${resumeRun.stdout}\n${resumeRun.stderr}`;

  // Assertion: resume-exit-0.
  expect(resumeRun.exitCode, resumeText).toBe(0);

  // Assertion: resume-skipped-{preflight,gateway}-log and recreates sandbox.
  expect(resumeText).toContain("[resume] Skipping preflight (cached)");
  expect(resumeText).toContain("[resume] Skipping gateway (running)");
  expect(resumeText).toContain(`Deleting and recreating sandbox '${SANDBOX_NAME}'`);
  expect(resumeText).toContain(`Sandbox '${SANDBOX_NAME}' created`);

  // Assertion: resume-no-{preflight,gateway}-redo. Current CLI output
  // still prints phase headings before the resume-skip decisions, so assert
  // the skip evidence and absence of redo-only success strings instead of
  // rejecting headings that now frame the skipped phases.
  expect(resumeText).not.toContain("Starting OpenShell Docker-driver gateway...");
  const reconciledExtraProviders = readExtraProviders();
  expect(reconciledExtraProviders).toContain(LIVE_EXTRA_PROVIDER);
  expect(reconciledExtraProviders).not.toContain(STALE_EXTRA_PROVIDER);
  await expectSandboxProviderAttachment(sandbox, SANDBOX_NAME, LIVE_EXTRA_PROVIDER, "present", {
    artifactName: "phase-3-sandbox-provider-list-live-after-resume",
    env: buildAvailabilityProbeEnv(),
  });
  await expectSandboxProviderAttachment(sandbox, SANDBOX_NAME, STALE_EXTRA_PROVIDER, "absent", {
    artifactName: "phase-3-sandbox-provider-list-stale-after-resume",
    env: buildAvailabilityProbeEnv(),
  });

  // Assertion: resume-inference-handled — first onboard completed through
  // openclaw before failing at policies. Inference was already configured
  // during that run, so the resume path either re-runs it or detects
  // readiness and skips. Both are valid.
  progress.phase("validate resumed sandbox state and corporate trust");
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

  const corporateCaProbe = await sandbox.execShell(SANDBOX_NAME, corporateCaMergeProbeScript(), {
    artifactName: "phase-3-corporate-ca-merge-probe",
    env: probeEnv,
    timeoutMs: 60_000,
  });
  expect(corporateCaProbe.exitCode, resultText(corporateCaProbe)).toBe(0);

  // Assertion: session-file-complete-state.
  const complete = readSession<SessionStateComplete>(SESSION_FILE);
  await artifacts.writeJson("phase-3-session-summary.json", completeSessionSummary(complete));
  expect(complete.status).toBe("complete");
  expect(complete.provider).toBe("compatible-endpoint");
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
    expect(["complete", "skipped"]).toContain(complete.steps[step]?.status);
  }

  // Assertion: registry-has-sandbox.
  expect(fs.existsSync(REGISTRY_FILE)).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as unknown;
  expect(containsExactJsonToken(registry, SANDBOX_NAME)).toBe(true);

  // ──────────────────────────────────────────────────────────────────
  // Phase 3.5: a committed route that goes offline leaves final
  // verification retryable; restoring the same endpoint lets a later resume
  // re-probe and complete without recreating the sandbox.
  // ──────────────────────────────────────────────────────────────────
  progress.phase("retry final verification after route repair");
  markSessionInProgress(SESSION_FILE);
  await fake.close();

  const unavailableResumeRun = await host.command(
    "node",
    [CLI_ENTRYPOINT, "onboard", "--resume", "--non-interactive"],
    {
      artifactName: "phase-3-5-onboard-resume-route-unavailable",
      env: resumeEnv,
      redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const unavailableResumeText = `${unavailableResumeRun.stdout}\n${unavailableResumeRun.stderr}`;
  expect(unavailableResumeRun.exitCode, unavailableResumeText).not.toBe(0);
  expect(unavailableResumeText).toContain("is not ready");
  expect(unavailableResumeText).toContain("inference");

  const paused = readSession<SessionStatePostVerify>(SESSION_FILE);
  await artifacts.writeJson("phase-3-5-session-route-unavailable.json", {
    status: paused.status,
    resumable: paused.resumable,
    machineState: paused.machine.state,
  });
  expect(paused.status).toBe("in_progress");
  expect(paused.resumable).toBe(true);
  expect(paused.machine.state).toBe("post_verify");

  fake = await startFakeOpenAiCompatibleServer({
    apiKey: FAKE_COMPATIBLE_AUTH_VALUE,
    host: "0.0.0.0",
    model: FAKE_COMPATIBLE_MODEL,
    port: fakePort,
    publicHost: fakePublicHost,
    requireAuth: true,
    requireAuthModels: true,
  });
  expect(fake.baseUrl).toBe(`http://${fakePublicHost}:${String(fakePort)}/v1`);

  const repairedResumeRun = await host.command(
    "node",
    [CLI_ENTRYPOINT, "onboard", "--resume", "--non-interactive"],
    {
      artifactName: "phase-3-5-onboard-resume-route-restored",
      env: resumeEnv,
      redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const repairedResumeText = `${repairedResumeRun.stdout}\n${repairedResumeRun.stderr}`;
  expect(repairedResumeRun.exitCode, repairedResumeText).toBe(0);
  expect(repairedResumeText).toContain("is ready");
  const repaired = readSession<SessionStateComplete>(SESSION_FILE);
  expect(repaired.status).toBe("complete");

  // ──────────────────────────────────────────────────────────────────
  // Phase 4: implicit resume — a plain `onboard` auto-detects an
  // in_progress session, and `--fresh` suppresses that auto-resume.
  // ──────────────────────────────────────────────────────────────────
  progress.phase("compare implicit resume with fresh onboard");
  markSessionInProgress(SESSION_FILE);
  const implicitResumeRun = await host.command(
    "node",
    [CLI_ENTRYPOINT, "onboard", "--non-interactive"],
    {
      artifactName: "phase-4-onboard-implicit-resume",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      },
      redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const implicitResumeText = `${implicitResumeRun.stdout}\n${implicitResumeRun.stderr}`;
  expect(implicitResumeRun.exitCode, implicitResumeText).toBe(0);
  expect(implicitResumeText).toContain("(resume mode)");
  expect(
    implicitResumeText.includes("[resume] Skipping") ||
      implicitResumeText.includes("[reuse] Skipping"),
    implicitResumeText,
  ).toBe(true);

  markSessionInProgress(SESSION_FILE);
  const freshRun = await host.command(
    "node",
    [CLI_ENTRYPOINT, "onboard", "--fresh", "--non-interactive"],
    {
      artifactName: "phase-4-onboard-fresh-suppresses-resume",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "preflight",
      },
      redactionValues: [FAKE_COMPATIBLE_AUTH_VALUE],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const freshText = `${freshRun.stdout}\n${freshRun.stderr}`;
  expect(freshRun.exitCode, freshText).not.toBe(0);
  expect(freshText).toContain("[e2e] Forced onboarding failure at step 'preflight'.");
  expect(freshText).not.toContain("(resume mode)");
  progress.phase("record the completed resume contract");
  await artifacts.target.complete({ id: "onboard-resume", status: "passed" });
});
