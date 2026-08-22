// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  collectNativeRuntimeQualificationEvidence,
  NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW,
  NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE,
  type GitHubQualificationReader,
  type NativeRuntimeQualificationCollectorInput,
} from "../../../tools/e2e/native-runtime-qualification-collector.mts";
import { artifactZip } from "../../helpers/artifact-zip";
import {
  nativeQualificationEvidence,
  nativeQualificationExpectedSource,
  NATIVE_QUALIFICATION_BASE_SHA,
  NATIVE_QUALIFICATION_HEAD_SHA,
  NATIVE_QUALIFICATION_RECEIPT_CONTENT,
} from "../../helpers/native-runtime-qualification-evidence";
import type { NativeRuntimeQualificationEvidenceEnvelope } from "../registry/native-runtime-qualification";

const REPOSITORY = "NVIDIA/NemoClaw";
const ACTOR = "maintainer";
const WORKFLOW = ".github/workflows/e2e.yaml";
const JOB_NAME = "Aggregate native runtime qualification evidence";
const ARTIFACT_NAME = "native-runtime-qualification-9143";

function collectorInput(
  overrides: Partial<NativeRuntimeQualificationCollectorInput> = {},
): NativeRuntimeQualificationCollectorInput {
  return {
    repository: REPOSITORY,
    actor: ACTOR,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    collectorWorkflowRef: `${REPOSITORY}/${NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW}@refs/heads/main`,
    collectorWorkflowSha: NATIVE_QUALIFICATION_BASE_SHA,
    collectorRunId: 6001,
    providerId: "podman",
    pullRequestNumber: 9143,
    expectedHeadSha: NATIVE_QUALIFICATION_HEAD_SHA,
    expectedBaseSha: NATIVE_QUALIFICATION_BASE_SHA,
    evidenceWorkflow: WORKFLOW,
    evidenceRunId: 7001,
    evidenceJobName: JOB_NAME,
    evidenceArtifactName: ARTIFACT_NAME,
    ...overrides,
  };
}

type ReceiptArchiveOptions = {
  readonly omitReceipt?: string;
  readonly tamperReceipt?: string;
};

function receiptPaths(envelope: NativeRuntimeQualificationEvidenceEnvelope): string[] {
  return [
    ...new Set(
      envelope.cases.flatMap((entry) => [
        entry.installer.invocation.path,
        entry.installer.script.path,
        entry.runtime.result.path,
        ...entry.operations.map(({ artifact }) => artifact.path),
        ...(entry.nvidiaCdi ? [entry.nvidiaCdi.artifact.path] : []),
      ]),
    ),
  ];
}

function archiveFor(
  value: NativeRuntimeQualificationEvidenceEnvelope,
  options: ReceiptArchiveOptions = {},
): Buffer {
  const receipts = receiptPaths(value)
    .filter((receiptPath) => receiptPath !== options.omitReceipt)
    .map((receiptPath) => ({
      name: receiptPath,
      contents:
        receiptPath === options.tamperReceipt
          ? '{"qualified":false}\n'
          : NATIVE_QUALIFICATION_RECEIPT_CONTENT,
    }));
  return artifactZip([
    { name: NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE, contents: JSON.stringify(value) },
    ...receipts,
  ]);
}

function githubFixture(
  value: NativeRuntimeQualificationEvidenceEnvelope = nativeQualificationEvidence(),
  archiveOptions: ReceiptArchiveOptions = {},
): {
  readonly api: GitHubQualificationReader;
  readonly archive: Buffer;
  readonly json: Map<string, unknown>;
  readonly jsonSequences: Map<string, unknown[]>;
} {
  const archive = archiveFor(value, archiveOptions);
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const pull = {
    number: 9143,
    state: "open",
    head: { sha: NATIVE_QUALIFICATION_HEAD_SHA, repo: { full_name: REPOSITORY } },
    base: {
      sha: NATIVE_QUALIFICATION_BASE_SHA,
      ref: "main",
      repo: { full_name: REPOSITORY },
    },
  };
  const run = {
    id: 7001,
    workflow_id: 101,
    run_attempt: 2,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_sha: NATIVE_QUALIFICATION_BASE_SHA,
    head_branch: "main",
    path: WORKFLOW,
    repository: { full_name: REPOSITORY },
  };
  const artifact = {
    id: 9001,
    name: ARTIFACT_NAME,
    size_in_bytes: archive.length,
    expired: false,
    digest,
    archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/9001/zip`,
    workflow_run: { id: 7001, head_sha: NATIVE_QUALIFICATION_BASE_SHA },
  };
  const json = new Map<string, unknown>([
    [
      `repos/${REPOSITORY}/collaborators/${ACTOR}/permission`,
      { user: { login: ACTOR }, permission: "maintain" },
    ],
    [`repos/${REPOSITORY}/pulls/9143`, pull],
    [`repos/${REPOSITORY}/commits/main`, { sha: NATIVE_QUALIFICATION_BASE_SHA }],
    [
      `repos/${REPOSITORY}/actions/workflows/${WORKFLOW.split("/").at(-1)!}`,
      { id: 101, path: WORKFLOW, state: "active" },
    ],
    [`repos/${REPOSITORY}/actions/runs/7001`, run],
    [
      `repos/${REPOSITORY}/actions/runs/7001/attempts/2/jobs?per_page=100&page=1`,
      {
        total_count: 1,
        jobs: [
          {
            id: 8001,
            name: JOB_NAME,
            run_id: 7001,
            run_attempt: 2,
            head_sha: NATIVE_QUALIFICATION_BASE_SHA,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    [
      `repos/${REPOSITORY}/actions/runs/7001/artifacts?per_page=100&page=1`,
      { total_count: 1, artifacts: [artifact] },
    ],
    [`repos/${REPOSITORY}/actions/artifacts/9001`, artifact],
  ]);
  const jsonSequences = new Map<string, unknown[]>();
  const getJson = vi.fn(async (apiPath: string) => {
    expect(json.has(apiPath) || jsonSequences.has(apiPath)).toBe(true);
    const value = jsonSequences.get(apiPath)?.shift() ?? json.get(apiPath);
    return structuredClone(value);
  });
  const getBytes = vi.fn(async (apiPath: string) => {
    expect(apiPath).toBe(`repos/${REPOSITORY}/actions/artifacts/9001/zip`);
    return Buffer.from(archive);
  });
  return { api: { getJson, getBytes }, archive, json, jsonSequences };
}

type QualificationFixture = ReturnType<typeof githubFixture>;

function sequenceConfirmationJson(
  fixture: QualificationFixture,
  apiPath: string,
  mutate: (confirmed: Record<string, unknown>) => void,
): void {
  const initial = structuredClone(fixture.json.get(apiPath)) as Record<string, unknown>;
  const confirmed = structuredClone(initial);
  mutate(confirmed);
  fixture.jsonSequences.set(apiPath, [initial, confirmed]);
}

function changePullHeadOnConfirmation(fixture: QualificationFixture): void {
  const apiPath = `repos/${REPOSITORY}/pulls/9143`;
  sequenceConfirmationJson(fixture, apiPath, (confirmed) => {
    (confirmed.head as { sha: string }).sha = "c".repeat(40);
  });
}

function changeMainRevisionOnConfirmation(fixture: QualificationFixture): void {
  const apiPath = `repos/${REPOSITORY}/commits/main`;
  sequenceConfirmationJson(fixture, apiPath, (confirmed) => {
    confirmed.sha = "c".repeat(40);
  });
}

function changeRunAttemptOnConfirmation(fixture: QualificationFixture): void {
  const apiPath = `repos/${REPOSITORY}/actions/runs/7001`;
  sequenceConfirmationJson(fixture, apiPath, (confirmed) => {
    confirmed.run_attempt = 3;
  });
}

function changeArtifactDigestOnConfirmation(fixture: QualificationFixture): void {
  const apiPath = `repos/${REPOSITORY}/actions/artifacts/9001`;
  const confirmed = structuredClone(fixture.json.get(apiPath)) as Record<string, unknown>;
  confirmed.digest = `sha256:${"e".repeat(64)}`;
  fixture.json.set(apiPath, confirmed);
}

const CONFIRMATION_DRIFT_CASES = [
  [
    "candidate commit",
    changePullHeadOnConfirmation,
    "candidate commit, candidate repository, target-branch base SHA",
  ],
  ["main revision", changeMainRevisionOnConfirmation, "current main SHA"],
  ["workflow run attempt", changeRunAttemptOnConfirmation, "protected source changed"],
  [
    "artifact digest",
    changeArtifactDigestOnConfirmation,
    "protected artifact changed during collection",
  ],
] as const;

describe("native runtime qualification protected evidence collector", () => {
  it("authenticates live GitHub identities and invokes the canonical evidence consumer", async () => {
    const fixture = githubFixture();
    const authority = await collectNativeRuntimeQualificationEvidence(
      fixture.api,
      collectorInput(),
    );
    const digest = `sha256:${createHash("sha256").update(fixture.archive).digest("hex")}`;

    expect(authority).toMatchObject({
      schemaVersion: 1,
      qualificationId: "podman-protected-host-local-inference",
      providerId: "podman",
      source: {
        repository: REPOSITORY,
        workflow: WORKFLOW,
        pullRequestNumber: 9143,
        headSha: NATIVE_QUALIFICATION_HEAD_SHA,
        baseSha: NATIVE_QUALIFICATION_BASE_SHA,
        runId: 7001,
        attempt: 2,
        jobId: 8001,
        artifact: { id: 9001, name: ARTIFACT_NAME, digest },
      },
    });
    expect(fixture.api.getBytes).toHaveBeenCalledOnce();
    expect(fixture.api.getJson).toHaveBeenCalledWith(`repos/${REPOSITORY}/pulls/9143`);
  });

  it.each(CONFIRMATION_DRIFT_CASES)(
    "rejects %s drift on the confirmation read",
    async (_identity, arrangeDrift, expectedError) => {
      const fixture = githubFixture();
      arrangeDrift(fixture);

      await expect(
        collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
      ).rejects.toThrow(expectedError);
    },
  );

  it.each([
    ["candidate commit", { headSha: "e".repeat(40), baseSha: "f".repeat(40) }],
    ["target-branch base SHA", { headSha: "f".repeat(40), baseSha: "e".repeat(40) }],
  ])("rejects replayed evidence with an internally consistent wrong %s", async (_name, pair) => {
    const fixture = githubFixture(nativeQualificationEvidence(pair));

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow("externally expected protected source");
  });

  it("rejects a successful run at candidate code instead of the target-branch base SHA", async () => {
    const fixture = githubFixture();
    const runPath = `repos/${REPOSITORY}/actions/runs/7001`;
    fixture.json.set(runPath, {
      ...(fixture.json.get(runPath) as Record<string, unknown>),
      head_sha: NATIVE_QUALIFICATION_HEAD_SHA,
    });

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow("workflow run identity");
  });

  it("rejects its own workflow as qualification evidence before GitHub access", async () => {
    const fixture = githubFixture();

    await expect(
      collectNativeRuntimeQualificationEvidence(
        fixture.api,
        collectorInput({
          evidenceWorkflow: NATIVE_RUNTIME_QUALIFICATION_COLLECTOR_WORKFLOW,
        }),
      ),
    ).rejects.toThrow("trusted workflow boundary");
    expect(fixture.api.getJson).not.toHaveBeenCalled();
    expect(fixture.api.getBytes).not.toHaveBeenCalled();
  });

  it("rejects an artifact whose downloaded bytes do not match GitHub's immutable digest", async () => {
    const fixture = githubFixture();
    vi.mocked(fixture.api.getBytes).mockResolvedValueOnce(
      artifactZip([
        {
          name: NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE,
          contents: JSON.stringify(nativeQualificationExpectedSource()),
        },
      ]),
    );

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow("downloaded artifact digest");
  });

  it("rejects a declared installer receipt that is absent from the authenticated artifact", async () => {
    const evidence = nativeQualificationEvidence();
    const missing = evidence.cases[0]!.installer.invocation.path;
    const fixture = githubFixture(evidence, { omitReceipt: missing });

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow(`receipt '${missing}' is missing from the authenticated artifact`);
  });

  it("rejects a declared NVIDIA CDI receipt whose bytes do not match its digest", async () => {
    const evidence = nativeQualificationEvidence();
    const gpuCase = evidence.cases.find((entry) => entry.nvidiaCdi !== undefined)!;
    const tampered = gpuCase.nvidiaCdi!.artifact.path;
    const fixture = githubFixture(evidence, { tamperReceipt: tampered });

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow(`receipt '${tampered}' does not match its SHA-256 digest`);
  });
});
