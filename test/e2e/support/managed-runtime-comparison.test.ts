// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
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
  publishManagedRuntimeCommitStatus,
  selectManagedRuntimeCandidate,
  selectManagedRuntimeSource,
  type ManagedRuntimeCandidateSelection,
  type ManagedRuntimeReceipt,
} from "../../../tools/e2e/managed-runtime-comparison.mts";
import { artifactZip } from "../../helpers/artifact-zip";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const IMAGE_REVISION = "c".repeat(40);
const CANDIDATE_RUN_ID = 33_569_187_156;
const BASE_RUN_ID = 33_600_000_001;
const RUN_ATTEMPT = 1;
const PR_NUMBER = 10_790;
const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const REPOSITORIES = {
  openclaw: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox",
} as const;
type TestPlatform = "linux/amd64" | "linux/arm64";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-comparison-"));
  temporaryDirectories.push(directory);
  return directory;
}

function catalog(revision: string, platform: TestPlatform = "linux/amd64"): string {
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
          platform,
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
    JSON.stringify({
      passed: ["remove sandbox"],
      failures: Array(cleanupFailures).fill({}),
    }),
  );
  return root;
}

function receipt(
  role: "base" | "candidate",
  outcome: "failure" | "success" = "success",
  cleanupFailures = 0,
  imageRevision = role === "candidate" ? CANDIDATE_SHA : BASE_SHA,
  platform: TestPlatform = "linux/amd64",
): ManagedRuntimeReceipt {
  const candidate = role === "candidate";
  const arch = platform.split("/")[1];
  return createManagedRuntimeReceipt({
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    catalogPath: catalog(imageRevision, platform),
    evidenceDirectory: evidence(cleanupFailures),
    imageRevision,
    job: candidate
      ? `Trusted candidate all-agent managed runtime activation (${arch})`
      : `Exact base all-agent managed runtime activation (${arch})`,
    openshellVersion: "openshell 0.0.116",
    outcome,
    platform,
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

function artifactMetadata(name: string, id: number, bytes?: Buffer) {
  return {
    total_count: 1,
    artifacts: [
      {
        id,
        name,
        size_in_bytes: bytes?.length ?? 100,
        expired: false,
        digest: bytes
          ? `sha256:${createHash("sha256").update(bytes).digest("hex")}`
          : `sha256:${"d".repeat(64)}`,
        archive_download_url: `https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/${id}/zip`,
        workflow_run: { id: BASE_RUN_ID, head_sha: BASE_SHA },
      },
    ],
  };
}

function sourceFixture(
  options: {
    readonly pull?: Record<string, unknown>;
    readonly run?: Record<string, unknown>;
  } = {},
) {
  const requested: string[] = [];
  const responses = new Map<string, unknown>([
    [
      `/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`,
      {
        state: "open",
        head: { sha: CANDIDATE_SHA },
        base: { sha: BASE_SHA },
        ...options.pull,
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
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${CANDIDATE_RUN_ID}`,
      {
        workflow_id: 123,
        run_attempt: RUN_ATTEMPT,
        path: ".github/workflows/managed-images.yaml",
        event: "pull_request",
        head_sha: CANDIDATE_SHA,
        status: "completed",
        conclusion: "success",
        repository: { full_name: "NVIDIA/NemoClaw" },
        head_repository: { full_name: "NVIDIA/NemoClaw" },
        pull_requests: [{ number: PR_NUMBER, head: { sha: CANDIDATE_SHA } }],
        ...options.run,
      },
    ],
  ]);
  return {
    requested,
    request: async (apiPath: string): Promise<unknown> => {
      requested.push(apiPath);
      expect(responses.has(apiPath), `unexpected request ${apiPath}`).toBe(true);
      return responses.get(apiPath);
    },
  };
}

function selectSource(request: (apiPath: string) => Promise<unknown>) {
  return selectManagedRuntimeSource(
    {
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      pullRequest: PR_NUMBER,
      runAttempt: RUN_ATTEMPT,
      runId: CANDIDATE_RUN_ID,
      token: "token",
    },
    { request },
  );
}

function candidateEvidenceArchive(
  selectedReceipt: ManagedRuntimeReceipt,
  tampered = false,
): Buffer {
  return artifactZip(
    selectedReceipt.evidence.files.map((file) => {
      const contents = file.path.endsWith("/cleanup.json")
        ? JSON.stringify({ passed: ["remove sandbox"], failures: [] })
        : file.path.endsWith("/target.json")
          ? tampered
            ? '{"id":"tampered"}\n'
            : '{"id":"managed-image-activation"}\n'
          : undefined;
      expect(contents, `unexpected evidence file ${file.path}`).toBeDefined();
      return { name: file.path, contents: contents! };
    }),
  );
}

function candidateFixture(
  platform: TestPlatform,
  options: {
    readonly malformedReceipt?: boolean;
    readonly missingEvidence?: boolean;
    readonly missingReceipt?: boolean;
    readonly tamperedEvidence?: boolean;
    readonly job?: Record<string, unknown>;
    readonly run?: Record<string, unknown>;
  } = {},
) {
  const arch = platform.split("/")[1];
  const selectedReceipt = receipt("candidate", "success", 0, CANDIDATE_SHA, platform);
  const receiptArchive = options.malformedReceipt
    ? artifactZip([{ name: "receipt.json", contents: "{" }])
    : artifactZip([{ name: "receipt.json", contents: JSON.stringify(selectedReceipt) }]);
  const evidenceArchive = candidateEvidenceArchive(selectedReceipt, options.tamperedEvidence);
  const receiptName = `managed-runtime-candidate-receipt-${BASE_RUN_ID}-${RUN_ATTEMPT}-${arch}`;
  const evidenceName = `managed-runtime-candidate-evidence-${BASE_RUN_ID}-${RUN_ATTEMPT}-${arch}`;
  const jobsPath = `/repos/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}/attempts/${RUN_ATTEMPT}/jobs?per_page=100&page=1`;
  const responses = new Map<string, unknown>([
    [
      `/repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}`,
      { state: "open", head: { sha: CANDIDATE_SHA }, base: { sha: BASE_SHA } },
    ],
    [
      "/repos/NVIDIA/NemoClaw/actions/workflows/managed-runtime-base-qualification.yaml",
      {
        id: 456,
        name: "E2E / Exact Base Managed Runtime",
        path: ".github/workflows/managed-runtime-base-qualification.yaml",
        state: "active",
      },
    ],
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}`,
      {
        workflow_id: 456,
        run_attempt: RUN_ATTEMPT,
        path: ".github/workflows/managed-runtime-base-qualification.yaml",
        event: "workflow_run",
        head_sha: BASE_SHA,
        repository: { full_name: "NVIDIA/NemoClaw" },
        ...options.run,
      },
    ],
    [
      jobsPath,
      {
        total_count: 1,
        jobs: [
          {
            id: 789,
            name: `Trusted candidate all-agent managed runtime activation (${arch})`,
            status: "completed",
            conclusion: "success",
            ...options.job,
          },
        ],
      },
    ],
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}/artifacts?name=${encodeURIComponent(receiptName)}&per_page=100`,
      options.missingReceipt
        ? { total_count: 0, artifacts: [] }
        : artifactMetadata(receiptName, 91, receiptArchive),
    ],
    [
      `/repos/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}/artifacts?name=${encodeURIComponent(evidenceName)}&per_page=100`,
      options.missingEvidence
        ? { total_count: 0, artifacts: [] }
        : artifactMetadata(evidenceName, 92, evidenceArchive),
    ],
  ]);
  const archives = new Map([
    [receiptName, receiptArchive],
    [evidenceName, evidenceArchive],
  ]);
  return {
    select: () =>
      selectManagedRuntimeCandidate(
        {
          baseSha: BASE_SHA,
          candidateSha: CANDIDATE_SHA,
          controllerHeadSha: BASE_SHA,
          pullRequest: PR_NUMBER,
          platform,
          runAttempt: RUN_ATTEMPT,
          runId: BASE_RUN_ID,
          sourceRunAttempt: RUN_ATTEMPT,
          sourceRunId: CANDIDATE_RUN_ID,
          token: "token",
          workflowSha: BASE_SHA,
        },
        {
          request: async (apiPath) => {
            expect(responses.has(apiPath), `unexpected request ${apiPath}`).toBe(true);
            return responses.get(apiPath);
          },
          downloadArtifact: async (identity) => {
            const archive = archives.get(identity.name);
            expect(archive, `unexpected artifact ${identity.name}`).toBeDefined();
            return archive!;
          },
        },
      ),
  };
}

function compareCandidate(candidate: ManagedRuntimeCandidateSelection) {
  const baseReceipt = receipt("base", "success", 0, BASE_SHA, candidate.platform);
  return classifyManagedRuntimeComparison({
    baseArtifact: artifact("base-receipt", 3),
    baseEvidenceArtifact: artifact("base-evidence", 4),
    baseJobConclusion: "success",
    baseReceipt,
    baseRunAttempt: RUN_ATTEMPT,
    baseRunId: BASE_RUN_ID,
    candidate,
  });
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
    platform: "linux/amd64",
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
  it("publishes the fixed status request through the shared GitHub client", async () => {
    const requests: Array<{ path: string; token: string; options: unknown }> = [];
    await publishManagedRuntimeCommitStatus(
      {
        description: "Exact-base qualification is running",
        runId: BASE_RUN_ID,
        sha: CANDIDATE_SHA,
        state: "pending",
        token: "status-token",
      },
      async (requestPath, token, options) => {
        requests.push({ path: requestPath, token, options });
        return { id: 1 };
      },
    );
    expect(requests).toEqual([
      {
        path: `/repos/NVIDIA/NemoClaw/statuses/${CANDIDATE_SHA}`,
        token: "status-token",
        options: {
          method: "POST",
          body: {
            state: "pending",
            context: "NemoClaw / Exact-base managed runtime",
            description: "Exact-base qualification is running",
            target_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${BASE_RUN_ID}`,
          },
        },
      },
    ]);
  });

  it("selects a completed exact-candidate run for the current same-repository PR", async () => {
    const fixture = sourceFixture();
    const selected = await selectSource(fixture.request);

    expect(selected).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      baseSha: BASE_SHA,
      run: { id: CANDIDATE_RUN_ID, attempt: RUN_ATTEMPT },
    });
    expect(fixture.requested).toHaveLength(3);
  });

  it.each([
    {
      name: "a fork-owned source run",
      run: { head_repository: { full_name: "external/NemoClaw" } },
      message: "source workflow source repository",
    },
    {
      name: "a non-PR event",
      run: { event: "workflow_dispatch" },
      message: "source workflow run event",
    },
    {
      name: "a cancelled source run",
      run: { conclusion: "cancelled" },
      message: "source workflow run conclusion",
    },
    {
      name: "another attached PR",
      run: {
        pull_requests: [{ number: PR_NUMBER + 1, head: { sha: CANDIDATE_SHA } }],
      },
      message: "source workflow run does not match the pull request",
    },
    {
      name: "another attached PR head",
      run: {
        pull_requests: [{ number: PR_NUMBER, head: { sha: IMAGE_REVISION } }],
      },
      message: "source workflow pull request source SHA",
    },
    {
      name: "a closed current PR",
      pull: { state: "closed" },
      message: "pull request state",
    },
  ] satisfies Array<{
    name: string;
    message: string;
    pull?: Record<string, unknown>;
    run?: Record<string, unknown>;
  }>)("rejects $name", async ({ message, pull, run }) => {
    const fixture = sourceFixture({
      ...(pull === undefined ? {} : { pull }),
      ...(run === undefined ? {} : { run }),
    });
    await expect(selectSource(fixture.request)).rejects.toThrow(message);
  });

  it.each([
    ["amd64", "linux/amd64"],
    ["arm64", "linux/arm64"],
  ] as const)("authenticates valid %s candidate evidence", async (arch, platform) => {
    const selected = await candidateFixture(platform).select();

    expect(selected).toMatchObject({
      platform,
      evidenceError: null,
      receipt: { role: "candidate", scenario: { platform } },
      artifacts: {
        receipt: {
          name: `managed-runtime-candidate-receipt-${BASE_RUN_ID}-${RUN_ATTEMPT}-${arch}`,
        },
        evidence: {
          name: `managed-runtime-candidate-evidence-${BASE_RUN_ID}-${RUN_ATTEMPT}-${arch}`,
        },
      },
    });
    expect(compareCandidate(selected)).toMatchObject({ classification: "pass" });
  });

  it.each([
    ["missing receipt", { missingReceipt: true }, "candidate evidence is missing or incomplete"],
    ["missing evidence", { missingEvidence: true }, "candidate evidence is missing or incomplete"],
    [
      "malformed receipt",
      { malformedReceipt: true },
      "candidate evidence validation failed: receipt download or validation failed",
    ],
    [
      "digest-mismatched evidence",
      { tamperedEvidence: true },
      "candidate evidence validation failed: evidence download or digest validation failed",
    ],
  ] as const)("fails closed for %s", async (_name, options, reason) => {
    const selected = await candidateFixture("linux/amd64", options).select();

    expect(compareCandidate(selected)).toMatchObject({
      classification: "infrastructure-failure",
      reason,
    });
  });

  it("rejects a candidate job for another platform", async () => {
    await expect(
      candidateFixture("linux/amd64", {
        job: { name: "Trusted candidate all-agent managed runtime activation (arm64)" },
      }).select(),
    ).rejects.toThrow("candidate managed runtime job is missing or ambiguous");
  });

  it("rejects a candidate job from another workflow attempt", async () => {
    await expect(
      candidateFixture("linux/amd64", { run: { run_attempt: RUN_ATTEMPT + 1 } }).select(),
    ).rejects.toThrow("qualification run does not match the requested workflow attempt");
  });

  it("attributes a candidate failure only after the identical base scenario passes", () => {
    expect(
      compare({
        candidateJob: "failure",
        candidateReceipt: receipt("candidate", "failure"),
      }),
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
    expect(compare(options)).toMatchObject({
      classification: "infrastructure-failure",
    });
  });

  it("rejects an exact-base substitution", () => {
    expect(() =>
      parseManagedRuntimeReceipt(receipt("base"), {
        baseSha: "e".repeat(40),
        candidateSha: CANDIDATE_SHA,
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
        role: "base",
        platform: "linux/amd64",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("base SHA");
  });

  it("rejects exact-base image evidence published for another commit", () => {
    expect(() => receipt("base", "success", 0, IMAGE_REVISION)).toThrow(
      "exact-base managed image revision",
    );

    const value = structuredClone(receipt("base")) as unknown as {
      runtime: { images: Array<{ sourceRevision: string }> };
    };
    value.runtime.images = value.runtime.images.map((image) => ({
      ...image,
      sourceRevision: IMAGE_REVISION,
    }));
    expect(() =>
      parseManagedRuntimeReceipt(value, {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
        role: "base",
        platform: "linux/amd64",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("base managed runtime image revision is stale");
  });

  it("rejects a receipt from the wrong run attempt", () => {
    expect(() =>
      parseManagedRuntimeReceipt(receipt("base"), {
        baseSha: BASE_SHA,
        candidateSha: CANDIDATE_SHA,
        candidateSourceRunAttempt: RUN_ATTEMPT,
        candidateSourceRunId: CANDIDATE_RUN_ID,
        role: "base",
        platform: "linux/amd64",
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
        platform: "linux/amd64",
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
        platform: "linux/amd64",
        runAttempt: RUN_ATTEMPT,
        runId: BASE_RUN_ID,
        workflowSha: BASE_SHA,
      }),
    ).toThrow("workflow path");
  });

  it("classifies a scenario mismatch as infrastructure evidence", () => {
    const baseReceipt = structuredClone(receipt("base")) as unknown as ManagedRuntimeReceipt;
    (baseReceipt.scenario as { testPath: string }).testPath = "test/e2e/live/another.test.ts";
    expect(compare({ baseReceipt })).toMatchObject({
      classification: "infrastructure-failure",
    });
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
      compare({
        candidateJob: "failure",
        candidateReceipt: receipt("candidate", "failure", 1),
      }),
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
            ? artifactMetadata(
                `managed-runtime-base-receipt-${BASE_RUN_ID}-${RUN_ATTEMPT}-amd64`,
                91,
              )
            : artifactMetadata(
                `managed-runtime-base-evidence-${BASE_RUN_ID}-${RUN_ATTEMPT}-amd64`,
                92,
              ),
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
    expect(commitStatusForClassification("pass")).toMatchObject({
      state: "success",
    });
    expect(commitStatusForClassification("candidate-failure")).toMatchObject({
      state: "failure",
    });
    expect(commitStatusForClassification("base-failure")).toMatchObject({
      state: "failure",
    });
    expect(commitStatusForClassification("infrastructure-failure")).toMatchObject({
      state: "error",
    });
  });
});
