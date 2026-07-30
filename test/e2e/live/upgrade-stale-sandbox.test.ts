// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserves the #1904 contract with real Docker/OpenShell/NemoClaw
 * boundaries: onboard current NemoClaw, create an old OpenClaw sandbox from a
 * real image, register two legacy sandboxes on one gateway, prove
 * upgrade-sandboxes detects both, rebuild them as one batch, and prove the
 * stale version and missing shared-route credential metadata are gone.
 */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import {
  allocateSiblingDashboardPort,
  assertDeleteInstalledSandboxAllowed,
  assertDockerAvailable,
  buildOldOpenClawBase,
  cleanupOldImage,
  commandEnv,
  createFixtureDockerfile,
  installCurrentNemoclaw,
  OLD_OPENCLAW_VERSION,
  precleanStaleSandbox,
  registeredStaleSandboxJson,
  registerStateRestore,
  SANDBOX_NAME,
  SANDBOX_NAMES,
  SIBLING_SANDBOX_NAME,
  waitSandboxReady,
  writeStaleRegistryEntries,
} from "./upgrade-stale-sandbox-helpers.ts";

const LIVE_TIMEOUT_MS = 75 * 60_000;

test("upgrade-sandboxes rebuilds two legacy sandboxes on one shared route (#1904, #7798)", {
  timeout: LIVE_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm Docker and install current NemoClaw",
      "construct two old OpenClaw sandboxes on one gateway",
      "register stale shared-route sandbox metadata",
      "detect both stale sandboxes",
      "rebuild both to the current OpenClaw runtime",
      "confirm the upgrade check is clean",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
  const hosted = requireHostedInferenceConfig(secrets);

  await artifacts.target.declare({
    id: "upgrade-stale-sandbox",
    boundary: "install.sh + Docker old base image + OpenShell sandbox create + NemoClaw rebuild",
    sandboxName: SANDBOX_NAME,
    sandboxNames: [...SANDBOX_NAMES],
    oldOpenClawVersion: OLD_OPENCLAW_VERSION,
    contracts: [
      "current NemoClaw install/onboard succeeds before stale fixture creation",
      "an old OpenClaw base image can be created with the legacy version",
      "two legacy sandboxes with missing credentialEnv share one complete inference route",
      "both sandboxes are reported stale by upgrade-sandboxes --check",
      "upgrade-sandboxes --auto upgrades both without orphaning the first sandbox",
      "both registry rows carry the canonical shared credential identity after rebuild",
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
  cleanup.trackDisposable("remove stale OpenClaw test image", () => cleanupOldImage(host));
  for (const sandboxName of SANDBOX_NAMES) {
    cleanup.trackDisposable(`delete OpenShell sandbox ${sandboxName}`, () =>
      sandbox.cleanupSandbox(sandboxName, {
        artifactName: `cleanup-openshell-delete-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, sandboxName, {
      artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 120_000,
    });
  }
  await precleanStaleSandbox(host, sandbox);

  const install = await installCurrentNemoclaw(host, hosted);
  expect(install.exitCode, resultText(install)).toBe(0);

  progress.phase("construct two old OpenClaw sandboxes on one gateway");
  const deleteInstalledSandbox = await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
    artifactName: "phase-2-delete-installed-sandbox",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  assertDeleteInstalledSandboxAllowed(deleteInstalledSandbox);
  const forwardList = await sandbox.openshell(["forward", "list"], {
    artifactName: "phase-2-forward-list-before-stale-fixture",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(forwardList.exitCode, resultText(forwardList)).toBe(0);
  const siblingDashboardPort = allocateSiblingDashboardPort(resultText(forwardList));

  const buildOldBase = await buildOldOpenClawBase(host);
  expect(buildOldBase.exitCode, resultText(buildOldBase)).toBe(0);

  const fixtureDockerfile = createFixtureDockerfile(cleanup);
  for (const sandboxName of SANDBOX_NAMES) {
    const createOldSandbox = await sandbox.openshell(
      [
        "sandbox",
        "create",
        "--name",
        sandboxName,
        "--from",
        fixtureDockerfile,
        "--gateway",
        "nemoclaw",
        "--no-tty",
        "--",
        "true",
      ],
      {
        artifactName: `phase-3-create-old-openclaw-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 15 * 60_000,
      },
    );
    expect(createOldSandbox.exitCode, resultText(createOldSandbox)).toBe(0);

    const waitReady = await waitSandboxReady(
      host,
      sandboxName,
      `phase-3-wait-old-${sandboxName}-ready`,
    );
    expect(waitReady.exitCode, resultText(waitReady)).toBe(0);

    const oldVersion = await sandbox.exec(sandboxName, ["openclaw", "--version"], {
      artifactName: `phase-3-old-openclaw-version-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(oldVersion.exitCode, resultText(oldVersion)).toBe(0);
    expect(resultText(oldVersion)).toContain(OLD_OPENCLAW_VERSION);
  }

  progress.phase("register stale shared-route sandbox metadata");
  writeStaleRegistryEntries(siblingDashboardPort);
  const staleRegistryJson = registeredStaleSandboxJson();
  await artifacts.writeText("registered-stale-sandboxes.json", staleRegistryJson);
  const staleRegistry = JSON.parse(staleRegistryJson) as {
    sandboxes: Record<string, Record<string, unknown>>;
  };
  for (const sandboxName of SANDBOX_NAMES) {
    expect(staleRegistry.sandboxes[sandboxName]).toBeDefined();
    expect(Object.hasOwn(staleRegistry.sandboxes[sandboxName]!, "credentialEnv")).toBe(false);
  }

  progress.phase("detect both stale sandboxes");
  const staleCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
    artifactName: "phase-5-upgrade-sandboxes-check-stale",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 120_000,
  });
  expect(staleCheck.exitCode, resultText(staleCheck)).toBe(0);
  expect(resultText(staleCheck)).toMatch(/stale|need upgrading/i);
  expect(resultText(staleCheck)).not.toMatch(/up to date/i);
  expect(resultText(staleCheck)).toContain(SANDBOX_NAME);
  expect(resultText(staleCheck)).toContain(SIBLING_SANDBOX_NAME);

  progress.phase("rebuild both to the current OpenClaw runtime");
  const rebuild = await host.nemoclaw(["upgrade-sandboxes", "--auto"], {
    artifactName: "phase-6-upgrade-both-stale-sandboxes",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 45 * 60_000,
  });
  expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
  expect(resultText(rebuild)).toMatch(/2 sandbox\(es\) rebuilt/i);

  for (const sandboxName of SANDBOX_NAMES) {
    const waitRebuiltReady = await waitSandboxReady(
      host,
      sandboxName,
      `phase-6-wait-rebuilt-${sandboxName}-ready`,
    );
    expect(waitRebuiltReady.exitCode, resultText(waitRebuiltReady)).toBe(0);

    const newVersion = await sandbox.exec(sandboxName, ["openclaw", "--version"], {
      artifactName: `phase-6-new-openclaw-version-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    expect(newVersion.exitCode, resultText(newVersion)).toBe(0);
    expect(resultText(newVersion)).not.toContain(OLD_OPENCLAW_VERSION);
  }
  const rebuiltRegistry = JSON.parse(registeredStaleSandboxJson()) as {
    sandboxes: Record<string, Record<string, unknown>>;
  };
  for (const sandboxName of SANDBOX_NAMES) {
    expect(rebuiltRegistry.sandboxes[sandboxName]?.credentialEnv).toBe(hosted.credentialEnv);
  }

  progress.phase("confirm the upgrade check is clean");
  const cleanCheck = await host.nemoclaw(["upgrade-sandboxes", "--check"], {
    artifactName: "phase-7-upgrade-sandboxes-check-clean",
    env: commandEnv(hosted.env),
    redactionValues: [hosted.apiKey],
    timeoutMs: 120_000,
  });
  expect(cleanCheck.exitCode, resultText(cleanCheck)).toBe(0);
  expect(resultText(cleanCheck)).toMatch(/up to date/i);
});
