// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: install.sh non-interactive onboard,
 * NemoClaw snapshot create/list/restore commands, OpenShell sandbox exec for
 * workspace mutation/verification, host rebuild-backups inspection, artifact
 * capture, cleanup, and secret redaction.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
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
const MARKER_FILE = "/sandbox/.openclaw/workspace/snapshot-marker.txt";
const SECOND_MARKER = "/sandbox/.openclaw/workspace/snapshot-marker-2.txt";
const BASELINE_EXCLUSION_KEY = "openclaw_docs";
const LIVE_TIMEOUT_MS = 36 * 60_000;
const INFERENCE_API_KEY = "nvapi-snapshot-commands-fixture-credential";
const INFERENCE_MODEL = "snapshot-commands-model";
const PROTECTED_CREDENTIALS_DIR = "/sandbox/.openclaw/credentials";
const PROTECTED_CREDENTIAL_FILE = `${PROTECTED_CREDENTIALS_DIR}/backup-all-fixture.json`;
const PROTECTED_CREDENTIAL_MARKER = "snapshot-backup-non-secret-marker";
const PROTECTED_CREDENTIAL_FIXTURE = JSON.stringify({
  apiKey: INFERENCE_API_KEY,
  marker: PROTECTED_CREDENTIAL_MARKER,
});
const SHIELDS_TIMER_FILE = path.join(
  os.homedir(),
  ".nemoclaw",
  "state",
  `shields-timer-${SANDBOX_NAME}.json`,
);

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
): Promise<void> {
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(`
set -eu
PROXY_ENV=/tmp/nemoclaw-proxy-env.sh
[ -r "$PROXY_ENV" ] && . "$PROXY_ENV"
openclaw agent --agent main --json -m "ping" \
  --session-id "snapshot-restore-verify-$$-$(date +%s)"
`),
    {
      artifactName,
      env: commandEnv(inference, sandboxName),
      timeoutMs: 60_000,
    },
  );
  expect(classifySnapshotGatewayProbe(result)).toBe("authenticated");
}

async function expectShieldsUp(host: HostCliClient, artifactName: string): Promise<void> {
  const result = await host.command("nemoclaw", [SANDBOX_NAME, "shields", "status"], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout).toContain("Shields: UP");
}

async function rootSandboxPathMetadata(
  host: HostCliClient,
  containerId: string,
  targetPath: string,
  artifactName: string,
): Promise<{ mode: string; owner: string }> {
  const result = await host.command(
    "docker",
    ["exec", "-u", "0", containerId, "stat", "-c", "%a %U:%G", targetPath],
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const [mode = "", owner = ""] = result.stdout.trim().split(/\s+/, 2);
  return { mode, owner };
}

async function expectBaselineExclusionAgreement(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const status = await host.command("nemoclaw", [sandboxName, "status", "--json"], {
    artifactName: `${artifactPrefix}-nemoclaw-status-json`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);
  const statusJson = JSON.parse(status.stdout) as { baselineExclusions: string[] };
  expect(statusJson.baselineExclusions).toContain(BASELINE_EXCLUSION_KEY);

  const policyList = await host.command("nemoclaw", [sandboxName, "policy", "list"], {
    artifactName: `${artifactPrefix}-nemoclaw-policy-list`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policyList.exitCode, resultText(policyList)).toBe(0);
  expect(resultText(policyList)).toMatch(
    new RegExp(`^[ \\t]+- ${BASELINE_EXCLUSION_KEY} \\(active\\)`, "m"),
  );

  const livePolicy = await sandbox.openshell(["policy", "get", "--base", sandboxName], {
    artifactName: `${artifactPrefix}-openshell-policy-get-base`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(livePolicy.exitCode, resultText(livePolicy)).toBe(0);
  expect(resultText(livePolicy)).toMatch(/^[ \t]+managed_inference:/m);
  expect(resultText(livePolicy)).not.toMatch(new RegExp(`^[ \\t]+${BASELINE_EXCLUSION_KEY}:`, "m"));
}

function firstSnapshotTimestamp(listOutput: string): string {
  const match = listOutput.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z/);
  if (!match)
    throw new Error(`Failed to parse snapshot timestamp from list output:\n${listOutput}`);
  return match[0];
}

function snapshotManifestDirectories(): string[] {
  return fs
    .readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(BACKUP_DIR, entry.name, "rebuild-manifest.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

test("snapshot commands preserve create/list/latest restore/targeted restore/no-leak lifecycle", {
  timeout: LIVE_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "confirm Docker and start hermetic inference",
      "onboard the snapshot sandbox",
      "create and list the first snapshot",
      "restore the first snapshot into a clone",
      "verify the restored clone state and gateway pairing",
      "create a second snapshot from changed workspace",
      "restore latest and timestamped snapshots",
      "audit snapshot credentials and command help",
      "back up a stopped sandbox and restore its snapshot",
      "back up protected credentials and restore Shields",
      "record snapshot lifecycle evidence",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, skip }) => {
  await artifacts.target.declare({
    id: "snapshot-commands",
    boundary: "install.sh + nemoclaw snapshot commands + openshell sandbox exec",
    sandboxName: SANDBOX_NAME,
    backupDir: BACKUP_DIR,
    contracts: [
      "install.sh onboards a live OpenClaw sandbox",
      "onboard authenticates to a hermetic compatible inference endpoint",
      "snapshot create reports Snapshot v<N> created",
      "snapshot list shows versioned snapshots and parseable timestamps",
      "baseline exclusions remain active in registry and live policy across rebuild",
      "snapshot restore --to carries baseline exclusions into clone registry and live policy",
      "snapshot restore --to returns only after restored gateway pairing is authenticated",
      "latest snapshot restore recovers latest workspace state",
      "timestamp-targeted restore recovers the first snapshot state",
      "snapshot directory excludes credential-bearing env/json files",
      "snapshot help advertises create/list/restore",
      "strict backup-all starts a stopped Docker sandbox, creates a snapshot, and returns it to exited state",
      "backup-all stores a sanitized copy of root-owned credentials, restores Shields UP, and does not store the API key",
    ],
  });

  const dockerInfo = await host.command("docker", ["info"], {
    artifactName: "phase-0-docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (dockerInfo.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for snapshot commands E2E: ${resultText(dockerInfo)}`);
    }
    skip(`Docker is required for snapshot commands E2E: ${resultText(dockerInfo)}`);
  }

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

  const authenticatedInference = await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -fsS --max-time 60 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data '${JSON.stringify(
        {
          model: INFERENCE_MODEL,
          messages: [{ role: "user", content: "reply with OK" }],
          max_tokens: 8,
        },
      )}'`,
    ),
    {
      artifactName: "phase-1-authenticated-inference-post",
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(
    authenticatedInference.exitCode,
    `${authenticatedInference.stdout}\n${authenticatedInference.stderr}`,
  ).toBe(0);
  expect(inference.requests()).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      model: INFERENCE_MODEL,
      path: "/v1/chat/completions",
    }),
  );

  const cliProbe = await host.command(
    "bash",
    ["-lc", "command -v nemoclaw && command -v openshell"],
    {
      artifactName: "phase-1-cli-probe",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);
  expect(cliProbe.stdout).toContain("nemoclaw");
  expect(cliProbe.stdout).toContain("openshell");

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
  await expectBaselineExclusionAgreement(host, sandbox, SANDBOX_NAME, "phase-2-after-exclude");

  const rebuild = await host.command("nemoclaw", [SANDBOX_NAME, "rebuild", "--yes"], {
    artifactName: "phase-2-rebuild-with-baseline-exclusion",
    env: commandEnv(),
    timeoutMs: 15 * 60_000,
  });
  expect(rebuild.exitCode, resultText(rebuild)).toBe(0);
  await expectBaselineExclusionAgreement(host, sandbox, SANDBOX_NAME, "phase-2-after-rebuild");

  const markerContent = `SNAPSHOT_E2E_${Date.now()}`;
  const secondContent = `SNAPSHOT_E2E_SECOND_${Date.now()}`;

  const writeMarker = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      `mkdir -p /sandbox/.openclaw/workspace && printf '%s' '${markerContent}' > ${MARKER_FILE}`,
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

  progress.phase("create and list the first snapshot");
  const firstCreate = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot", "create"], {
    artifactName: "phase-3-snapshot-create-first",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(firstCreate.exitCode, resultText(firstCreate)).toBe(0);
  expect(resultText(firstCreate)).toMatch(/Snapshot v\d+.*created/);
  expect(resultText(firstCreate)).toContain("rebuild-backups");

  const list = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot", "list"], {
    artifactName: "phase-4-snapshot-list",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(list.exitCode, resultText(list)).toBe(0);
  expect(resultText(list)).toContain("snapshot(s)");
  const timestamp = firstSnapshotTimestamp(resultText(list));
  await artifacts.writeJson("phase-4-first-snapshot.json", { timestamp });

  progress.phase("restore the first snapshot into a clone");
  const cloneRestore = await host.command(
    "nemoclaw",
    [SANDBOX_NAME, "snapshot", "restore", timestamp, "--to", CLONE_SANDBOX_NAME, "--yes"],
    {
      artifactName: "phase-4-snapshot-restore-to-clone",
      env: commandEnv(),
      timeoutMs: 5 * 60_000,
    },
  );
  const cloneRestoreResult = classifySnapshotRestoreResult(cloneRestore);
  expect(["restored", "restored-pairing-unverified"]).toContain(cloneRestoreResult);
  progress.phase("verify the restored clone state and gateway pairing");
  expect(cloneRestoreResult).toBe("restored");
  await expectSandboxFileContent(
    sandbox,
    CLONE_SANDBOX_NAME,
    MARKER_FILE,
    markerContent,
    "phase-4-read-clone-marker",
  );
  await expectBaselineExclusionAgreement(
    host,
    sandbox,
    CLONE_SANDBOX_NAME,
    "phase-4-clone-baseline-exclusion",
  );
  const clonePairingRequestOffset = inference.requests().length;
  await expectAuthenticatedGatewayPairing(
    sandbox,
    CLONE_SANDBOX_NAME,
    inferenceConfig,
    "phase-4-verify-clone-gateway-pairing",
  );
  expect(inference.requests().slice(clonePairingRequestOffset)).toContainEqual(
    expect.objectContaining({
      auth: "ok",
      model: INFERENCE_MODEL,
      path: "/v1/chat/completions",
    }),
  );
  const destroyClone = await host.command("nemoclaw", [CLONE_SANDBOX_NAME, "destroy", "--yes"], {
    artifactName: "phase-4-destroy-clone",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(destroyClone.exitCode, resultText(destroyClone)).toBe(0);

  progress.phase("create a second snapshot from changed workspace");
  const modify = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", `rm -f ${MARKER_FILE} && printf '%s' '${secondContent}' > ${SECOND_MARKER}`],
    {
      artifactName: "phase-5-modify-workspace",
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(modify.exitCode, resultText(modify)).toBe(0);

  const firstGone = await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", `test ! -e ${MARKER_FILE}`], {
    artifactName: "phase-5-first-marker-gone",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(firstGone.exitCode, resultText(firstGone)).toBe(0);

  const secondCreate = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot", "create"], {
    artifactName: "phase-5-snapshot-create-second",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(secondCreate.exitCode, resultText(secondCreate)).toBe(0);
  expect(resultText(secondCreate)).toMatch(/Snapshot v\d+.*created/);

  const perturb = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", `rm -f ${SECOND_MARKER} && printf '%s' 'BROKEN' > ${MARKER_FILE}`],
    {
      artifactName: "phase-5-perturb-workspace",
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(perturb.exitCode, resultText(perturb)).toBe(0);

  progress.phase("restore latest and timestamped snapshots");
  const latestRestore = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot", "restore"], {
    artifactName: "phase-6-snapshot-restore-latest",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(classifySnapshotRestoreResult(latestRestore)).toBe("restored");
  await expectSandboxFileContent(
    sandbox,
    SANDBOX_NAME,
    SECOND_MARKER,
    secondContent,
    "phase-6-read-second-marker-after-latest-restore",
  );
  const firstGoneAfterLatest = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", `test ! -e ${MARKER_FILE}`],
    {
      artifactName: "phase-6-first-marker-absent-after-latest-restore",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(firstGoneAfterLatest.exitCode, resultText(firstGoneAfterLatest)).toBe(0);

  const targetedRestore = await host.command(
    "nemoclaw",
    [SANDBOX_NAME, "snapshot", "restore", timestamp],
    {
      artifactName: "phase-7-snapshot-restore-first-timestamp",
      env: commandEnv(),
      timeoutMs: 120_000,
    },
  );
  expect(classifySnapshotRestoreResult(targetedRestore)).toBe("restored");
  await expectSandboxFileContent(
    sandbox,
    SANDBOX_NAME,
    MARKER_FILE,
    markerContent,
    "phase-7-read-first-marker-after-targeted-restore",
  );
  const secondGone = await sandbox.exec(SANDBOX_NAME, ["sh", "-lc", `test ! -e ${SECOND_MARKER}`], {
    artifactName: "phase-7-second-marker-absent-after-targeted-restore",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(secondGone.exitCode, resultText(secondGone)).toBe(0);

  progress.phase("audit snapshot credentials and command help");
  const credentialLeaks = scanSnapshotCredentialLeaks(BACKUP_DIR);
  await artifacts.writeJson("phase-8-credential-scan.json", {
    backupDir: BACKUP_DIR,
    leakedFiles: credentialLeaks,
  });
  expect(credentialLeaks).toEqual([]);

  const help = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot"], {
    artifactName: "phase-9-snapshot-help",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(help.exitCode, resultText(help)).toBe(0);
  expect(resultText(help)).toContain("snapshot create");
  expect(resultText(help)).toContain("snapshot list");
  expect(resultText(help)).toContain("snapshot restore");

  progress.phase("back up a stopped sandbox and restore its snapshot");
  const snapshotsBeforeStoppedBackup = snapshotManifestDirectories();
  const containerLookup = await host.command(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
    ],
    {
      artifactName: "phase-10-stopped-backup-container-lookup",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(containerLookup.exitCode, resultText(containerLookup)).toBe(0);
  const containerIds = containerLookup.stdout.split(/\r?\n/).filter(Boolean);
  expect(containerIds).toHaveLength(1);
  const containerId = containerIds[0] as string;

  const stop = await host.command("docker", ["stop", containerId], {
    artifactName: "phase-10-stop-sandbox-container",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(stop.exitCode, resultText(stop)).toBe(0);

  const strictBackup = await host.command("nemoclaw", ["backup-all"], {
    artifactName: "phase-10-strict-backup-all-stopped",
    env: { ...commandEnv(), NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS: "1" },
    timeoutMs: 180_000,
  });
  expect(strictBackup.exitCode, resultText(strictBackup)).toBe(0);
  expect(resultText(strictBackup)).toContain(`Starting stopped sandbox '${SANDBOX_NAME}'`);
  expect(resultText(strictBackup)).toContain(`Returned '${SANDBOX_NAME}' to its stopped state`);
  expect(resultText(strictBackup)).toContain("1 backed up, 0 failed, 0 skipped");

  const finalContainerState = await host.command(
    "docker",
    ["inspect", "--format", "{{.State.Status}}", containerId],
    {
      artifactName: "phase-10-final-container-state",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(finalContainerState.exitCode, resultText(finalContainerState)).toBe(0);
  expect(finalContainerState.stdout.trim()).toBe("exited");

  const snapshotsAfterStoppedBackup = snapshotManifestDirectories();
  const stoppedBackupSnapshots = snapshotsAfterStoppedBackup.filter(
    (entry) => !snapshotsBeforeStoppedBackup.includes(entry),
  );
  expect(stoppedBackupSnapshots).toHaveLength(1);
  const stoppedBackupTimestamp = stoppedBackupSnapshots[0] as string;
  const stoppedBackupManifest = JSON.parse(
    fs.readFileSync(path.join(BACKUP_DIR, stoppedBackupTimestamp, "rebuild-manifest.json"), "utf8"),
  ) as { sandboxName?: unknown; backedUpDirs?: unknown };
  expect(stoppedBackupManifest.sandboxName).toBe(SANDBOX_NAME);
  expect(stoppedBackupManifest.backedUpDirs).toEqual(expect.arrayContaining(["workspace"]));

  const restart = await host.command("docker", ["start", containerId], {
    artifactName: "phase-10-restart-for-stopped-snapshot-restore",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(restart.exitCode, resultText(restart)).toBe(0);
  const waitForExec = await host.command(
    "bash",
    [
      "-lc",
      'name="$1"; for _i in $(seq 1 30); do openshell sandbox exec --name "$name" -- true >/dev/null 2>&1 && exit 0; sleep 2; done; openshell sandbox exec --name "$name" -- true',
      "wait-for-sandbox-exec",
      SANDBOX_NAME,
    ],
    {
      artifactName: "phase-10-wait-for-restarted-sandbox-exec",
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(waitForExec.exitCode, resultText(waitForExec)).toBe(0);
  const perturbAfterStoppedBackup = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", `printf '%s' 'BROKEN_AFTER_STOPPED_BACKUP' > ${MARKER_FILE}`],
    {
      artifactName: "phase-10-perturb-after-stopped-backup",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(perturbAfterStoppedBackup.exitCode, resultText(perturbAfterStoppedBackup)).toBe(0);
  const restoreStoppedBackup = await host.command(
    "nemoclaw",
    [SANDBOX_NAME, "snapshot", "restore", stoppedBackupTimestamp],
    {
      artifactName: "phase-10-restore-stopped-backup",
      env: commandEnv(),
      timeoutMs: 120_000,
    },
  );
  expect(classifySnapshotRestoreResult(restoreStoppedBackup)).toBe("restored");
  await expectSandboxFileContent(
    sandbox,
    SANDBOX_NAME,
    MARKER_FILE,
    markerContent,
    "phase-10-read-marker-after-stopped-backup-restore",
  );
  expect(scanSnapshotCredentialLeaks(BACKUP_DIR)).toEqual([]);
  await artifacts.writeJson("phase-10-stopped-backup-proof.json", {
    containerId,
    finalContainerState: finalContainerState.stdout.trim(),
    stoppedBackupTimestamp,
  });

  progress.phase("back up protected credentials and restore Shields");
  const writeProtectedCredential = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      'mkdir -p "$1" && printf %s "$2" >"$3"',
      "write-protected-credential",
      PROTECTED_CREDENTIALS_DIR,
      PROTECTED_CREDENTIAL_FIXTURE,
      PROTECTED_CREDENTIAL_FILE,
    ],
    {
      artifactName: "phase-11-write-protected-credential",
      env: commandEnv(),
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 30_000,
    },
  );
  expect(writeProtectedCredential.exitCode, resultText(writeProtectedCredential)).toBe(0);

  const lockForProtectedBackup = await host.command("nemoclaw", [SANDBOX_NAME, "shields", "up"], {
    artifactName: "phase-11-shields-up-before-protected-backup",
    env: commandEnv(),
    redactionValues: [INFERENCE_API_KEY],
    timeoutMs: 120_000,
  });
  expect(lockForProtectedBackup.exitCode, resultText(lockForProtectedBackup)).toBe(0);
  expect(resultText(lockForProtectedBackup)).toContain("Lockdown active");
  cleanup.trackDisposable(`restore Shields UP for ${SANDBOX_NAME} before destroy`, async () => {
    const restore = await host.command("nemoclaw", [SANDBOX_NAME, "shields", "up"], {
      artifactName: "cleanup-shields-up-after-protected-backup",
      env: commandEnv(),
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 120_000,
    });
    expect(restore.exitCode, resultText(restore)).toBe(0);
    expect(resultText(restore)).toMatch(/Lockdown (?:is already )?active/);
  });
  await expectShieldsUp(host, "phase-11-shields-status-before-protected-backup");

  const protectedDirBeforeBackup = await rootSandboxPathMetadata(
    host,
    containerId,
    PROTECTED_CREDENTIALS_DIR,
    "phase-11-protected-credentials-dir-before-backup",
  );
  expect(protectedDirBeforeBackup).toEqual({ mode: "700", owner: "root:root" });
  const protectedFileBeforeBackup = await rootSandboxPathMetadata(
    host,
    containerId,
    PROTECTED_CREDENTIAL_FILE,
    "phase-11-protected-credential-file-before-backup",
  );
  expect(protectedFileBeforeBackup).toEqual({ mode: "600", owner: "root:root" });

  const unreadableBeforeBackup = await sandbox.exec(
    SANDBOX_NAME,
    ["cat", PROTECTED_CREDENTIAL_FILE],
    {
      artifactName: "phase-11-protected-credential-unreadable-before-backup",
      env: commandEnv(),
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 30_000,
    },
  );
  expect(unreadableBeforeBackup.exitCode, resultText(unreadableBeforeBackup)).not.toBe(0);
  expect(resultText(unreadableBeforeBackup)).not.toContain(INFERENCE_API_KEY);

  const snapshotsBeforeProtectedBackup = snapshotManifestDirectories();
  const protectedBackup = await host.command("nemoclaw", ["backup-all"], {
    artifactName: "phase-11-backup-all-protected-credentials",
    env: { ...commandEnv(), NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS: "1" },
    redactionValues: [INFERENCE_API_KEY],
    timeoutMs: 180_000,
  });
  expect(protectedBackup.exitCode, resultText(protectedBackup)).toBe(0);
  expect(resultText(protectedBackup)).toContain("Shields are UP");
  expect(resultText(protectedBackup)).toContain("temporarily unlocking for backup-all");
  expect(resultText(protectedBackup)).toContain("Re-applying shields lockdown");
  expect(resultText(protectedBackup)).toContain("Shields restored to UP");
  expect(resultText(protectedBackup)).toContain("1 backed up, 0 failed, 0 skipped");

  const snapshotsAfterProtectedBackup = snapshotManifestDirectories();
  const protectedBackupSnapshots = snapshotsAfterProtectedBackup.filter(
    (entry) => !snapshotsBeforeProtectedBackup.includes(entry),
  );
  expect(protectedBackupSnapshots).toHaveLength(1);
  const protectedBackupTimestamp = protectedBackupSnapshots[0] as string;
  const protectedBackupPath = path.join(BACKUP_DIR, protectedBackupTimestamp);
  const protectedBackupManifest = JSON.parse(
    fs.readFileSync(path.join(protectedBackupPath, "rebuild-manifest.json"), "utf8"),
  ) as { sandboxName?: unknown; backedUpDirs?: unknown };
  expect(protectedBackupManifest.sandboxName).toBe(SANDBOX_NAME);
  expect(protectedBackupManifest.backedUpDirs).toEqual(
    expect.arrayContaining(["credentials", "workspace"]),
  );
  expect(fs.existsSync(path.join(protectedBackupPath, "openclaw.json"))).toBe(true);
  expect(
    fs.readFileSync(
      path.join(protectedBackupPath, "workspace", path.basename(MARKER_FILE)),
      "utf8",
    ),
  ).toBe(markerContent);

  const backedUpCredentialPath = path.join(
    protectedBackupPath,
    "credentials",
    path.basename(PROTECTED_CREDENTIAL_FILE),
  );
  const backedUpCredentialText = fs.readFileSync(backedUpCredentialPath, "utf8");
  const backedUpCredential = JSON.parse(backedUpCredentialText) as {
    apiKey?: unknown;
    marker?: unknown;
  };
  expect(backedUpCredential.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
  expect(backedUpCredential.marker).toBe(PROTECTED_CREDENTIAL_MARKER);
  expect(backedUpCredentialText).not.toContain(INFERENCE_API_KEY);
  expect(scanSnapshotCredentialLeaks(protectedBackupPath)).toEqual([]);

  await expectShieldsUp(host, "phase-11-shields-status-after-protected-backup");
  expect(
    await rootSandboxPathMetadata(
      host,
      containerId,
      PROTECTED_CREDENTIALS_DIR,
      "phase-11-protected-credentials-dir-after-backup",
    ),
  ).toEqual({ mode: "700", owner: "root:root" });
  expect(
    await rootSandboxPathMetadata(
      host,
      containerId,
      PROTECTED_CREDENTIAL_FILE,
      "phase-11-protected-credential-file-after-backup",
    ),
  ).toEqual({ mode: "600", owner: "root:root" });
  const unreadableAfterBackup = await sandbox.exec(
    SANDBOX_NAME,
    ["cat", PROTECTED_CREDENTIAL_FILE],
    {
      artifactName: "phase-11-protected-credential-unreadable-after-backup",
      env: commandEnv(),
      redactionValues: [INFERENCE_API_KEY],
      timeoutMs: 30_000,
    },
  );
  expect(unreadableAfterBackup.exitCode, resultText(unreadableAfterBackup)).not.toBe(0);
  expect(resultText(unreadableAfterBackup)).not.toContain(INFERENCE_API_KEY);
  expect(fs.existsSync(SHIELDS_TIMER_FILE)).toBe(false);

  progress.phase("record snapshot lifecycle evidence");
  await artifacts.target.complete({
    id: "snapshot-commands",
    status: "passed",
    firstSnapshotTimestamp: timestamp,
    baselineExclusionKey: BASELINE_EXCLUSION_KEY,
    cloneSandboxName: CLONE_SANDBOX_NAME,
    stoppedBackupTimestamp,
    protectedBackupTimestamp,
    backupDir: BACKUP_DIR,
  });
});
