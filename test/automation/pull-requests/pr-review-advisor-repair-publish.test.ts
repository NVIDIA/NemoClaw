// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const publication = vi.hoisted(() => ({
  createVerifiedCommit: vi.fn(),
  updateVerifiedRef: vi.fn(),
}));
const contract = vi.hoisted(() => ({
  assertLiveRepairState: vi.fn(),
  assertValidatedRepair: vi.fn(),
  parseSelection: vi.fn(),
  parseValidationReceipt: vi.fn(),
  readJson: vi.fn(),
  validateRepairPatch: vi.fn(),
}));

vi.mock("../../../tools/pull-requests/publication.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tools/pull-requests/publication.mts")>()),
  createVerifiedCommit: publication.createVerifiedCommit,
  updateVerifiedRef: publication.updateVerifiedRef,
}));

vi.mock("../../../tools/pr-review-advisor/repair-contract.mts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../tools/pr-review-advisor/repair-contract.mts")
  >()),
  assertRepairArtifactDirectory: vi.fn(),
  assertLiveRepairState: contract.assertLiveRepairState,
  assertValidatedRepair: contract.assertValidatedRepair,
  parseSelection: contract.parseSelection,
  parseValidationReceipt: contract.parseValidationReceipt,
  readJson: contract.readJson,
  validateRepairPatch: contract.validateRepairPatch,
}));

import { canonicalJson } from "../../../tools/advisors/canonical-json.mts";
import { digest } from "../../../tools/pr-review-advisor/repair-contract.mts";
import {
  authorizePreparedAdvisorRepair,
  prepareAdvisorRepair,
  publishPreparedAdvisorRepair,
  type RepairPublicationAuthorization,
} from "../../../tools/pr-review-advisor/repair-publish.mts";

const selection = {
  attemptKey: `sha256:${"a".repeat(64)}`,
  sourceHeadSha: "b".repeat(40),
  headRef: "fix/example",
  repositoryId: "R_repo",
  findingIds: ["F-example"],
  stateDigest: `sha256:${"c".repeat(64)}`,
  reviewDigest: `sha256:${"d".repeat(64)}`,
};
const state = { pull: { state: "open" } };
const reviews: unknown[] = [];
const commitSha = "e".repeat(40);
let fixtureDirectory: string;

function fixturePath(...segments: string[]): string {
  return path.join(fixtureDirectory, ...segments);
}

function authorization(): RepairPublicationAuthorization {
  return {
    version: 1,
    environment: "advisor-repair-publish",
    workflowRunId: 123,
    workflowRunAttempt: 1,
    attemptKey: selection.attemptKey,
    selectionDigest: digest(canonicalJson(selection)),
    stateDigest: selection.stateDigest,
    reviewDigest: selection.reviewDigest,
    commitSha,
  };
}

beforeEach(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-publish-"));
  vi.clearAllMocks();
  contract.parseSelection.mockReturnValue(selection);
  contract.parseValidationReceipt.mockReturnValue({ changedPaths: [] });
  contract.validateRepairPatch.mockReturnValue({
    candidateTreeSha: "f".repeat(40),
    repository: fixturePath("candidate.git"),
  });
  contract.readJson.mockReturnValue({});
  publication.createVerifiedCommit.mockResolvedValue(commitSha);
  publication.updateVerifiedRef.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

describe("PR Review Advisor repair publisher", () => {
  it("prepares a verified one-parent commit from the exact source head (#10791)", async () => {
    await expect(
      prepareAdvisorRepair({
        request: vi.fn(),
        sourceRepository: fixturePath("source"),
        selectionPath: fixturePath("selection", "selection.json"),
        patchPath: fixturePath("validated", "repair.patch"),
        receiptPath: fixturePath("validated", "validation.json"),
        workDirectory: fixturePath("work"),
      }),
    ).resolves.toBe(commitSha);

    expect(publication.createVerifiedCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: selection.sourceHeadSha,
        repositoryName: "NVIDIA/NemoClaw",
      }),
    );
  });

  it("rejects a mismatched protected authorization before reading or updating the ref (#10791)", async () => {
    const request = vi.fn();
    const graphql = vi.fn();

    await expect(
      publishPreparedAdvisorRepair({
        authorization: { ...authorization(), commitSha: "0".repeat(40) },
        commitSha,
        graphql,
        request,
        selectionPath: fixturePath("selection.json"),
        state,
        reviews,
        workflowRunId: 123,
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow("authorization does not match");
    expect(request).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("rejects changed live state before reading or updating the ref (#10791)", async () => {
    contract.assertLiveRepairState.mockImplementationOnce(() => {
      throw new Error("pull request state changed after repair selection");
    });
    const request = vi.fn();

    await expect(
      publishPreparedAdvisorRepair({
        authorization: authorization(),
        commitSha,
        graphql: vi.fn(),
        request,
        selectionPath: fixturePath("selection.json"),
        state: { pull: { state: "closed" } },
        reviews,
        workflowRunId: 123,
        workflowRunAttempt: 1,
      }),
    ).rejects.toThrow("state changed");
    expect(request).not.toHaveBeenCalled();
    expect(publication.updateVerifiedRef).not.toHaveBeenCalled();
  });

  it("binds approval and publishes the verified commit with the exact source compare-and-swap (#10791)", async () => {
    const bound = authorizePreparedAdvisorRepair({
      commitSha,
      selectionPath: fixturePath("selection.json"),
      state,
      reviews,
      workflowRunId: 123,
      workflowRunAttempt: 1,
    });
    const request = vi.fn().mockResolvedValue({
      sha: commitSha,
      parents: [{ sha: selection.sourceHeadSha }],
      verification: { verified: true },
    });

    await publishPreparedAdvisorRepair({
      authorization: bound,
      commitSha,
      graphql: vi.fn(),
      request,
      selectionPath: fixturePath("selection.json"),
      state,
      reviews,
      workflowRunId: 123,
      workflowRunAttempt: 1,
    });

    expect(publication.updateVerifiedRef).toHaveBeenCalledWith({
      commitSha,
      graphql: expect.any(Function),
      headRef: selection.headRef,
      headSha: selection.sourceHeadSha,
      repositoryId: selection.repositoryId,
    });
  });
});
