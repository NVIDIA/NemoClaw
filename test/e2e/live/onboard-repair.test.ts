// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import {
  cleanupCorporateCaFixture,
  corporateCaMergeProbeScript,
  createCorporateCaFixture,
} from "../fixtures/corporate-ca.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { readExtraProviders, updateExtraProviders } from "../fixtures/extra-providers-registry.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import {
  expectSandboxProviderAttachment,
  upsertGenericGatewayProvider,
} from "../fixtures/gateway-providers.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-repair";
const OTHER_SANDBOX_NAME = process.env.NEMOCLAW_OTHER_SANDBOX_NAME ?? "e2e-repair-other";
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const STALE_EXTRA_PROVIDER = "e2e-stale-extra-provider";
const LIVE_EXTRA_PROVIDER = "e2e-live-extra-provider";
const EXTRA_PROVIDER_TOKEN_ENV = "NEMOCLAW_E2E_EXTRA_PROVIDER_TOKEN";
const EXTRA_PROVIDER_TOKEN = "e2e-extra-provider-token";
const LIVE_TIMEOUT_MS = 70 * 60_000;

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
  timeoutMs = 20 * 60_000,
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

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  for (const name of [SANDBOX_NAME, OTHER_SANDBOX_NAME]) {
    await nemoclaw(host, [name, "destroy", "--yes"], `cleanup-destroy-${name}`).catch(
      () => undefined,
    );
    await sandbox
      .openshell(["sandbox", "delete", name], {
        artifactName: `cleanup-openshell-delete-${name}`,
        env: env(),
        timeoutMs: 60_000,
      })
      .catch(() => undefined);
  }
  await sandbox
    .openshell(["forward", "stop", "18789"], {
      artifactName: "cleanup-forward-stop-18789",
      env: env(),
      timeoutMs: 30_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["provider", "delete", "-g", "nemoclaw", LIVE_EXTRA_PROVIDER], {
      artifactName: "cleanup-live-extra-provider-delete",
      env: env({ [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN }),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  updateExtraProviders((providers) => {
    providers.delete(STALE_EXTRA_PROVIDER);
    providers.delete(LIVE_EXTRA_PROVIDER);
  });
  fs.rmSync(SESSION_FILE, { force: true });
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

test("onboard repair resumes missing sandbox and rejects conflicting resume inputs", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, skip }) => {
  const corporateCa = createCorporateCaFixture("requests", "nemoclaw-repair-corporate-ca-");
  cleanupRegistry.add("remove corporate CA fixture", () => cleanupCorporateCaFixture(corporateCa));
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
      "resume rejects a different requested sandbox name",
      "resume rejects provider/model overrides that conflict with recorded state",
    ],
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: env(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
    skip(`Docker is required: ${resultText(docker)}`);
  }

  const fake = await startFakeOpenAiCompatibleServer({
    host: "0.0.0.0",
    publicHost: "host.openshell.internal",
  });
  cleanupRegistry.add("close fake OpenAI-compatible endpoint", async () => fake.close());
  cleanupRegistry.add("remove repair sandboxes", () => cleanup(host, sandbox));
  await cleanup(host, sandbox);

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
  );
  expect(first.exitCode, resultText(first)).toBe(1);
  expect(resultText(first)).toContain("Forced onboarding failure at step 'policies'");
  expect(fs.existsSync(SESSION_FILE)).toBe(true);

  const sandboxAfterFailure = await sandbox.openshell(["sandbox", "get", SANDBOX_NAME], {
    artifactName: "phase-1-sandbox-get-after-failure",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(sandboxAfterFailure.exitCode, resultText(sandboxAfterFailure)).toBe(0);

  await upsertGenericGatewayProvider(host, LIVE_EXTRA_PROVIDER, {
    artifactName: "phase-1-live-extra-provider-upsert",
    credentialEnv: EXTRA_PROVIDER_TOKEN_ENV,
    env: env({ [EXTRA_PROVIDER_TOKEN_ENV]: EXTRA_PROVIDER_TOKEN }),
    redactionValues: [EXTRA_PROVIDER_TOKEN],
  });
  const seededExtraProviders = updateExtraProviders((providers) => {
    providers.add(STALE_EXTRA_PROVIDER);
    providers.add(LIVE_EXTRA_PROVIDER);
  });
  await artifacts.writeJson("phase-1-extra-providers-seeded.json", seededExtraProviders);
  expect(seededExtraProviders).toEqual(
    expect.arrayContaining([LIVE_EXTRA_PROVIDER, STALE_EXTRA_PROVIDER]),
  );

  await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
    artifactName: "phase-2-delete-recorded-sandbox",
    env: env(),
    timeoutMs: 60_000,
  });
  await waitSandboxAbsent(sandbox, SANDBOX_NAME);

  const repair = await nemoclaw(
    host,
    ["onboard", "--resume", "--non-interactive"],
    "phase-2-resume-repair",
    onboardEnv(SANDBOX_NAME, fake.baseUrl, {
      NEMOCLAW_POLICY_MODE: "skip",
      ...corporateCa.env,
    }),
  );
  expect(repair.exitCode, resultText(repair)).toBe(0);
  expect(resultText(repair)).toContain("[resume] Skipping preflight (cached)");
  expect(resultText(repair)).toContain("Recorded sandbox state is unavailable; recreating it");
  expect(resultText(repair)).toContain("Creating sandbox");
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

  const status = await nemoclaw(host, [SANDBOX_NAME, "status"], "phase-2-status-after-repair");
  expect(status.exitCode, resultText(status)).toBe(0);

  const corporateCaProbe = await sandbox.execShell(SANDBOX_NAME, corporateCaMergeProbeScript(), {
    artifactName: "phase-2-corporate-ca-merge-probe",
    env: env(),
    timeoutMs: 60_000,
  });
  expect(corporateCaProbe.exitCode, resultText(corporateCaProbe)).toBe(0);

  const reinject = await nemoclaw(
    host,
    ["onboard", "--non-interactive"],
    "phase-3-reinject-failure",
    onboardEnv(SANDBOX_NAME, fake.baseUrl, {
      NEMOCLAW_E2E_FAILURE_INJECTION: "1",
      NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
      NEMOCLAW_POLICY_MODE: "suggested",
      NEMOCLAW_RECREATE_SANDBOX: "1",
      ...corporateCa.env,
    }),
  );
  expect(reinject.exitCode, resultText(reinject)).toBe(1);

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
  expect(resultText(providerConflict)).toContain("not 'gpt-5.4'");

  await cleanup(host, sandbox);
  expect(fs.existsSync(SESSION_FILE)).toBe(false);
  await artifacts.target.complete({ id: "onboard-repair", status: "passed" });
});
