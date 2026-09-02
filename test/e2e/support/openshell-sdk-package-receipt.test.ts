// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadBoundArtifact } from "../../../tools/e2e/exact-artifact-download.mts";
import {
  createOpenShellSdkProducerReceipt,
  parseOpenShellSdkProducerReceipt,
  resolveOpenShellSdkPackage,
  type OpenShellSdkProducerReceipt,
} from "../../../tools/e2e/openshell-sdk-package-receipt.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const STALE_BASE_SHA = "c".repeat(40);
const RUN_ID = 33_569_186_269;
const RUN_ATTEMPT = 2;
const PR_NUMBER = 10_790;
const WORKFLOW_ID = 1234;
const REPOSITORY = "NVIDIA/NemoClaw";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sdk-receipt-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function producerReceipt(): OpenShellSdkProducerReceipt {
  const directory = temporaryDirectory();
  const archivePath = path.join(directory, "reviewed-sdk.tgz");
  fs.writeFileSync(archivePath, "reviewed SDK package");
  return createOpenShellSdkProducerReceipt({
    archivePath,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    checkedOutSha: BASE_SHA,
    pullRequest: PR_NUMBER,
    runAttempt: RUN_ATTEMPT,
    runId: RUN_ID,
    workflowSha: BASE_SHA,
  });
}

function workflowRun(id = RUN_ID): Record<string, unknown> {
  return {
    id,
    workflow_id: WORKFLOW_ID,
    run_attempt: RUN_ATTEMPT,
    path: ".github/workflows/openshell-sdk-package-pr.yaml",
    event: "pull_request_target",
    head_sha: CANDIDATE_SHA,
    display_title: `OpenShell SDK PR #${PR_NUMBER} head ${CANDIDATE_SHA} base ${BASE_SHA}`,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    pull_requests: [
      {
        number: PR_NUMBER,
        head: { sha: CANDIDATE_SHA },
        // GitHub can retain an older base here after the run tested a newer base.
        base: { sha: STALE_BASE_SHA },
      },
    ],
    status: "completed",
    conclusion: "success",
  };
}

function resolverFixture(
  options: {
    artifactDigest?: string;
    receipt?: OpenShellSdkProducerReceipt;
    runs?: Record<string, unknown>[];
  } = {},
) {
  const receipt = options.receipt ?? producerReceipt();
  const packageBytes = fs.readFileSync(
    path.join(temporaryDirectories.at(-1)!, receipt.package.fileName),
  );
  const archive = artifactZip([
    { name: receipt.package.fileName, contents: packageBytes.toString("utf8") },
    { name: "receipt.json", contents: `${JSON.stringify(receipt)}\n` },
  ]);
  const artifactName = `openshell-sdk-${CANDIDATE_SHA}-${RUN_ID}-${RUN_ATTEMPT}`;
  const artifactId = 9001;
  const runs = options.runs ?? [workflowRun()];
  const runsPath = `/repos/${REPOSITORY}/actions/workflows/openshell-sdk-package-pr.yaml/runs?event=pull_request_target&head_sha=${CANDIDATE_SHA}&per_page=100&page=1`;
  const responses = new Map<string, unknown>([
    [
      `/repos/${REPOSITORY}/pulls/${PR_NUMBER}`,
      {
        number: PR_NUMBER,
        state: "open",
        head: { sha: CANDIDATE_SHA },
        base: { sha: BASE_SHA },
      },
    ],
    [
      `/repos/${REPOSITORY}/actions/workflows/openshell-sdk-package-pr.yaml`,
      {
        id: WORKFLOW_ID,
        name: "Security / Package OpenShell SDK for PR",
        path: ".github/workflows/openshell-sdk-package-pr.yaml",
        state: "active",
      },
    ],
    [runsPath, { total_count: runs.length, workflow_runs: runs }],
    [
      `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
      {
        total_count: 1,
        artifacts: [
          {
            id: artifactId,
            name: artifactName,
            expired: false,
            size_in_bytes: archive.length,
            digest:
              options.artifactDigest ??
              `sha256:${createHash("sha256").update(archive).digest("hex")}`,
            archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`,
            workflow_run: { id: RUN_ID, head_sha: CANDIDATE_SHA },
          },
        ],
      },
    ],
  ]);
  return {
    archive,
    request: async (requestPath: string): Promise<unknown> => {
      expect(responses.has(requestPath), `unexpected request ${requestPath}`).toBe(true);
      return responses.get(requestPath);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenShell SDK producer receipts", () => {
  it("records the independent digest and size of a stable regular package", () => {
    const directory = temporaryDirectory();
    const archivePath = path.join(directory, "reviewed-sdk.tgz");
    const packageBytes = Buffer.from("reviewed SDK package");
    fs.writeFileSync(archivePath, packageBytes);

    const receipt = createOpenShellSdkProducerReceipt({
      archivePath,
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      checkedOutSha: BASE_SHA,
      pullRequest: PR_NUMBER,
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      workflowSha: BASE_SHA,
    });

    expect(receipt.package).toEqual({
      fileName: "reviewed-sdk.tgz",
      digest: `sha256:${createHash("sha256").update(packageBytes).digest("hex")}`,
      size: packageBytes.length,
    });
  });

  it("rejects a symlinked package path", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, "target-sdk.tgz");
    const archivePath = path.join(directory, "reviewed-sdk.tgz");
    fs.writeFileSync(targetPath, "reviewed SDK package");
    fs.symlinkSync(targetPath, archivePath);

    expect(() =>
      createOpenShellSdkProducerReceipt({
        archivePath,
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        checkedOutSha: BASE_SHA,
        pullRequest: PR_NUMBER,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("regular non-symlink file");
  });

  it("rejects a non-regular package path", () => {
    const directory = temporaryDirectory();
    const archivePath = path.join(directory, "reviewed-sdk.tgz");
    fs.mkdirSync(archivePath);

    expect(() =>
      createOpenShellSdkProducerReceipt({
        archivePath,
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        checkedOutSha: BASE_SHA,
        pullRequest: PR_NUMBER,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("regular non-symlink file");
  });

  it("rejects a package path replaced after its descriptor opens", () => {
    const directory = temporaryDirectory();
    const archivePath = path.join(directory, "reviewed-sdk.tgz");
    const originalPath = path.join(directory, "original-sdk.tgz");
    fs.writeFileSync(archivePath, "reviewed SDK package");
    const realOpen: typeof fs.openSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation(((target, flags, mode) => {
      const descriptor = realOpen(target, flags, mode);
      fs.renameSync(archivePath, originalPath);
      fs.writeFileSync(archivePath, "replacement package");
      return descriptor;
    }) as typeof fs.openSync);

    expect(() =>
      createOpenShellSdkProducerReceipt({
        archivePath,
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        checkedOutSha: BASE_SHA,
        pullRequest: PR_NUMBER,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("regular non-symlink file");
  });

  it("selects a receipt when GitHub retains stale PR base metadata", async () => {
    const fixture = resolverFixture();
    const output = temporaryDirectory();
    const selectionPath = path.join(temporaryDirectory(), "selection.json");

    const selection = await resolveOpenShellSdkPackage(
      {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        outputDirectory: output,
        pullRequest: PR_NUMBER,
        selectionPath,
        token: "test-token",
      },
      {
        request: fixture.request,
        downloadArtifact: async () => fixture.archive,
        waitMilliseconds: 0,
      },
    );

    expect(selection.base.sha).toBe(BASE_SHA);
    expect(selection.workflow.sha).toBe(BASE_SHA);
    expect(selection.run).toEqual({ id: RUN_ID, attempt: RUN_ATTEMPT });
    expect(selection.artifact.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(fs.readFileSync(path.join(output, "reviewed-sdk.tgz"), "utf8")).toBe(
      "reviewed SDK package",
    );
  });

  it("ignores a successful producer for the same head on a different base", async () => {
    const differentBaseRun = workflowRun(RUN_ID + 1);
    differentBaseRun.display_title = `OpenShell SDK PR #${PR_NUMBER} head ${CANDIDATE_SHA} base ${STALE_BASE_SHA}`;
    const fixture = resolverFixture({ runs: [differentBaseRun, workflowRun()] });

    const selection = await resolveOpenShellSdkPackage(
      {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        outputDirectory: temporaryDirectory(),
        pullRequest: PR_NUMBER,
        selectionPath: path.join(temporaryDirectory(), "selection.json"),
        token: "test-token",
      },
      {
        request: fixture.request,
        downloadArtifact: async () => fixture.archive,
        waitMilliseconds: 0,
      },
    );

    expect(selection.run).toEqual({ id: RUN_ID, attempt: RUN_ATTEMPT });
  });

  it.each([
    ["candidate", { candidate: { repository: REPOSITORY, sha: "d".repeat(40) } }],
    ["base", { base: { repository: REPOSITORY, sha: "d".repeat(40) } }],
    [
      "workflow source",
      {
        workflow: {
          repository: REPOSITORY,
          path: ".github/workflows/openshell-sdk-package-pr.yaml",
          sha: "d".repeat(40),
        },
      },
    ],
    ["run attempt", { run: { id: RUN_ID, attempt: RUN_ATTEMPT + 1 } }],
  ])("rejects a mismatched %s receipt", (_field, replacement) => {
    const receipt = { ...producerReceipt(), ...replacement };
    expect(() =>
      parseOpenShellSdkProducerReceipt(receipt, {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        pullRequest: PR_NUMBER,
        runAttempt: RUN_ATTEMPT,
        runId: RUN_ID,
      }),
    ).toThrow();
  });

  it("rejects two successful producers for the same candidate", async () => {
    const fixture = resolverFixture({ runs: [workflowRun(), workflowRun(RUN_ID + 1)] });
    await expect(
      resolveOpenShellSdkPackage(
        {
          baseSha: BASE_SHA,
          candidateSha: CANDIDATE_SHA,
          outputDirectory: temporaryDirectory(),
          pullRequest: PR_NUMBER,
          selectionPath: path.join(temporaryDirectory(), "selection.json"),
          token: "test-token",
        },
        {
          request: fixture.request,
          downloadArtifact: async () => fixture.archive,
          waitMilliseconds: 0,
        },
      ),
    ).rejects.toThrow("ambiguous");
  });

  it("rejects a missing producer", async () => {
    const fixture = resolverFixture({ runs: [] });
    await expect(
      resolveOpenShellSdkPackage(
        {
          baseSha: BASE_SHA,
          candidateSha: CANDIDATE_SHA,
          outputDirectory: temporaryDirectory(),
          pullRequest: PR_NUMBER,
          selectionPath: path.join(temporaryDirectory(), "selection.json"),
          token: "test-token",
        },
        { request: fixture.request, waitMilliseconds: 0 },
      ),
    ).rejects.toThrow("missing");
  });

  it("rejects artifact bytes that do not match GitHub's digest", async () => {
    const fixture = resolverFixture({ artifactDigest: `sha256:${"f".repeat(64)}` });
    await expect(
      resolveOpenShellSdkPackage(
        {
          baseSha: BASE_SHA,
          candidateSha: CANDIDATE_SHA,
          outputDirectory: temporaryDirectory(),
          pullRequest: PR_NUMBER,
          selectionPath: path.join(temporaryDirectory(), "selection.json"),
          token: "test-token",
        },
        {
          request: fixture.request,
          waitMilliseconds: 0,
          downloadArtifact: (identity) =>
            downloadBoundArtifact(identity, "test-token", {
              attempts: 1,
              fetchImpl: async () =>
                new Response(new Uint8Array(fixture.archive), {
                  status: 200,
                  headers: { "content-length": String(fixture.archive.length) },
                }),
            }),
        },
      ),
    ).rejects.toThrow("digest");
  });
});
