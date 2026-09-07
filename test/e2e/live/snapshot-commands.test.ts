// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: install.sh non-interactive onboard,
 * NemoClaw snapshot create/restore commands, OpenShell sandbox exec for
 * workspace mutation/verification, artifact capture, cleanup, and secret
 * redaction.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import {
  buildSnapshotCommandEnv,
  classifySnapshotGatewayProbe,
  classifySnapshotRestoreResult,
  expectedSnapshotCloneRestoreResult,
  type SnapshotInferenceFixture,
} from "./snapshot-commands-helpers.ts";
import { scanSnapshotCredentialLeaks } from "./snapshot-credential-scanner.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-snapshot";
validateSandboxName(SANDBOX_NAME);
const CLONE_SANDBOX_NAME = `${SANDBOX_NAME}-clone`;
validateSandboxName(CLONE_SANDBOX_NAME);
const BACKUP_ROOT = path.join(os.homedir(), ".nemoclaw", "rebuild-backups");
const BACKUP_DIR = path.resolve(BACKUP_ROOT, SANDBOX_NAME);
if (!BACKUP_DIR.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`)) {
  throw new Error(`snapshot backup directory escaped rebuild-backups root: ${BACKUP_DIR}`);
}
const OPENCLAW_WORKSPACE_PATH = "/sandbox/.openclaw/workspace";
const MARKER_FILE = `${OPENCLAW_WORKSPACE_PATH}/snapshot-marker.txt`;
const SNAPSHOT_NAME = "lifecycle";
const BASELINE_EXCLUSION_KEY = "openclaw_docs";
const LIVE_TIMEOUT_MS = 36 * 60_000;
const INFERENCE_API_KEY = "nvapi-snapshot-commands-fixture-credential";
const INFERENCE_MODEL = "snapshot-commands-model";
const OPENCLAW_MAIN_SESSION_STORE = "/sandbox/.openclaw/agents/main/sessions/sessions.json";
const CREDENTIALS_DIR = "/sandbox/.openclaw/credentials";
const CREDENTIAL_FILE = `${CREDENTIALS_DIR}/backup-all-fixture.json`;
const CREDENTIAL_FIXTURE = JSON.stringify({
  apiKey: INFERENCE_API_KEY,
});

function commandEnv(
  inference?: SnapshotInferenceFixture,
  sandboxName = SANDBOX_NAME,
): NodeJS.ProcessEnv {
  return buildSnapshotCommandEnv(sandboxName, inference);
}

async function bestEffortPreclean(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Mirrors the legacy teardown: cleanup attempts should not hide the main failure.
  }
}

async function precleanSnapshotSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  label: string,
): Promise<void> {
  await host.bestEffortCleanupSandbox(sandboxName, {
    artifactName: `${label}-nemoclaw-destroy`,
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  await bestEffortPreclean(() =>
    sandbox.openshell(["sandbox", "delete", sandboxName], {
      artifactName: `${label}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

async function precleanSnapshotGateway(sandbox: SandboxClient, label: string): Promise<void> {
  await bestEffortPreclean(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${label}-openshell-gateway-destroy`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

async function expectSandboxFileContent(
  sandbox: SandboxClient,
  sandboxName: string,
  filePath: string,
  expected: string,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(sandboxName, ["cat", filePath], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
}

async function expectAuthenticatedGatewayPairing(
  sandbox: SandboxClient,
  sandboxName: string,
  inference: SnapshotInferenceFixture,
  artifactName: string,
): Promise<string> {
  const sessionId = `snapshot-restore-verify-${randomUUID()}`;
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`
set -eu
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
openclaw agent --agent main --json -m "ping" \
  --session-id ${JSON.stringify(sessionId)}
`),
    {
      artifactName,
      env: commandEnv(inference, sandboxName),
      redactionValues: [inference.apiKey],
      timeoutMs: 60_000,
    },
  );
  expect(classifySnapshotGatewayProbe(result)).toBe("authenticated");
  return sessionId;
}

async function expectSandboxSessionPresence(
  sandbox: SandboxClient,
  sandboxName: string,
  sessionId: string,
  expected: boolean,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "node",
      "-e",
      `
const fs = require("node:fs");
const sessionId = process.argv[1];
const expected = process.argv[2] === "present";
let found = false;
try {
  found = fs.readFileSync(${JSON.stringify(OPENCLAW_MAIN_SESSION_STORE)}, "utf8").includes(sessionId);
} catch (error) {
  if (!error || error.code !== "ENOENT") throw error;
}
process.exit(found === expected ? 0 : 1);
`,
      sessionId,
      expected ? "present" : "absent",
    ],
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

async function expectLiveBaselineExcluded(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const livePolicy = await sandbox.openshell(["policy", "get", "--base", sandboxName], {
    artifactName: `${artifactPrefix}-openshell-policy-get-base`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(livePolicy.exitCode, resultText(livePolicy)).toBe(0);
  expect(resultText(livePolicy)).toMatch(/^[ \t]+managed_inference:/m);
  expect(resultText(livePolicy)).not.toMatch(new RegExp(`^[ \\t]+${BASELINE_EXCLUSION_KEY}:`, "m"));
}

test(
  "snapshot commands restore source state without credential leaks and verify clone behavior for the selected workload source",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the selected runtime and start hermetic inference",
        "onboard the snapshot sandbox",
        "create one snapshot",
        "destroy, freshly onboard, and restore workspace state",
        "restore the snapshot into a clone",
        "verify the restored clone state and gateway pairing",
        "back up credential state without secret leaks",
        "record snapshot lifecycle evidence",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, runtimeProvider, sandbox }) => {
    await artifacts.target.declare({
      id: "snapshot-commands",
      boundary: "install.sh + nemoclaw snapshot commands + openshell sandbox exec",
      sandboxName: SANDBOX_NAME,
      backupDir: BACKUP_DIR,
      contracts: [
        "install.sh onboards a live OpenClaw sandbox",
        "snapshot create captures workspace state without credential material",
        "snapshot restore recovers workspace state after destroy and fresh same-name onboarding",
        "snapshot restore preserves the destination OpenShell policy",
        "legacy snapshot restore --to carries the source live OpenShell policy into the clone; managed snapshots refuse before destination effects until clone rebind is activated",
        "a restored legacy clone owns its authenticated gateway session",
        "backup-all excludes credential values",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "phase-0-runtime-info",
      scenarioLabel: "snapshot commands",
    });

    const inference = await startFakeOpenAiCompatibleServer({
      apiKey: INFERENCE_API_KEY,
      host: "0.0.0.0",
      model: INFERENCE_MODEL,
      progress,
      publicHost: "host.openshell.internal",
      requireAuth: true,
      requireAuthModels: true,
    });
    cleanup.trackDisposable("close snapshot commands compatible inference fixture", async () => {
      await artifacts.writeJson("compatible-inference-requests.json", inference.requests());
      await inference.close();
    });
    const inferenceConfig = {
      apiKey: INFERENCE_API_KEY,
      endpointUrl: inference.baseUrl,
      model: INFERENCE_MODEL,
    };

    cleanup.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    cleanup.trackDisposable(`delete OpenShell sandbox ${CLONE_SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(CLONE_SANDBOX_NAME, {
        artifactName: "cleanup-clone-openshell-sandbox-delete",
        env: commandEnv(),
        timeoutMs: 60_000,
      }),
    );
    cleanup.trackSandbox(host, CLONE_SANDBOX_NAME, {
      artifactName: "cleanup-clone-nemoclaw-destroy",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    cleanup.trackDisposable(`remove snapshot backup directory ${BACKUP_DIR}`, () => {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
      if (fs.existsSync(BACKUP_DIR)) {
        throw new Error(`snapshot backup directory remains after cleanup: ${BACKUP_DIR}`);
      }
    });

    await precleanSnapshotSandbox(host, sandbox, CLONE_SANDBOX_NAME, "pre-cleanup-clone");
    await precleanSnapshotSandbox(host, sandbox, SANDBOX_NAME, "pre-cleanup");
    await precleanSnapshotGateway(sandbox, "pre-cleanup");
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

    progress.phase("onboard the snapshot sandbox");
    const install = await host.command("bash", ["install.sh", "--non-interactive", "--fresh"], {
      artifactName: "phase-1-install-nemoclaw",
      cwd: REPO_ROOT,
      env: commandEnv(inferenceConfig),
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 20 * 60_000,
    });
    expect(install.exitCode, resultText(install)).toBe(0);

    const excludeBaseline = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "policy", "exclude", BASELINE_EXCLUSION_KEY, "--force"],
      {
        artifactName: "phase-2-policy-exclude-baseline",
        env: commandEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(excludeBaseline.exitCode, resultText(excludeBaseline)).toBe(0);
    await expectLiveBaselineExcluded(sandbox, SANDBOX_NAME, "phase-2-after-exclude");

    const markerContent = `SNAPSHOT_E2E_${Date.now()}`;

    const writeMarker = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        `set -eu
test "$OPENCLAW_WORKSPACE_DIR" = ${JSON.stringify(OPENCLAW_WORKSPACE_PATH)}
mkdir -p "$OPENCLAW_WORKSPACE_DIR"
printf '%s' ${JSON.stringify(markerContent)} > ${JSON.stringify(MARKER_FILE)}`,
      ],
      {
        artifactName: "phase-2-write-marker",
        env: commandEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(writeMarker.exitCode, resultText(writeMarker)).toBe(0);
    await expectSandboxFileContent(
      sandbox,
      SANDBOX_NAME,
      MARKER_FILE,
      markerContent,
      "phase-2-read-marker",
    );

    progress.phase("create one snapshot");
    const firstCreate = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "snapshot", "create", "--name", SNAPSHOT_NAME],
      {
        artifactName: "phase-3-snapshot-create",
        env: commandEnv(),
        timeoutMs: 120_000,
      },
    );
    expect(firstCreate.exitCode, resultText(firstCreate)).toBe(0);
    const credentialLeaks = scanSnapshotCredentialLeaks(BACKUP_DIR);
    await artifacts.writeJson("phase-3-credential-scan.json", {
      leakedFiles: credentialLeaks,
    });
    expect(credentialLeaks).toEqual([]);
    const requiredCloneRestoreResult = expectedSnapshotCloneRestoreResult(
      process.env.E2E_WORKLOAD_SOURCE,
    );

    progress.phase("destroy, freshly onboard, and restore workspace state");
    const destroySource = await host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "phase-4-destroy-source",
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    expect(destroySource.exitCode, resultText(destroySource)).toBe(0);

    const freshOnboard = await host.command(
      "nemoclaw",
      ["onboard", "--fresh", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-4-fresh-onboard-source",
        env: commandEnv(inferenceConfig),
        redactionValues: [INFERENCE_API_KEY],
        timeoutMs: 20 * 60_000,
      },
    );
    expect(freshOnboard.exitCode, resultText(freshOnboard)).toBe(0);

    const reapplyBaselineExclusion = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "policy", "exclude", BASELINE_EXCLUSION_KEY, "--force"],
      {
        artifactName: "phase-4-reapply-baseline-exclusion",
        env: commandEnv(),
        timeoutMs: 60_000,
      },
    );
    expect(reapplyBaselineExclusion.exitCode, resultText(reapplyBaselineExclusion)).toBe(0);
    await expectLiveBaselineExcluded(
      sandbox,
      SANDBOX_NAME,
      "phase-4-after-reapplying-baseline-exclusion",
    );

    const replacementHasNoSnapshotMarkers = await sandbox.exec(
      SANDBOX_NAME,
      ["sh", "-lc", `test ! -e ${JSON.stringify(MARKER_FILE)}`],
      {
        artifactName: "phase-4-verify-fresh-workspace",
        env: commandEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(
      replacementHasNoSnapshotMarkers.exitCode,
      resultText(replacementHasNoSnapshotMarkers),
    ).toBe(0);

    const replacementRestore = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "snapshot", "restore", SNAPSHOT_NAME],
      {
        artifactName: "phase-4-restore-source-after-fresh-onboard",
        env: commandEnv(),
        timeoutMs: 120_000,
      },
    );
    expect(classifySnapshotRestoreResult(replacementRestore)).toBe("restored");
    await expectSandboxFileContent(
      sandbox,
      SANDBOX_NAME,
      MARKER_FILE,
      markerContent,
      "phase-4-read-restored-source-marker",
    );
    await expectLiveBaselineExcluded(
      sandbox,
      SANDBOX_NAME,
      "phase-4-restored-source-baseline-exclusion",
    );

    progress.phase("restore the snapshot into a clone");
    const cloneRestore = await host.command(
      "nemoclaw",
      [SANDBOX_NAME, "snapshot", "restore", SNAPSHOT_NAME, "--to", CLONE_SANDBOX_NAME, "--yes"],
      {
        artifactName: "phase-4-snapshot-restore-to-clone",
        env: commandEnv(),
        timeoutMs: 5 * 60_000,
      },
    );
    const cloneRestoreResult = classifySnapshotRestoreResult(cloneRestore);
    expect(cloneRestoreResult).toBe(requiredCloneRestoreResult);
    progress.phase("verify the restored clone state and gateway pairing");
    switch (requiredCloneRestoreResult) {
      case "managed-clone-rebind-required": {
        expect(resultText(cloneRestore)).toContain(
          `restoring '${SANDBOX_NAME}' as '${CLONE_SANDBOX_NAME}' requires managed-profile clone rebind`,
        );
        expect(resultText(cloneRestore)).toContain(
          `Destination '${CLONE_SANDBOX_NAME}' was not changed`,
        );
        const absentManagedClone = await host.command(
          "openshell",
          ["sandbox", "get", "-g", "nemoclaw", CLONE_SANDBOX_NAME],
          {
            artifactName: "phase-4-managed-clone-remains-absent",
            env: commandEnv(),
            timeoutMs: 30_000,
          },
        );
        expect(absentManagedClone.exitCode, "managed-clone-dormancy-destination-exists").not.toBe(
          0,
        );
        await artifacts.writeJson("phase-4-managed-clone-dormancy.json", {
          classification: cloneRestoreResult,
          destinationAbsent: true,
        });
        break;
      }
      case "restored": {
        await expectSandboxFileContent(
          sandbox,
          CLONE_SANDBOX_NAME,
          MARKER_FILE,
          markerContent,
          "phase-4-read-clone-marker",
        );
        await expectLiveBaselineExcluded(
          sandbox,
          CLONE_SANDBOX_NAME,
          "phase-4-clone-baseline-exclusion",
        );
        const pairingSessionId = await expectAuthenticatedGatewayPairing(
          sandbox,
          CLONE_SANDBOX_NAME,
          inferenceConfig,
          "phase-4-verify-clone-gateway-pairing",
        );
        await expectSandboxSessionPresence(
          sandbox,
          CLONE_SANDBOX_NAME,
          pairingSessionId,
          true,
          "phase-4-verify-clone-session-owner",
        );
        await expectSandboxSessionPresence(
          sandbox,
          SANDBOX_NAME,
          pairingSessionId,
          false,
          "phase-4-verify-source-session-non-owner",
        );
        const destroyClone = await host.command(
          "nemoclaw",
          [CLONE_SANDBOX_NAME, "destroy", "--yes"],
          {
            artifactName: "phase-4-destroy-clone",
            env: commandEnv(),
            timeoutMs: 120_000,
          },
        );
        expect(destroyClone.exitCode, resultText(destroyClone)).toBe(0);
        break;
      }
      default:
        throw new Error(`Unexpected snapshot clone result classification: ${cloneRestoreResult}`);
    }

    progress.phase("back up credential state without secret leaks");
    const writeCredential = await sandbox.exec(
      SANDBOX_NAME,
      [
        "sh",
        "-lc",
        'mkdir -p "$1" && printf %s "$2" >"$3"',
        "write-credential-state",
        CREDENTIALS_DIR,
        CREDENTIAL_FIXTURE,
        CREDENTIAL_FILE,
      ],
      {
        artifactName: "phase-11-write-credential-state",
        env: commandEnv(),
        redactionValues: [INFERENCE_API_KEY],
        timeoutMs: 30_000,
      },
    );
    expect(writeCredential.exitCode, resultText(writeCredential)).toBe(0);

    const credentialBackup = await host.command("nemoclaw", ["backup-all"], {
      artifactName: "phase-11-backup-all-credential-state",
      env: { ...commandEnv(), NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS: "1" },
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 180_000,
    });
    expect(credentialBackup.exitCode, resultText(credentialBackup)).toBe(0);
    expect(resultText(credentialBackup)).not.toContain(INFERENCE_API_KEY);
    expect(scanSnapshotCredentialLeaks(BACKUP_DIR)).toEqual([]);

    progress.phase("record snapshot lifecycle evidence");
    await artifacts.target.complete({
      id: "snapshot-commands",
      status: "passed",
      snapshotName: SNAPSHOT_NAME,
      excludedLiveBaselineKey: BASELINE_EXCLUSION_KEY,
      cloneSandboxName: CLONE_SANDBOX_NAME,
      cloneRestoreResult,
      credentialSecretsExcluded: true,
    });
  },
);
