// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureSandboxFailureDiagnostics } from "../fixtures/sandbox-failure-diagnostics.ts";
import { captureOpenClawOnboardFailure } from "../fixtures/openclaw-onboard-diagnostics.ts";
import {
  withPodmanOwnerDiagnostic,
  captureBoundedPodmanOwnerDiagnostic,
} from "../fixtures/podman-owner-diagnostic";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseOpenShellSandboxId } from "../../../src/lib/adapters/openshell/sandbox-identity.ts";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import {
  ONBOARD_REPAIR_COMMAND_TIMEOUT_MS,
  ONBOARD_REPAIR_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  assertCleanupSucceededOrAbsent,
  cleanupWhenOpenShellAvailable,
} from "../fixtures/cleanup-resources.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import {
  cleanupCorporateCaFixture,
  corporateCaMergeProbeScript,
  createCorporateCaFixture,
  registeredCorporateCaWorkloadKind,
} from "../fixtures/corporate-ca.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { readExtraProviders, updateExtraProviders } from "../fixtures/extra-providers-registry.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  expectSandboxProviderAttachment,
  createExtraGatewayProvider,
} from "../fixtures/gateway-providers.ts";
import { prepareOnboardSandboxes } from "../fixtures/onboard-precleanup.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-repair";
const OTHER_SANDBOX_NAME = process.env.NEMOCLAW_OTHER_SANDBOX_NAME ?? "e2e-repair-other";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const BACKUP_REJECTION_FILE = "/sandbox/.openclaw/workspace/.nemoclaw-backup-rejection";
const RESTORED_WORKSPACE_MARKER_FILE =
  "/sandbox/.openclaw/workspace/.nemoclaw-model-change-recreate-marker";
const RESTORED_WORKSPACE_MARKER = "nemoclaw-model-change-recreate-workspace";
const SYNTHETIC_BACKUP_TOKEN = `ghp_${"abcdef0123456789"}`;
const STALE_EXTRA_PROVIDER = "e2e-stale-extra-provider";
const LIVE_EXTRA_PROVIDER = "e2e-live-extra-provider";
const EXTRA_PROVIDER_TOKEN_ENV = "NEMOCLAW_E2E_EXTRA_PROVIDER_TOKEN";
const EXTRA_PROVIDER_TOKEN = "e2e-extra-provider-token";
const LIVE_TIMEOUT_MS = testTimeout(ONBOARD_REPAIR_TEST_TIMEOUT_MS);

validateSandboxName(SANDBOX_NAME);
validateSandboxName(OTHER_SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function nemoclaw(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = ONBOARD_REPAIR_COMMAND_TIMEOUT_MS,
): Promise<ShellProbeResult> {
  return await host.command(process.execPath, [CLI_ENTRYPOINT, ...args], {
    artifactName,
    env: env(extraEnv),
    timeoutMs,
  });
}

function onboardEnv(sandboxName: string, fakeBaseUrl: string, extra: NodeJS.ProcessEnv = {}) {
  return env({
    COMPATIBLE_API_KEY: "dummy",
    NEMOCLAW_ENDPOINT_URL: fakeBaseUrl,
    NEMOCLAW_MODEL: "test-model",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    ...extra,
  });
}

async function waitSandboxAbsent(sandbox: SandboxClient, name: string): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const result = await sandbox.openshell(["sandbox", "get", name], {
      artifactName: `wait-${name}-absent-${attempt}`,
      env: env(),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0 && /NotFound|not found/i.test(resultText(result))) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${name} still exists after forced deletion`);
}

test(
  "onboard repair resumes missing sandbox and rejects conflicting resume inputs",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the selected runtime and start the compatible endpoint",
        "clear prior onboard-repair state",
        "interrupt onboarding after sandbox creation",
        "remove the recorded sandbox and resume repair",
        "validate repaired attachments and corporate trust",
        "reject a same-name model-change backup without changing the published route",
        "recreate the same name with a changed model after backup succeeds",
        "reseed interrupted onboarding state",
        "reject conflicting resume inputs",
        "clear the repaired onboarding state",
      ],
    },
  },
  async ({ artifacts, cleanup: cleanupRegistry, host, progress, runtimeProvider, sandbox }) => {
    const corporateCa = createCorporateCaFixture("requests", "nemoclaw-repair-corporate-ca-");
    cleanupRegistry.trackDisposable("remove corporate CA fixture", () =>
      cleanupCorporateCaFixture(corporateCa),
    );
    await artifacts.target.declare({
      id: "onboard-repair",
      sandboxName: SANDBOX_NAME,
      otherSandboxName: OTHER_SANDBOX_NAME,
      corporateCaSource: corporateCa.sourceLabel,
      contracts: [
        "forced policy-step failure leaves a resumable session",
        "resume recreates a recorded sandbox that was removed underneath it",
        "resume repair filters stale extra-provider records while preserving live attachments",
        "resume repair proves recreated sandbox provider attachments are selectively reconciled",
        "REQUESTS_CA_BUNDLE fallback corporate CA source is baked and merged after repair",
        "a rejected pre-delete backup preserves the live sandbox and published route",
        "a successful model-change recreate preserves workspace data and serves the selected route",
        "resume rejects a different requested sandbox name",
        "resume rejects provider/model overrides that conflict with recorded state",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "phase-0-runtime-info",
      scenarioLabel: "onboard repair",
    });

    const fake = await startFakeOpenAiCompatibleServer({
      host: "0.0.0.0",
      progress,
      publicHost: "host.openshell.internal",
    });
    cleanupRegistry.trackDisposable("close fake OpenAI-compatible endpoint", async () =>
      fake.close(),
    );
    cleanupRegistry.trackDisposable("remove onboard-repair local state", () => {
      updateExtraProviders((providers) => {
        providers.delete(STALE_EXTRA_PROVIDER);
        providers.delete(LIVE_EXTRA_PROVIDER);
      });
      fs.rmSync(SESSION_FILE, { force: true });
    });
    const cleanupWhenInstalled = (artifactName: string, run: () => Promise<void>): Promise<void> =>
      cleanupWhenOpenShellAvailable(
        host,
        {
          artifactName,
          env: env(),
          redactionValues: [EXTRA_PROVIDER_TOKEN],
          timeoutMs: 30_000,
        },
        run,
      );
    const gatewayCleanupOptions = {
      artifactName: "cleanup-gateway-destroy",
      env: env(),
      redactionValues: [EXTRA_PROVIDER_TOKEN],
      timeoutMs: 60_000,
    };
    cleanupRegistry.trackGateway(
      {
        cleanupGatewayRegistration: (name: string) =>
          cleanupWhenInstalled("cleanup-probe-openshell-gateway", () =>
            host.cleanupGatewayRegistration(name, gatewayCleanupOptions),
          ),
      },
      "nemoclaw",
      gatewayCleanupOptions,
    );
    cleanupRegistry.trackDisposable(`remove provider ${LIVE_EXTRA_PROVIDER}`, () =>
      cleanupWhenInstalled("cleanup-probe-openshell-provider", async () => {
        const remove = await sandbox.openshell(
          ["provider", "delete", "-g", "nemoclaw", LIVE_EXTRA_PROVIDER],
          {
            artifactName: "cleanup-live-extra-provider-delete",
            env: env({ [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN }),
            redactionValues: [EXTRA_PROVIDER_TOKEN],
            timeoutMs: 60_000,
          },
        );
        assertCleanupSucceededOrAbsent(
          remove,
          /\bNotFound\b|provider[^\n]*(?:not found|does not exist)|no such provider/i,
          `cleanup provider ${LIVE_EXTRA_PROVIDER}`,
        );
      }),
    );
    const forwardCleanupOptions = {
      artifactName: "cleanup-forward-stop-18789",
      env: env(),
      redactionValues: [EXTRA_PROVIDER_TOKEN],
      timeoutMs: 30_000,
    };
    cleanupRegistry.trackForward(
      {
        cleanupForward: (port: number) =>
          cleanupWhenInstalled("cleanup-probe-openshell-forward", () =>
            host.cleanupForward(port, forwardCleanupOptions),
          ),
      },
      18789,
      forwardCleanupOptions,
    );
    progress.phase("clear prior onboard-repair state");
    await prepareOnboardSandboxes(
      host,
      sandbox,
      cleanupRegistry,
      [SANDBOX_NAME, OTHER_SANDBOX_NAME],
      LIVE_EXTRA_PROVIDER,
      {
        env: env({ [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN }),
        redactionValues: [EXTRA_PROVIDER_TOKEN],
        timeoutMs: 60_000,
        artifactName: "precleanup-gateway-inspection",
      },
    );
    updateExtraProviders((providers) => {
      providers.delete(STALE_EXTRA_PROVIDER);
      providers.delete(LIVE_EXTRA_PROVIDER);
    });
    fs.rmSync(SESSION_FILE, { force: true });

    progress.phase("interrupt onboarding after sandbox creation");
    const first = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-1-forced-failure",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_RECREATE_SANDBOX: "1",
        ...corporateCa.env,
      }),
      execTimeout(ONBOARD_REPAIR_COMMAND_TIMEOUT_MS),
    );
    expect(first.exitCode, resultText(first)).toBe(1);
    expect(resultText(first)).toContain("[e2e] Forced onboarding failure at step 'policies'.");

    await createExtraGatewayProvider(host, LIVE_EXTRA_PROVIDER, {
      artifactName: "phase-1-live-extra-provider-create",
      env: env({ [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN }),
    });
    const seededExtraProviders = updateExtraProviders((providers) => {
      providers.add(STALE_EXTRA_PROVIDER);
      providers.add(LIVE_EXTRA_PROVIDER);
    });
    await artifacts.writeJson("phase-1-extra-providers-seeded.json", seededExtraProviders);

    await sandbox.waitForInitialOpenClawPairing(SANDBOX_NAME, {
      artifactName: "phase-1-wait-for-initial-pairing",
      env: env(),
    });

    progress.phase("remove the recorded sandbox and resume repair");
    await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "phase-2-delete-recorded-sandbox",
      env: env(),
      timeoutMs: 60_000,
    });
    await waitSandboxAbsent(sandbox, SANDBOX_NAME);

    const repairEnv = onboardEnv(SANDBOX_NAME, fake.baseUrl, {
      NEMOCLAW_POLICY_MODE: "skip",
      ...corporateCa.env,
    });
    const repair = await withPodmanOwnerDiagnostic(
      repairEnv,
      (phase, report) => artifacts.writeJson(`owner-resume-${phase}.json`, report),
      () =>
        nemoclaw(
          host,
          ["onboard", "--resume", "--non-interactive"],
          "phase-2-resume-repair",
          repairEnv,
          execTimeout(ONBOARD_REPAIR_COMMAND_TIMEOUT_MS),
        ),
      (environment, phase) => captureBoundedPodmanOwnerDiagnostic(host, environment, phase),
    );
    await captureOpenClawOnboardFailure(repair, sandbox, {
      sandboxName: SANDBOX_NAME,
      artifactPrefix: "phase-2-resume-repair",
      env: repairEnv,
      redactionValues: [EXTRA_PROVIDER_TOKEN, "dummy"],
      runtime: runtimeProvider,
      host,
    });
    expect(repair.exitCode, resultText(repair)).toBe(0);
    const reconciledExtraProviders = readExtraProviders();
    expect(reconciledExtraProviders).toContain(LIVE_EXTRA_PROVIDER);
    expect(reconciledExtraProviders).not.toContain(STALE_EXTRA_PROVIDER);
    await expectSandboxProviderAttachment(sandbox, SANDBOX_NAME, LIVE_EXTRA_PROVIDER, "present", {
      artifactName: "phase-2-sandbox-provider-list-live-after-repair",
      env: env(),
    });
    await expectSandboxProviderAttachment(sandbox, SANDBOX_NAME, STALE_EXTRA_PROVIDER, "absent", {
      artifactName: "phase-2-sandbox-provider-list-stale-after-repair",
      env: env(),
    });

    progress.phase("validate repaired attachments and corporate trust");
    const corporateCaProbe = await sandbox.execShell(
      SANDBOX_NAME,
      corporateCaMergeProbeScript(registeredCorporateCaWorkloadKind(SANDBOX_NAME)),
      {
        artifactName: "phase-2-corporate-ca-merge-probe",
        env: env(),
        timeoutMs: 60_000,
      },
    );
    expect(corporateCaProbe.exitCode, resultText(corporateCaProbe)).toBe(0);

    progress.phase("reject a same-name model-change backup without changing the published route");
    fs.rmSync(SESSION_FILE, { force: true });
    const registryBeforeBackup = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
      sandboxes?: Record<string, unknown>;
    };
    const publishedRoute = registryBeforeBackup.sandboxes?.[SANDBOX_NAME];
    expect(publishedRoute).toBeDefined();
    const sourceBeforeBackup = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-3-source-before-rejected-backup",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(sourceBeforeBackup.exitCode, resultText(sourceBeforeBackup)).toBe(0);
    const sourceId = parseOpenShellSandboxId(resultText(sourceBeforeBackup));
    expect(sourceId, resultText(sourceBeforeBackup)).not.toBeNull();
    await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `set -eu\nprintf '%s' '${SYNTHETIC_BACKUP_TOKEN}' > '${BACKUP_REJECTION_FILE}'`,
      ),
      {
        artifactName: "phase-3-write-backup-rejection",
        env: env(),
        redactionValues: [SYNTHETIC_BACKUP_TOKEN],
        timeoutMs: 60_000,
      },
    );
    cleanupRegistry.trackDisposable("remove synthetic backup rejection fixture", async () => {
      await sandbox.execShell(
        SANDBOX_NAME,
        trustedSandboxShellScript(`rm -f '${BACKUP_REJECTION_FILE}'`),
        {
          artifactName: "cleanup-backup-rejection-fixture",
          env: env(),
          timeoutMs: 60_000,
        },
      );
    });
    const rejectedBackup = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-3-rejected-backup",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_MODEL: "changed-test-model",
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_RECREATE_SANDBOX: "1",
        ...corporateCa.env,
      }),
      execTimeout(ONBOARD_REPAIR_COMMAND_TIMEOUT_MS),
    );
    expect(rejectedBackup.exitCode, resultText(rejectedBackup)).toBe(1);
    expect(resultText(rejectedBackup)).toMatch(/State backup (?:failed|threw)|Partial backup/);
    const registryAfterBackup = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
      sandboxes?: Record<string, unknown>;
    };
    expect(registryAfterBackup.sandboxes?.[SANDBOX_NAME]).toEqual(publishedRoute);
    const sourceAfterBackup = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-3-source-after-rejected-backup",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(sourceAfterBackup.exitCode, resultText(sourceAfterBackup)).toBe(0);
    expect(parseOpenShellSandboxId(resultText(sourceAfterBackup))).toBe(sourceId);
    const requestOffset = fake.requests().length;
    const sourceChat = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-fsS",
        "--max-time",
        "60",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 50,
        }),
      ],
      {
        artifactName: "phase-3-source-inference-after-rejected-backup",
        env: env(),
        timeoutMs: 90_000,
      },
    );
    expect(sourceChat.exitCode, resultText(sourceChat)).toBe(0);
    expect(
      fake
        .requests()
        .slice(requestOffset)
        .find((request) => request.method === "POST" && request.path === "/v1/chat/completions"),
    ).toEqual(expect.objectContaining({ model: "test-model", auth: "ok" }));
    await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(`rm -f '${BACKUP_REJECTION_FILE}'`),
      { artifactName: "phase-3-remove-backup-rejection", env: env(), timeoutMs: 60_000 },
    );
    fs.rmSync(SESSION_FILE, { force: true });

    progress.phase("recreate the same name with a changed model after backup succeeds");
    await sandbox.execShell(
      SANDBOX_NAME,
      trustedSandboxShellScript(
        `set -eu\nprintf '%s' '${RESTORED_WORKSPACE_MARKER}' > '${RESTORED_WORKSPACE_MARKER_FILE}'\nsync`,
      ),
      { artifactName: "phase-3-write-workspace-marker", env: env(), timeoutMs: 60_000 },
    );
    // Let the changed selection trigger recreation so restored native routing is reconciled.
    const recreated = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-3-successful-recreate",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_MODEL: "changed-test-model",
        NEMOCLAW_POLICY_MODE: "skip",
        ...corporateCa.env,
      }),
      execTimeout(ONBOARD_REPAIR_COMMAND_TIMEOUT_MS),
    );
    expect(recreated.exitCode, resultText(recreated)).toBe(0);
    const replacement = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
      artifactName: "phase-3-replacement-after-successful-recreate",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(replacement.exitCode, resultText(replacement)).toBe(0);
    const replacementId = parseOpenShellSandboxId(resultText(replacement));
    expect(replacementId, resultText(replacement)).not.toBeNull();
    expect(replacementId).not.toBe(sourceId);
    const restoredMarker = await sandbox.exec(
      SANDBOX_NAME,
      ["cat", RESTORED_WORKSPACE_MARKER_FILE],
      {
        artifactName: "phase-3-read-restored-workspace-marker",
        env: env(),
        timeoutMs: 60_000,
      },
    );
    expect(restoredMarker.exitCode, resultText(restoredMarker)).toBe(0);
    expect(restoredMarker.stdout.trim(), resultText(restoredMarker)).toBe(
      RESTORED_WORKSPACE_MARKER,
    );
    const replacementRequestOffset = fake.requests().length;
    const replacementChat = await sandbox.exec(
      SANDBOX_NAME,
      [
        "curl",
        "-fsS",
        "--max-time",
        "60",
        "https://inference.local/v1/chat/completions",
        "-H",
        "Content-Type: application/json",
        "--data-raw",
        JSON.stringify({
          model: "changed-test-model",
          messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
          max_tokens: 50,
        }),
      ],
      {
        artifactName: "phase-3-replacement-inference-after-successful-recreate",
        env: env(),
        timeoutMs: 90_000,
      },
    );
    expect(replacementChat.exitCode, resultText(replacementChat)).toBe(0);
    expect(
      fake
        .requests()
        .slice(replacementRequestOffset)
        .some(
          (request) =>
            request.method === "POST" &&
            request.path === "/v1/chat/completions" &&
            request.model === "changed-test-model" &&
            request.auth === "ok",
        ),
    ).toBe(true);
    fs.rmSync(SESSION_FILE, { force: true });

    progress.phase("reseed interrupted onboarding state");
    // Let the model change reconcile restored routing before the policy failure injection.
    const reinject = await nemoclaw(
      host,
      ["onboard", "--non-interactive"],
      "phase-3-reinject-failure",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
        NEMOCLAW_POLICY_MODE: "suggested",
        ...corporateCa.env,
      }),
      execTimeout(ONBOARD_REPAIR_COMMAND_TIMEOUT_MS),
    );
    await captureSandboxFailureDiagnostics(host, reinject, {
      sandboxName: SANDBOX_NAME,
      artifactPrefix: "phase-3-reinject-failure",
      redactionValues: [EXTRA_PROVIDER_TOKEN, "dummy"],
      captureGatewayLog: true,
    });
    expect(reinject.exitCode, resultText(reinject)).toBe(1);
    expect(resultText(reinject)).toContain("[e2e] Forced onboarding failure at step 'policies'.");
    progress.phase("reject conflicting resume inputs");
    const sandboxConflict = await nemoclaw(
      host,
      ["onboard", "--resume", "--non-interactive"],
      "phase-4-conflicting-sandbox",
      onboardEnv(OTHER_SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_POLICY_MODE: "skip",
      }),
    );
    expect(sandboxConflict.exitCode, resultText(sandboxConflict)).toBe(1);
    expect(resultText(sandboxConflict)).toContain(
      `Resumable state belongs to sandbox '${SANDBOX_NAME}', not '${OTHER_SANDBOX_NAME}'`,
    );

    const providerConflict = await nemoclaw(
      host,
      ["onboard", "--resume", "--non-interactive"],
      "phase-5-conflicting-provider-model",
      onboardEnv(SANDBOX_NAME, fake.baseUrl, {
        NEMOCLAW_MODEL: "gpt-5.4",
        NEMOCLAW_POLICY_MODE: "skip",
        NEMOCLAW_PROVIDER: "openai",
      }),
    );
    expect(providerConflict.exitCode, resultText(providerConflict)).toBe(1);
    expect(resultText(providerConflict)).toMatch(
      /Resumable state recorded provider '.*', not '.*'\./,
    );

    progress.phase("clear the repaired onboarding state");
    await artifacts.target.complete({ id: "onboard-repair", status: "passed" });
  },
);
