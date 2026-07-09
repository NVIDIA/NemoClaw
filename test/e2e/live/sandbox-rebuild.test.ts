// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  listCredentialLeakPaths,
  listRebuildBackupDirs,
  patchRegistrySandboxEntry,
  readRegistrySandboxEntry,
  restoreRegistryAndSession,
  snapshotRegistryAndSession,
} from "../fixtures/phases/state-validation.ts";
import {
  readCompletedRebuildEvidence,
  readInterruptedRebuildEvidence,
  readRebuildRegistryEvidence,
  sandboxContainerIds,
  startRebuildAtDurableBoundary,
} from "../fixtures/rebuild-recovery.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// This dependent migration reuses the rebuild/state helper shape seeded by the
// OpenClaw rebuild anchor while keeping the contract focused: onboard a real
// sandbox, mark workspace state, force stale registry metadata, then kill and
// resume two real rebuild generations at the destructive recovery boundaries.

const MARKER_FILE = "/sandbox/.openclaw/workspace/rebuild-marker.txt";
const STALE_AGENT_VERSION = "0.0.1";
const TEST_SANDBOX_PREFIX = "e2e-sandbox-rebuild";
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  [TEST_SANDBOX_PREFIX, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT, process.pid]
    .filter(Boolean)
    .join("-");
const TEST_TIMEOUT_MS = Number(process.env.NEMOCLAW_E2E_TIMEOUT_SECONDS ?? 1_200) * 1_000;
const STATUS_TIMEOUT_MS = 60_000;
const ONBOARD_TIMEOUT_MS = TEST_TIMEOUT_MS;
const REBUILD_TIMEOUT_MS = TEST_TIMEOUT_MS;
const MARKER_CONTENT = `REBUILD_E2E_${Date.now()}`;

function sandboxRebuildEnv(apiKey: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
  };
}

function assertTestOwnedSandboxName(): void {
  if (!SANDBOX_NAME.startsWith(TEST_SANDBOX_PREFIX)) {
    throw new Error(
      `sandbox-rebuild live test is destructive and only accepts sandbox names with prefix ${TEST_SANDBOX_PREFIX}; got ${SANDBOX_NAME}`,
    );
  }
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup remains best-effort so earlier lifecycle failures stay visible.
  }
}

async function expectStoppedRebuild(
  host: HostCliClient,
  pid: number,
  artifactName: string,
): Promise<void> {
  const state = await host.command("ps", ["-o", "stat=", "-p", String(pid)], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 10_000,
  });
  expect(state.exitCode, resultText(state)).toBe(0);
  expect(state.stdout.trim()).toMatch(/^T/u);
}

test(
  "sandbox rebuild recovers destructive process death without duplicate effects (#6437)",
  async ({
    artifacts,
    cleanup,
    environment,
    host,
    lifecycle,
    onboard,
    sandbox,
    secrets,
    skip,
    stateValidation,
  }) => {
    assertTestOwnedSandboxName();
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (dockerInfo.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for sandbox-rebuild live coverage: ${resultText(dockerInfo)}`,
        );
      }
      skip("Docker is required for sandbox-rebuild live coverage");
    }

    const ready = await environment.assertReady({
      platform: "ubuntu-local",
      install: "repo-current",
      runtime: "docker-running",
      onboarding: "cloud-openclaw",
    });

    await artifacts.writeJson("contract.json", {
      sandboxName: SANDBOX_NAME,
      markerFile: MARKER_FILE,
      staleAgentVersion: STALE_AGENT_VERSION,
      preservedBoundaries: [
        "real nemoclaw onboard with Docker/OpenShell",
        "openshell sandbox exec marker write/read",
        "local registry stale agentVersion mutation",
        "SIGSTOP/SIGKILL after durable old-sandbox deletion",
        "SIGSTOP/SIGKILL after unjournaled replacement creation",
        "ordinary public rebuild command recovery for both generations",
        "backup credential leak scan under ~/.nemoclaw/rebuild-backups",
      ],
    });

    const stateSnapshot = snapshotRegistryAndSession();
    const backupRoot = path.join(
      process.env.HOME ?? os.homedir(),
      ".nemoclaw",
      "rebuild-backups",
      SANDBOX_NAME,
    );
    cleanup.add(`restore NemoClaw state files for ${SANDBOX_NAME}`, () => {
      restoreRegistryAndSession(stateSnapshot);
      fs.rmSync(backupRoot, { recursive: true, force: true });
    });
    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;
      await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "cleanup-nemoclaw-destroy"));
      await bestEffort(() =>
        sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 60_000,
        }),
      );
    });

    await bestEffort(() => onboard.destroySandbox(SANDBOX_NAME, "pre-cleanup-nemoclaw-destroy"));
    await bestEffort(() =>
      sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      }),
    );

    const instance = await onboard.from(ready, {
      sandboxName: SANDBOX_NAME,
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
    const home = process.env.HOME ?? os.homedir();
    const initialRegistry = readRebuildRegistryEvidence(SANDBOX_NAME, home);

    const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: "phase-2-status-version-detection",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    await artifacts.writeText("phase-2-status-output.txt", resultText(status));
    if (/Agent:.*v?\d+\.\d+/i.test(resultText(status))) {
      await artifacts.writeJson("phase-2-status-version-summary.json", { versionVisible: true });
    } else {
      await artifacts.writeJson("phase-2-status-version-summary.json", {
        versionVisible: false,
        note: "Legacy shell accepted first-run status output without cached version.",
      });
    }

    await stateValidationWriteMarker();

    patchRegistrySandboxEntry(SANDBOX_NAME, { agentVersion: STALE_AGENT_VERSION });
    await artifacts.writeJson("phase-4-stale-registry-summary.json", {
      sandboxName: SANDBOX_NAME,
      agentVersion: readRegistrySandboxEntry(SANDBOX_NAME).agentVersion,
    });

    const staleStatus = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: "phase-4-status-stale-warning",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    expect(staleStatus.exitCode, resultText(staleStatus)).toBe(0);
    expect(resultText(staleStatus)).toMatch(/rebuild/i);

    const deletedProcess = await startRebuildAtDurableBoundary({
      artifacts,
      artifactName: "phase-5-rebuild-interrupt-old-deleted",
      commandPath: host.commandPath,
      env: sandboxRebuildEnv(apiKey),
      phase: "old_deleted",
      redact: (text) => secrets.redact(text, [apiKey]),
      sandboxName: SANDBOX_NAME,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    cleanup.add("kill old_deleted rebuild process", async () => {
      await deletedProcess.kill();
    });
    await expectStoppedRebuild(host, deletedProcess.pid, "phase-5-stopped-process-state");
    const deletedEvidence = readInterruptedRebuildEvidence(SANDBOX_NAME, "old_deleted", home);
    expect(
      await sandboxContainerIds(host, SANDBOX_NAME, {
        artifactName: "phase-5-old-sandbox-container-absence",
        env: buildAvailabilityProbeEnv(),
      }),
    ).toEqual([]);
    const deletedList = await sandbox.list({
      artifactName: "phase-5-old-sandbox-openshell-absence",
      env: {
        ...buildAvailabilityProbeEnv(),
        OPENSHELL_GATEWAY: deletedEvidence.target.gatewayName,
      },
    });
    expect(resultText(deletedList)).not.toContain(SANDBOX_NAME);
    expect(deletedEvidence).toMatchObject({
      status: "active",
      phase: "old_deleted",
      receipts: { backup: true, oldSandboxDeletion: true, replacement: false },
      replacement: null,
    });
    await artifacts.writeJson("phase-5-old-deleted-interruption.json", deletedEvidence);
    await expect(deletedProcess.kill()).resolves.toMatchObject({ signal: "SIGKILL" });

    await lifecycle.rebuildSandbox(instance, {
      artifactName: "phase-6-resume-old-deleted-through-public-command",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    await lifecycle.assertSandboxReadyAfterRebuild(instance, {
      artifactNamePrefix: "phase-6-sandbox-ready-after-recovery",
      env: buildAvailabilityProbeEnv(),
      attempts: 12,
      delayMs: 5_000,
    });

    await stateValidation.expectMarkerFileContent(instance, MARKER_FILE, MARKER_CONTENT, {
      artifactName: "phase-6-read-marker-after-recovery",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    const firstCompleted = readCompletedRebuildEvidence(SANDBOX_NAME, home);
    await artifacts.writeJson("phase-6-first-completed-tombstone.json", firstCompleted);

    const updatedVersion = stateValidation.expectRegistryAgentVersionUpdated(
      SANDBOX_NAME,
      STALE_AGENT_VERSION,
    );
    await artifacts.writeJson("phase-7-registry-version-summary.json", {
      sandboxName: SANDBOX_NAME,
      staleVersion: STALE_AGENT_VERSION,
      updatedVersion,
    });

    const replacementProcess = await startRebuildAtDurableBoundary({
      artifacts,
      artifactName: "phase-8-rebuild-interrupt-replacement-unjournaled",
      commandPath: host.commandPath,
      env: sandboxRebuildEnv(apiKey),
      phase: "replacement_unjournaled",
      redact: (text) => secrets.redact(text, [apiKey]),
      sandboxName: SANDBOX_NAME,
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    cleanup.add("kill replacement_unjournaled rebuild process", async () => {
      await replacementProcess.kill();
    });
    await expectStoppedRebuild(host, replacementProcess.pid, "phase-8-stopped-process-state");
    const replacementEvidence = readInterruptedRebuildEvidence(
      SANDBOX_NAME,
      "replacement_unjournaled",
      home,
    );
    expect(replacementEvidence.transactionId).not.toBe(firstCompleted.transactionId);
    const replacementContainers = await sandboxContainerIds(host, SANDBOX_NAME, {
      artifactName: "phase-8-replacement-container-identity",
      env: buildAvailabilityProbeEnv(),
    });
    expect(replacementContainers).toHaveLength(1);
    const replacementList = await sandbox.list({
      artifactName: "phase-8-replacement-ready",
      env: {
        ...buildAvailabilityProbeEnv(),
        OPENSHELL_GATEWAY: replacementEvidence.target.gatewayName,
      },
    });
    expect(resultText(replacementList)).toMatch(
      new RegExp(`${SANDBOX_NAME}.*(?:Ready|Running)`, "u"),
    );
    expect(replacementEvidence.replacement).toMatchObject({
      registryGatewayName: replacementEvidence.target.gatewayName,
      registryGatewayPort: replacementEvidence.target.gatewayPort,
      sessionTransactionId: replacementEvidence.transactionId,
      sessionImageFingerprint: replacementEvidence.target.imageFingerprint,
      sessionConfigurationFingerprint: replacementEvidence.target.configurationFingerprint,
    });
    await artifacts.writeJson(
      "phase-8-replacement-unjournaled-interruption.json",
      replacementEvidence,
    );
    await expect(replacementProcess.kill()).resolves.toMatchObject({ signal: "SIGKILL" });

    const adoptedContainerId = replacementContainers[0]!;
    const adopted = await lifecycle.rebuildSandbox(instance, {
      artifactName: "phase-9-adopt-replacement-through-public-command",
      env: sandboxRebuildEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: REBUILD_TIMEOUT_MS,
    });
    expect(resultText(adopted)).not.toMatch(/Deleting old sandbox|Creating new sandbox/u);
    await lifecycle.assertSandboxReadyAfterRebuild(instance, {
      artifactNamePrefix: "phase-9-sandbox-ready-after-adoption",
      env: buildAvailabilityProbeEnv(),
      attempts: 12,
      delayMs: 5_000,
    });
    expect(
      await sandboxContainerIds(host, SANDBOX_NAME, {
        artifactName: "phase-9-adopted-container-identity",
        env: buildAvailabilityProbeEnv(),
      }),
    ).toEqual([adoptedContainerId]);
    await stateValidation.expectMarkerFileContent(instance, MARKER_FILE, MARKER_CONTENT, {
      artifactName: "phase-9-read-marker-after-adoption",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });

    const secondCompleted = readCompletedRebuildEvidence(SANDBOX_NAME, home);
    expect(secondCompleted.transactionId).toBe(replacementEvidence.transactionId);
    expect(secondCompleted.transactionId).not.toBe(firstCompleted.transactionId);
    await artifacts.writeJson("phase-10-completed-generations.json", {
      retainedCompletedTombstones: [firstCompleted, secondCompleted],
    });

    const finalRegistry = readRebuildRegistryEvidence(SANDBOX_NAME, home);
    expect(finalRegistry).toMatchObject({
      agent: initialRegistry.agent,
      defaultSandbox: initialRegistry.defaultSandbox,
      gatewayName: initialRegistry.gatewayName,
      gatewayPort: initialRegistry.gatewayPort,
      agentVersion: updatedVersion,
      nemoclawVersion: initialRegistry.nemoclawVersion,
      observabilityEnabled: initialRegistry.observabilityEnabled,
      policies: initialRegistry.policies,
      toolDisclosure: initialRegistry.toolDisclosure,
    });

    const backupScans = listRebuildBackupDirs(SANDBOX_NAME).map((backupDir) => ({
      backupDir,
      leaks: listCredentialLeakPaths(backupDir, { extraSecrets: [apiKey] }),
    }));
    await artifacts.writeJson("phase-11-backup-credential-scans.json", backupScans);
    expect(backupScans.length).toBeGreaterThanOrEqual(2);
    expect(
      backupScans.flatMap(({ leaks }) => leaks),
      "backup files must not contain credential-shaped values",
    ).toEqual([]);

    async function stateValidationWriteMarker(): Promise<void> {
      await stateValidation.writeMarkerFile(instance, MARKER_FILE, MARKER_CONTENT, {
        artifactName: "phase-3-write-marker",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      });
      await stateValidation.expectMarkerFileContent(instance, MARKER_FILE, MARKER_CONTENT, {
        artifactName: "phase-3-read-marker-before-rebuild",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      });
    }
  },
  TEST_TIMEOUT_MS * 5,
);
