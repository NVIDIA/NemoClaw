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
} from "../../helpers/native-runtime-qualification-evidence";

const REPOSITORY = "NVIDIA/NemoClaw";
const ACTOR = "maintainer";
const WORKFLOW = ".github/workflows/native-runtime-qualification.yaml";
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

function archiveFor(value: unknown): Buffer {
  return artifactZip([
    {
      name: NATIVE_RUNTIME_QUALIFICATION_EVIDENCE_FILE,
      contents: JSON.stringify(value),
    },
  ]);
}

function githubFixture(value: unknown = nativeQualificationEvidence()): {
  readonly api: GitHubQualificationReader;
  readonly archive: Buffer;
  readonly json: Map<string, unknown>;
} {
  const archive = archiveFor(value);
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
      `repos/${REPOSITORY}/actions/workflows/native-runtime-qualification.yaml`,
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
  const getJson = vi.fn(async (apiPath: string) => {
    expect(json.has(apiPath)).toBe(true);
    return structuredClone(json.get(apiPath));
  });
  const getBytes = vi.fn(async (apiPath: string) => {
    expect(apiPath).toBe(`repos/${REPOSITORY}/actions/artifacts/9001/zip`);
    return Buffer.from(archive);
  });
  return { api: { getJson, getBytes }, archive, json };
}

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

  it.each([
    ["head", { headSha: "e".repeat(40), baseSha: "f".repeat(40) }],
    ["base", { headSha: "f".repeat(40), baseSha: "e".repeat(40) }],
  ])(
    "rejects replayed evidence with an internally consistent wrong %s identity",
    async (_name, pair) => {
      const fixture = githubFixture(nativeQualificationEvidence(pair));

      await expect(
        collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
      ).rejects.toThrow("externally expected protected source");
    },
  );

  it("rejects a successful run at candidate code instead of the trusted base", async () => {
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
      archiveFor(nativeQualificationExpectedSource()),
    );

    await expect(
      collectNativeRuntimeQualificationEvidence(fixture.api, collectorInput()),
    ).rejects.toThrow("downloaded artifact digest");
  });
});
