// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyCurrentRun,
  classifyManagedRuntimeComparison,
  commitStatusForClassification,
  createManagedRuntimeReceipt,
  parseManagedRuntimeReceipt,
  selectManagedRuntimeSource,
  type ManagedRuntimeCandidateSelection,
  type ManagedRuntimeReceipt,
} from "../../../tools/e2e/managed-runtime-comparison.mts";

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
            cohort: `ghrun-${CANDIDATE_RUN_ID}-${RUN_ATTEMPT}`,
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
): ManagedRuntimeReceipt {
  const candidate = role === "candidate";
  return createManagedRuntimeReceipt({
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    catalogPath: catalog(candidate ? CANDIDATE_SHA : IMAGE_REVISION),
    evidenceDirectory: evidence(cleanupFailures),
    imageRevision: candidate ? CANDIDATE_SHA : IMAGE_REVISION,
    job: candidate
      ? "Trusted candidate all-agent managed runtime activation"
      : "Exact base all-agent managed runtime activation",
    openshellVersion: "openshell 0.0.116",
    outcome,
    role,
    candidateSourceRunAttempt: RUN_ATTEMPT,
    candidateSourceRunId: CANDIDATE_RUN_ID,
    runAttempt: RUN_ATTEMPT,
    runId: BASE_RUN_ID,
    sourceSha: candidate ? CANDIDATE_SHA : BASE_SHA,
    workflowPath: ".github/workflows/managed-runtime-base-qualification.yaml",
    workflowSha: BASE_SHA,
  });
}

function artifact(name: string, id: number) {
  return { id, name, digest: `sha256:${"d".repeat(64)}`, size: 100 };
}

function artifactMetadata(name: string, id: number) {
  return {
    total_count: 1,
    artifacts: [
      {
        id,
        name,
        size_in_bytes: 100,
        expired: false,
        digest: `sha256:${"d".repeat(64)}`,
        archive_download_url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/${id}/zip`,
        workflow_run: { id: BASE_RUN_ID, head_sha: BASE_SHA },
      },
    ],
  };
}

function selection(
  outcome: "cancelled" | "failure" | "success",
  selectedReceipt: ManagedRuntimeReceipt | null,
): ManagedRuntimeCandidateSelection {
  return {
    kind: "nemoclaw-managed-runtime-candidate-selection-v1",
    pullRequest: 10_790,
    candidateSha: CANDIDATE_SHA,
    baseSha: BASE_SHA,
    workflow: {
      id: 123,
      path: ".github/workflows/managed-runtime-base-qualification.yaml",
      sha: BASE_SHA,
    },
    run: { id: BASE_RUN_ID, attempt: RUN_ATTEMPT },
    source: { runId: CANDIDATE_RUN_ID, runAttempt: RUN_ATTEMPT },
    job: { id: 456, conclusion: outcome },
    evidenceError: null,
    receipt: selectedReceipt,
    artifacts: {
      receipt: selectedReceipt ? artifact("candidate-receipt", 1) : null,
      evidence: selectedReceipt ? artifact("candidate-evidence", 2) : null,
    },
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
    baseArtifact: baseReceipt ? artifact("base-receipt", 3) : null,
    baseEvidenceArtifact: baseReceipt ? artifact("base-evidence", 4) : null,
    baseJobConclusion: options.baseJob ?? "success",
    baseReceipt,
    baseRunAttempt: RUN_ATTEMPT,
    baseRunId: BASE_RUN_ID,
    candidate: selection(options.candidateJob ?? "success", candidateReceipt),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed runtime comparison receipts", () => {
  it("authenticates the automatic source attempt against the current same-repository PR", async () => {
    const requested: string[] = [];
    const run = {
      workflow_id: 123,
      run_attempt: RUN_ATTEMPT,
      path: ".github/workflows/managed-images.yaml",
      event: "pull_request",
      head_sha: CANDIDATE_SHA,
      status: "completed",
      repository: { full_name: "NVIDIA/NemoClaw" },
      head_repository: { full_name: "NVIDIA/NemoClaw" },
      pull_requests: [{ number: 10_790, head: { sha: CANDIDATE_SHA } }],
    };
    const responses = new Map<string, unknown>([
      [
        "/repos/NVIDIA/NemoClaw/pulls/10790",
        {
          state: "open",
          head: { sha: CANDIDATE_SHA },
          base: { sha: BASE_SHA },
        },
      ],
      [
        "/repos/NVIDIA/NemoClaw/actions/workflows/managed-images.yaml",
        {
          id: 123,
          name: "Images / Build, Test, and Publish Managed Images",
          path: ".github/workflows/managed-images.yaml",
          state: "active",
        },
      ],
    ]);
    const selected = await selectManagedRuntimeSource(
      {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        pullRequest: 10_790,
        runAttempt: RUN_ATTEMPT,
        runId: CANDIDATE_RUN_ID,
        token: "token",
      },
      {
        request: async (apiPath) => {
          requested.push(apiPath);
          return responses.get(apiPath) ?? run;
        },
      },
    );

    expect(selected).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      baseSha: BASE_SHA,
      run: { id: CANDIDATE_RUN_ID, attempt: RUN_ATTEMPT },
    });
    expect(requested).toHaveLength(3);
  });

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
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
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
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
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
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
        role: "candidate",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("stale");
  });

  it("rejects a candidate receipt authored by the PR-controlled workflow", () => {
    const value = structuredClone(receipt("candidate")) as unknown as {
      workflow: { path: string };
    };
    value.workflow.path = ".github/workflows/managed-images.yaml";
    expect(() =>
      parseManagedRuntimeReceipt(value, {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
        role: "candidate",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("workflow path");
  });

  it("classifies a scenario mismatch as infrastructure evidence", () => {
    const baseReceipt = structuredClone(receipt("base")) as unknown as ManagedRuntimeReceipt;
    (baseReceipt.scenario as { testPath: string }).testPath = "test/e2e/live/another.test.ts";
    expect(compare({ baseReceipt })).toMatchObject({ classification: "infrastructure-failure" });
  });

  it("rejects different controller runtime identities", () => {
    const baseReceipt = structuredClone(receipt("base")) as unknown as ManagedRuntimeReceipt;
    (baseReceipt.runtime as { openshellVersion: string }).openshellVersion = "openshell 0.0.115";
    expect(compare({ baseReceipt })).toMatchObject({
      classification: "infrastructure-failure",
      reason: "candidate and base evidence use different controller runtime identities",
    });
  });

  it("does not issue a product verdict when cleanup is not proven", () => {
    expect(
      compare({ candidateJob: "failure", candidateReceipt: receipt("candidate", "failure", 1) }),
    ).toMatchObject({
      classification: "infrastructure-failure",
      reason: "candidate or base cleanup is not proven",
    });
  });

  it("retains artifact identities and a bounded cause when base evidence download fails", async () => {
    const comparison = await classifyCurrentRun(
      selection("success", receipt("candidate")),
      {
        baseJobConclusion: "success",
        headSha: BASE_SHA,
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        token: "credential-that-must-not-leak",
        workflowSha: BASE_SHA,
      },
      {
        request: async (apiPath) =>
          apiPath.includes("base-receipt")
            ? artifactMetadata(`managed-runtime-base-receipt-${BASE_RUN_ID}-${RUN_ATTEMPT}`, 91)
            : artifactMetadata(`managed-runtime-base-evidence-${BASE_RUN_ID}-${RUN_ATTEMPT}`, 92),
        downloadArtifact: async () => {
          throw new Error("credential-that-must-not-leak upstream body");
        },
      },
    );

    expect(comparison).toMatchObject({
      classification: "infrastructure-failure",
      reason: "base evidence validation failed: receipt download or validation failed",
      base: {
        receiptArtifact: { id: 91 },
        evidenceArtifact: { id: 92 },
        evidenceError: "receipt download or validation failed",
      },
    });
    expect(JSON.stringify(comparison)).not.toContain("credential-that-must-not-leak");
  });

  it("maps every comparison verdict to a blocking candidate status", () => {
    expect(commitStatusForClassification("pass")).toMatchObject({ state: "success" });
    expect(commitStatusForClassification("candidate-failure")).toMatchObject({ state: "failure" });
    expect(commitStatusForClassification("base-failure")).toMatchObject({ state: "failure" });
    expect(commitStatusForClassification("infrastructure-failure")).toMatchObject({
      state: "error",
    });
  });
});
