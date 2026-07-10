// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserves the #1904 contract with real Docker/OpenShell/NemoClaw
 * boundaries: onboard current NemoClaw, create an old OpenClaw sandbox from a
 * real image, register stale sandbox metadata, prove upgrade-sandboxes detects
 * the stale sandbox, rebuild it, and prove the stale version is gone.
 */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  assertDeleteInstalledSandboxAllowed,
  assertDockerAvailable,
  buildOldOpenClawBase,
  cleanupOldImage,
  cleanupStaleSandbox,
  commandEnv,
  createFixtureDockerfile,
  installCurrentNemoclaw,
  OLD_OPENCLAW_VERSION,
  registeredStaleSandboxJson,
  registerStateRestore,
  SANDBOX_NAME,
  waitSandboxReady,
  writeStaleRegistryEntry,
} from "./upgrade-stale-sandbox-helpers.ts";

const LIVE_TIMEOUT_MS = 45 * 60_000;

test("upgrade-sandboxes detects and rebuilds stale OpenClaw sandboxes (#1904)", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
  const hosted = requireHostedInferenceConfig(secrets);

  await artifacts.target.declare({
    id: "upgrade-stale-sandbox",
    boundary: "install.sh + Docker old base image + OpenShell sandbox create + NemoClaw rebuild",
    sandboxName: SANDBOX_NAME,
    oldOpenClawVersion: OLD_OPENCLAW_VERSION,
    contracts: [
      "current NemoClaw install/onboard succeeds before stale fixture creation",
      "an old OpenClaw base image can be created with the legacy version",
      "a sandbox registered with old agentVersion is reported stale by upgrade-sandboxes --check",
      "nemoclaw <sandbox> rebuild --yes upgrades the sandbox away from the old OpenClaw version",
      "upgrade-sandboxes --check reports up-to-date after rebuild",
    ],
  });

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  assertDockerAvailable(dockerInfo, skip);

  registerStateRestore(cleanup);
  cleanup.add(`destroy stale sandbox ${SANDBOX_NAME}`, () => cleanupStaleSandbox(host, sandbox));
  cleanup.add("remove stale OpenClaw test image", () => cleanupOldImage(host));
  await cleanupStaleSandbox(host, sandbox);

  const install = await installCurrentNemoclaw(host, hosted);
  expect(install.exitCode, resultText(install)).toBe(0);

  const deleteInstalledSandbox = await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
    artifactName: "phase-2-delete-installed-sandbox",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  assertDeleteInstalledSandboxAllowed(deleteInstalledSandbox);

  const buildOldBase = await buildOldOpenClawBase(host);
  expect(buildOldBase.exitCode, resultText(buildOldBase)).toBe(0);

  const fixtureDockerfile = createFixtureDockerfile(cleanup);
  const createOldSandbox = await sandbox.openshell(
    [
      "sandbox",
      "create",
      "--name",
      SANDBOX_NAME,
      "--from",
      fixtureDockerfile,
      "--gateway",
      "nemoclaw",
      "--no-tty",
      "--",
      "true",
    ],
    {
      artifactName: "phase-3-create-old-openclaw-sandbox",
      env: commandEnv(),
      timeoutMs: 15 * 60_000,
    },
  );
  expect(createOldSandbox.exitCode, resultText(createOldSandbox)).toBe(0);

  const waitReady = await waitSandboxReady(host, "phase-3-wait-old-sandbox-ready");
  expect(waitReady.exitCode, resultText(waitReady)).toBe(0);

  const oldVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
    artifactName: "phase-3-old-openclaw-version",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(oldVersion.exitCode, resultText(oldVersion)).toBe(0);
  expect(resultText(oldVersion)).toContain(OLD_OPENCLAW_VERSION);

  writeStaleRegistryEntry();
  await artifacts.writeText("registered-stale-sandbox.json", registeredStaleSandboxJson());

  const staleCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
    artifactName: "phase-5-upgrade-sandboxes-check-stale",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 120_000,
  });
  expect(staleCheck.exitCode, resultText(staleCheck)).toBe(0);
  expect(resultText(staleCheck)).toMatch(/stale|need upgrading/i);
  expect(resultText(staleCheck)).not.toMatch(/up to date/i);

  const rebuild = await host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes"], {
    artifactName: "phase-6-rebuild-stale-sandbox",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 25 * 60_000,
  });
  expect(rebuild.exitCode, resultText(rebuild)).toBe(0);

  const waitRebuiltReady = await waitSandboxReady(host, "phase-6-wait-rebuilt-sandbox-ready");
  expect(waitRebuiltReady.exitCode, resultText(waitRebuiltReady)).toBe(0);

  const newVersion = await sandbox.exec(SANDBOX_NAME, ["openclaw", "--version"], {
    artifactName: "phase-6-new-openclaw-version",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(newVersion.exitCode, resultText(newVersion)).toBe(0);
  expect(resultText(newVersion)).not.toContain(OLD_OPENCLAW_VERSION);

  const cleanCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
    artifactName: "phase-7-upgrade-sandboxes-check-clean",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 120_000,
  });
  expect(cleanCheck.exitCode, resultText(cleanCheck)).toBe(0);
  expect(resultText(cleanCheck)).toMatch(/up to date/i);
});
