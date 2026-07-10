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
  type SnapshotInferenceFixture,
} from "./snapshot-commands-helpers.ts";
import { scanSnapshotCredentialLeaks } from "./snapshot-credential-scanner.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-snapshot";
validateSandboxName(SANDBOX_NAME);
const BACKUP_ROOT = path.join(os.homedir(), ".nemoclaw", "rebuild-backups");
const BACKUP_DIR = path.resolve(BACKUP_ROOT, SANDBOX_NAME);
if (!BACKUP_DIR.startsWith(`${path.resolve(BACKUP_ROOT)}${path.sep}`)) {
  throw new Error(`snapshot backup directory escaped rebuild-backups root: ${BACKUP_DIR}`);
}
const MARKER_FILE = "/sandbox/.openclaw/workspace/snapshot-marker.txt";
const SECOND_MARKER = "/sandbox/.openclaw/workspace/snapshot-marker-2.txt";
const LIVE_TIMEOUT_MS = 30 * 60_000;
const INFERENCE_API_KEY = "nvapi-snapshot-commands-fixture-credential";
const INFERENCE_MODEL = "snapshot-commands-model";

function commandEnv(inference?: SnapshotInferenceFixture): NodeJS.ProcessEnv {
  return buildSnapshotCommandEnv(SANDBOX_NAME, inference);
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Mirrors the legacy teardown: cleanup attempts should not hide the main failure.
  }
}

async function cleanupSnapshotSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  label: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("nemoclaw", [SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: `${label}-nemoclaw-destroy`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: `${label}-openshell-sandbox-delete`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${label}-openshell-gateway-destroy`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

async function expectSandboxFileContent(
  sandbox: SandboxClient,
  filePath: string,
  expected: string,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(SANDBOX_NAME, ["cat", filePath], {
    artifactName,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
}

function firstSnapshotTimestamp(listOutput: string): string {
  const match = listOutput.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z/);
  if (!match)
    throw new Error(`Failed to parse snapshot timestamp from list output:\n${listOutput}`);
  return match[0];
}

test("snapshot commands preserve create/list/latest restore/targeted restore/no-leak lifecycle", {
  timeout: LIVE_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, sandbox, skip }) => {
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
      "latest snapshot restore recovers latest workspace state",
      "timestamp-targeted restore recovers the first snapshot state",
      "snapshot directory excludes credential-bearing env/json files",
      "snapshot help advertises create/list/restore",
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
    publicHost: "host.openshell.internal",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.add("close snapshot commands compatible inference fixture", async () => {
    await artifacts.writeJson("compatible-inference-requests.json", inference.requests());
    await inference.close();
  });
  const inferenceConfig = {
    apiKey: INFERENCE_API_KEY,
    endpointUrl: inference.baseUrl,
    model: INFERENCE_MODEL,
  };

  cleanup.add(`destroy snapshot sandbox ${SANDBOX_NAME}`, () =>
    cleanupSnapshotSandbox(host, sandbox, "cleanup"),
  );

  await cleanupSnapshotSandbox(host, sandbox, "pre-cleanup");
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

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
  await expectSandboxFileContent(sandbox, MARKER_FILE, markerContent, "phase-2-read-marker");

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

  const latestRestore = await host.command("nemoclaw", [SANDBOX_NAME, "snapshot", "restore"], {
    artifactName: "phase-6-snapshot-restore-latest",
    env: commandEnv(),
    timeoutMs: 120_000,
  });
  expect(latestRestore.exitCode, resultText(latestRestore)).toBe(0);
  expect(resultText(latestRestore)).toContain("Restored");
  await expectSandboxFileContent(
    sandbox,
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
  expect(targetedRestore.exitCode, resultText(targetedRestore)).toBe(0);
  expect(resultText(targetedRestore)).toContain("Restored");
  await expectSandboxFileContent(
    sandbox,
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

  await artifacts.target.complete({
    id: "snapshot-commands",
    status: "passed",
    firstSnapshotTimestamp: timestamp,
    backupDir: BACKUP_DIR,
  });
});
