// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyManagedRuntimeCurrentRun,
  classifyManagedRuntimeComparison,
  createManagedRuntimeReceipt,
  parseManagedRuntimeReceipt,
  type ManagedRuntimeReceipt,
  type ManagedRuntimeRunEvidence,
} from "../../../tools/e2e/managed-runtime-comparison.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const IMAGE_REVISION = "c".repeat(40);
const CANDIDATE_RUN_ID = 33_569_187_156;
const BASE_RUN_ID = 33_600_000_001;
const RUN_ATTEMPT = 1;
const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const REPOSITORIES = {
  openclaw: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
} as const;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-comparison-"));
  temporaryDirectories.push(directory);
  return directory;
}

function catalog(revision: string): string {
  const directory = temporaryDirectory();
  const target = path.join(directory, "catalog.json");
  const value = Object.fromEntries(
    AGENTS.map((agent, index) => {
      const image = REPOSITORIES[agent];
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      return [
        agent,
        {
          contractVersion: 1,
          agent,
          platform: "linux/amd64",
          image,
          digest,
          reference: `${image}@${digest}`,
          source: {
            repository: "NVIDIA/NemoClaw",
            revision,
            release: "v0.0.116",
            cohort: "ghrun-100-1",
          },
          startupProfileContractVersion: 1,
          capabilityContractVersion: 1,
        },
      ];
    }),
  );
  fs.writeFileSync(target, JSON.stringify(value));
  return target;
}

function evidence(cleanupFailures = 0): string {
  const root = temporaryDirectory();
  const scenario = path.join(root, "managed-runtime-activation");
  fs.mkdirSync(scenario);
  fs.writeFileSync(path.join(scenario, "target.json"), '{"id":"managed-image-activation"}\n');
  fs.writeFileSync(
    path.join(scenario, "cleanup.json"),
    JSON.stringify({ passed: ["remove sandbox"], failures: Array(cleanupFailures).fill({}) }),
  );
  return root;
}

function receipt(
  role: "base" | "candidate",
  outcome: "failure" | "success" = "success",
  cleanupFailures = 0,
  runId = role === "candidate" ? CANDIDATE_RUN_ID : BASE_RUN_ID,
): ManagedRuntimeReceipt {
  const candidate = role === "candidate";
  return createManagedRuntimeReceipt({
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    catalogPath: catalog(candidate ? CANDIDATE_SHA : IMAGE_REVISION),
    evidenceDirectory: evidence(cleanupFailures),
    imageRevision: candidate ? CANDIDATE_SHA : IMAGE_REVISION,
    job: candidate
      ? "Candidate all-agent managed runtime activation"
      : "Exact base all-agent managed runtime activation",
    openshellVersion: candidate ? "openshell 0.0.116" : "openshell 0.0.115",
    outcome,
    role,
    runAttempt: RUN_ATTEMPT,
    runId,
    sourceSha: candidate ? CANDIDATE_SHA : BASE_SHA,
    workflowPath: ".github/workflows/managed-runtime-base-qualification.yaml",
    workflowSha: BASE_SHA,
  });
}

function currentRunFixture(
  options: {
    readonly duplicateCandidateJob?: boolean;
    readonly missingArtifact?: string;
    readonly overrideArchive?: (name: string, archive: Buffer) => Buffer;
  } = {},
) {
  const runId = BASE_RUN_ID;
  const candidateReceipt = receipt("candidate", "success", 0, runId);
  const baseReceipt = receipt("base", "success", 0, runId);
  const evidenceContents = new Map([
    ["managed-runtime-activation/target.json", '{"id":"managed-image-activation"}\n'],
    [
      "managed-runtime-activation/cleanup.json",
      JSON.stringify({ passed: ["remove sandbox"], failures: [] }),
    ],
  ]);
  const archives = new Map<string, Buffer>();
  for (const [role, selectedReceipt] of [
    ["candidate", candidateReceipt],
    ["base", baseReceipt],
  ] as const) {
    archives.set(
      `managed-runtime-${role}-receipt-${runId}-${RUN_ATTEMPT}`,
      artifactZip([{ name: "receipt.json", contents: JSON.stringify(selectedReceipt) }]),
    );
    archives.set(
      `managed-runtime-${role}-evidence-${runId}-${RUN_ATTEMPT}`,
      artifactZip(
        selectedReceipt.evidence.files.map((file) => ({
          name: file.path,
          contents: evidenceContents.get(file.path)!,
        })),
      ),
    );
  }
  const responses = new Map<string, unknown>([
    [
      "/repos/NVIDIA/NemoClaw/pulls/10790",
      {
        state: "open",
        base: { sha: BASE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
        head: { sha: CANDIDATE_SHA, repo: { full_name: "NVIDIA/NemoClaw" } },
      },
    ],
    [
      "/repos/NVIDIA/NemoClaw/actions/workflows/managed-runtime-base-qualification.yaml",
      {
        id: 123,
        name: "E2E / Exact Base Managed Runtime",
        path: ".github/workflows/managed-runtime-base-qualification.yaml",
        state: "active",
      },
    ],
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${runId}`,
      {
        id: runId,
        workflow_id: 123,
        run_attempt: RUN_ATTEMPT,
        name: "E2E / Exact Base Managed Runtime",
        path: ".github/workflows/managed-runtime-base-qualification.yaml",
        event: "pull_request_target",
        head_sha: BASE_SHA,
        repository: { full_name: "NVIDIA/NemoClaw" },
      },
    ],
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${runId}/attempts/${RUN_ATTEMPT}/jobs?per_page=100&page=1`,
      {
        total_count: options.duplicateCandidateJob ? 3 : 2,
        jobs: [
          {
            id: 100,
            name: "Candidate all-agent managed runtime activation",
            status: "completed",
            conclusion: "success",
          },
          ...(options.duplicateCandidateJob
            ? [
                {
                  id: 101,
                  name: "Candidate all-agent managed runtime activation",
                  status: "completed",
                  conclusion: "success",
                },
              ]
            : []),
          {
            id: 102,
            name: "Exact base all-agent managed runtime activation",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
  ]);
  const downloadedArchives = new Map<number, Buffer>();
  let artifactId = 200;
  for (const [name, originalArchive] of [...archives]) {
    const archive = options.overrideArchive?.(name, originalArchive) ?? originalArchive;
    const requestPath = `/repos/NVIDIA/NemoClaw/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`;
    const id = artifactId++;
    responses.set(
      requestPath,
      options.missingArtifact === name
        ? { total_count: 0, artifacts: [] }
        : {
            total_count: 1,
            artifacts: [
              {
                archive_download_url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/${id}/zip`,
                digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
                expired: false,
                id,
                name,
                size_in_bytes: archive.length,
                workflow_run: { head_sha: BASE_SHA, id: runId },
              },
            ],
          },
    );
    downloadedArchives.set(id, archive);
  }
  return {
    downloadArtifact: async (identity: { readonly id: number }) =>
      downloadedArchives.get(identity.id)!,
    input: {
      baseJobConclusion: "success" as const,
      baseSha: BASE_SHA,
      candidateJobConclusion: "success" as const,
      candidateSha: CANDIDATE_SHA,
      eventName: "pull_request_target" as const,
      pullRequest: 10_790,
      runAttempt: RUN_ATTEMPT,
      runId,
      token: "test-token",
      workflowSha: BASE_SHA,
    },
    request: async (requestPath: string) => {
      return (
        responses.get(requestPath) ?? Promise.reject(new Error(`unexpected request ${requestPath}`))
      );
    },
  };
}

function artifact(name: string, id: number) {
  return { id, name, digest: `sha256:${"d".repeat(64)}`, size: 100 };
}

function runEvidence(
  outcome: "cancelled" | "failure" | "skipped" | "success",
  selectedReceipt: ManagedRuntimeReceipt | null,
  role: "base" | "candidate",
): ManagedRuntimeRunEvidence {
  const runId = role === "candidate" ? CANDIDATE_RUN_ID : BASE_RUN_ID;
  return {
    run: { id: runId, attempt: RUN_ATTEMPT },
    job: { id: 456, conclusion: outcome },
    receipt: selectedReceipt,
    artifacts: {
      receipt: selectedReceipt ? artifact("candidate-receipt", 1) : null,
      evidence: selectedReceipt ? artifact("candidate-evidence", 2) : null,
    },
    failure: null,
  };
}

function compare(options: {
  baseJob?: "cancelled" | "failure" | "skipped" | "success";
  baseReceipt?: ManagedRuntimeReceipt | null;
  candidateJob?: "cancelled" | "failure" | "success";
  candidateReceipt?: ManagedRuntimeReceipt | null;
}) {
  const baseReceipt = options.baseReceipt === undefined ? receipt("base") : options.baseReceipt;
  const candidateReceipt =
    options.candidateReceipt === undefined ? receipt("candidate") : options.candidateReceipt;
  return classifyManagedRuntimeComparison({
    base: {
      ...runEvidence(options.baseJob ?? "success", baseReceipt, "base"),
      artifacts: {
        receipt: baseReceipt ? artifact("base-receipt", 3) : null,
        evidence: baseReceipt ? artifact("base-evidence", 4) : null,
      },
    },
    baseSha: BASE_SHA,
    candidate: runEvidence(options.candidateJob ?? "success", candidateReceipt, "candidate"),
    candidateSha: CANDIDATE_SHA,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed runtime comparison receipts", () => {
  it("attributes a candidate failure only after the identical base scenario passes", () => {
    expect(
      compare({ candidateJob: "failure", candidateReceipt: receipt("candidate", "failure") }),
    ).toMatchObject({ classification: "candidate-failure" });
  });

  it("keeps an identical exact-base failure separate from the candidate", () => {
    expect(compare({ baseJob: "failure", baseReceipt: receipt("base", "failure") })).toMatchObject({
      classification: "base-failure",
    });
  });

  it.each([
    ["candidate cancellation", { candidateJob: "cancelled" as const, candidateReceipt: null }],
    ["base cancellation", { baseJob: "cancelled" as const, baseReceipt: null }],
    ["coordination skip", { baseJob: "skipped" as const, baseReceipt: null }],
  ])("classifies %s as infrastructure evidence", (_name, options) => {
    expect(compare(options)).toMatchObject({ classification: "infrastructure-failure" });
  });

  it("rejects an exact-base substitution", () => {
    expect(() =>
      parseManagedRuntimeReceipt(receipt("base"), {
        baseSha: "e".repeat(40),
        candidateSha: CANDIDATE_SHA,
        role: "base",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("base SHA");
  });

  it("rejects a receipt from the wrong run attempt", () => {
    expect(() =>
      parseManagedRuntimeReceipt(receipt("base"), {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        role: "base",
        runAttempt: RUN_ATTEMPT + 1,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("workflow attempt");
  });

  it("rejects stale candidate image identities", () => {
    const value = structuredClone(receipt("candidate")) as unknown as {
      runtime: { images: Array<{ sourceRevision: string }> };
    };
    value.runtime.images[0]!.sourceRevision = IMAGE_REVISION;
    expect(() =>
      parseManagedRuntimeReceipt(value, {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        role: "candidate",
        runAttempt: RUN_ATTEMPT,
        runId: CANDIDATE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("stale");
  });

  it("rejects candidate evidence from a workflow revision other than the exact PR base", () => {
    const value = structuredClone(receipt("candidate")) as unknown as {
      workflow: { sha: string };
    };
    value.workflow.sha = "f".repeat(40);
    expect(() =>
      parseManagedRuntimeReceipt(value, {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        role: "candidate",
        runAttempt: RUN_ATTEMPT,
        runId: CANDIDATE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("workflow SHA");
  });

  it("classifies a scenario mismatch as infrastructure evidence", () => {
    const baseReceipt = structuredClone(receipt("base")) as unknown as ManagedRuntimeReceipt;
    (baseReceipt.scenario as { testPath: string }).testPath = "test/e2e/live/another.test.ts";
    expect(compare({ baseReceipt })).toMatchObject({ classification: "infrastructure-failure" });
  });

  it("does not issue a product verdict when cleanup is not proven", () => {
    expect(
      compare({ candidateJob: "failure", candidateReceipt: receipt("candidate", "failure", 1) }),
    ).toMatchObject({
      classification: "infrastructure-failure",
      reason: "candidate or base cleanup is not proven",
    });
  });

  it("classifies only artifacts produced by the current exact-base workflow run", async () => {
    const fixture = currentRunFixture();

    await expect(classifyManagedRuntimeCurrentRun(fixture.input, fixture)).resolves.toMatchObject({
      classification: "pass",
      candidate: { runId: BASE_RUN_ID, evidenceFailure: null },
      base: { runId: BASE_RUN_ID, evidenceFailure: null },
    });
  });

  it("rejects a qualification controller that is not the exact PR base", async () => {
    const fixture = currentRunFixture();

    await expect(
      classifyManagedRuntimeCurrentRun({ ...fixture.input, workflowSha: "f".repeat(40) }, fixture),
    ).rejects.toThrow("qualification workflow source must be");
  });

  it("reports an ambiguous current-run candidate job as infrastructure evidence", async () => {
    const fixture = currentRunFixture({ duplicateCandidateJob: true });

    await expect(classifyManagedRuntimeCurrentRun(fixture.input, fixture)).resolves.toMatchObject({
      classification: "infrastructure-failure",
      candidate: { evidenceFailure: { class: "job-selection" } },
    });
  });

  it("reports a missing current-run candidate artifact as infrastructure evidence", async () => {
    const fixture = currentRunFixture({
      missingArtifact: `managed-runtime-candidate-receipt-${BASE_RUN_ID}-${RUN_ATTEMPT}`,
    });

    await expect(classifyManagedRuntimeCurrentRun(fixture.input, fixture)).resolves.toMatchObject({
      classification: "infrastructure-failure",
      candidate: { evidenceFailure: { class: "artifact-missing" } },
    });
  });

  it.each([
    [
      "candidate receipt parsing",
      "candidate-receipt",
      "receipt-parse",
      () => artifactZip([{ name: "receipt.json", contents: "not-json" }]),
    ],
    [
      "base evidence verification",
      "base-evidence",
      "evidence-verification",
      () => artifactZip([{ name: "substituted.json", contents: "{}" }]),
    ],
  ])(
    "keeps %s failures distinct and sanitized",
    async (_label, artifactName, failureClass, archive) => {
      const fixture = currentRunFixture({
        overrideArchive: (name, original) => (name.includes(artifactName) ? archive() : original),
      });

      const result = await classifyManagedRuntimeCurrentRun(fixture.input, fixture);
      expect(result).toMatchObject({ classification: "infrastructure-failure" });
      expect([
        result.candidate.evidenceFailure?.class,
        result.base.evidenceFailure?.class,
      ]).toContain(failureClass);
      expect(result.reason).not.toContain("test-token");
    },
  );
});
