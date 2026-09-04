// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claimRepairAttempt } from "../../../tools/pr-review-advisor-repair/select.mts";
import {
  parseValidatedReceiptForPublication,
  sha256,
  type ValidationReceipt,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  assertDcoDeclaration,
  collectGeneratedHeadContext,
} from "../../../tools/pr-review-advisor-repair/generated-head-context.mts";
import { listGeneratedHeadWorkflowRuns } from "../../../tools/pr-review-advisor-repair/generated-head-validation.mts";
import {
  assertPublicationMaintainerPermissions,
  assertPublicationPullRequest,
  atomicUpdate,
  ensureGeneratedHeadValidation,
  ensureVerifiedRepairCommit,
  publicationHeadAction,
  publishValidatedRepair,
  reconstructValidatedTree,
  waitForVerifiedCommit,
} from "../../../tools/pr-review-advisor-repair/publish.mts";
import {
  collectReconciliationSource,
  formatReconciliationBindingOutput,
} from "../../../tools/pr-review-advisor-repair/reconcile.mts";
import {
  verifyGeneratedHeadOnce,
  verifyGeneratedHeadWithReceipt,
} from "../../../tools/pr-review-advisor-repair/verify-generated-head.mts";
import {
  asGitHubRequest,
  fixtureGit as git,
  generatedHeadEvidenceResponder,
  reconciliationResponder,
  repairSelection as selection,
  repairValidationReceipt as validationReceipt,
  successfulPublicationResponder,
  writeFixture as write,
} from "../../helpers/pr-review-advisor-repair.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-repair-publish-"));
  temporaryDirectories.push(directory);
  return directory;
}

function publisherFixture() {
  const root = temporaryDirectory();
  const repository = path.join(root, "source");
  fs.mkdirSync(repository);
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Advisor Publisher Test"]);
  git(repository, ["config", "user.email", "advisor-publisher@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  write(repository, "src/demo.ts", "export const value = 1;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add publisher base"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  write(repository, "src/pr-owned.ts", "export const prOwned = true;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add publisher head"]);
  const sourceHeadSha = git(repository, ["rev-parse", "HEAD"]);
  const candidate = "export const value = 2;\n";
  write(repository, "src/demo.ts", candidate);
  git(repository, ["add", "src/demo.ts"]);
  const candidateTreeSha = git(repository, ["write-tree"]);
  const candidateBlobSha = git(repository, ["hash-object", "src/demo.ts"]);
  const patch = execFileSync("git", ["diff", "--cached", "--binary", "HEAD", "--"], {
    cwd: repository,
  });
  git(repository, ["reset", "--hard", "HEAD"]);
  const patchFile = path.join(root, "validated.patch");
  fs.writeFileSync(patchFile, patch);
  const bundle = selection({
    baseSha,
    sourceHeadSha,
    optIn: { headSha: sourceHeadSha },
  });
  const receipt: ValidationReceipt = {
    ...validationReceipt(bundle, patch),
    baseSha,
    sourceHeadSha,
    candidateTreeSha,
    changedPaths: [
      {
        path: "src/demo.ts",
        status: "M",
        mode: "100644",
        type: "blob",
        bytes: Buffer.byteLength(candidate),
      },
    ],
    patchSha256: sha256(patch),
  };
  return {
    root,
    repository,
    patch,
    patchFile,
    bundle,
    receipt,
    candidateTreeSha,
    candidateBlobSha,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("PR Review Advisor repair Phase 1 publication", () => {
  it("claims an exact attempt once and refuses an existing claim (#10791)", async () => {
    const bundle = selection();
    const request = asGitHubRequest(
      vi
        .fn()
        .mockResolvedValueOnce({ total_count: 0, check_runs: [] })
        .mockResolvedValueOnce({ id: 9001 }),
    );
    await expect(
      claimRepairAttempt(bundle, "token", "https://example.test/run", request),
    ).resolves.toBe(9001);
    expect(request).toHaveBeenLastCalledWith(
      "repos/NVIDIA/NemoClaw/check-runs",
      "token",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          external_id: bundle.attemptKey,
          conclusion: "neutral",
        }),
      }),
    );
    const duplicate = asGitHubRequest(
      vi.fn().mockResolvedValue({
        total_count: 1,
        check_runs: [
          {
            id: 7,
            name: "Advisor repair attempt",
            external_id: bundle.attemptKey,
          },
        ],
      }),
    );
    await expect(
      claimRepairAttempt(bundle, "token", "https://example.test/run", duplicate),
    ).rejects.toThrow("already claimed");
  });

  it("reads every stable GitHub page and rejects overlapping pages (#10791)", async () => {
    const firstPage = Array.from({ length: 100 }, (_value, index) => ({
      id: index + 1,
    }));
    const runs = asGitHubRequest(
      vi.fn(async (apiPath: string) =>
        apiPath.endsWith("&page=2")
          ? { total_count: 101, workflow_runs: [{ id: 101 }] }
          : { total_count: 101, workflow_runs: firstPage },
      ),
    );
    await expect(listGeneratedHeadWorkflowRuns("pr.yaml", "token", runs)).resolves.toHaveLength(
      101,
    );

    const overlap = asGitHubRequest(
      vi.fn(async (apiPath: string) =>
        apiPath.endsWith("&page=2")
          ? { total_count: 101, workflow_runs: [{ id: 100 }] }
          : { total_count: 101, workflow_runs: firstPage },
      ),
    );
    await expect(listGeneratedHeadWorkflowRuns("pr.yaml", "token", overlap)).rejects.toThrow(
      "changed during pagination",
    );

    await expect(
      listGeneratedHeadWorkflowRuns(
        "pr.yaml",
        "token",
        asGitHubRequest(
          vi.fn().mockResolvedValue({
            total_count: 2,
            workflow_runs: [{ id: 17 }, { id: 17 }],
          }),
        ),
      ),
    ).rejects.toThrow("changed during pagination");

    const bundle = selection();
    const claims = asGitHubRequest(
      vi.fn(async (apiPath: string) =>
        apiPath.endsWith("&page=2")
          ? {
              total_count: 101,
              check_runs: [
                {
                  id: 101,
                  name: "Advisor repair attempt",
                  external_id: bundle.attemptKey,
                },
              ],
            }
          : { total_count: 101, check_runs: firstPage },
      ),
    );
    await expect(
      claimRepairAttempt(bundle, "token", "https://example.test/run", claims),
    ).rejects.toThrow("already claimed");

    await expect(
      claimRepairAttempt(
        bundle,
        "token",
        "https://example.test/run",
        asGitHubRequest(
          vi.fn().mockResolvedValue({
            total_count: 2,
            check_runs: [{ id: 17 }, { id: 17 }],
          }),
        ),
      ),
    ).rejects.toThrow("changed during pagination");
  });

  it("rechecks PR identity, maintainer authority, and the validator receipt (#10791)", async () => {
    const bundle = selection();
    const patch = Buffer.from("validated patch");
    const receipt = validationReceipt(bundle, patch);
    expect(parseValidatedReceiptForPublication(receipt, patch)).toEqual(receipt);
    expect(() =>
      parseValidatedReceiptForPublication({ ...receipt, patchSha256: "0".repeat(64) }, patch),
    ).toThrow("patch digest is invalid");
    expect(() =>
      assertPublicationPullRequest(receipt, {
        number: 42,
        state: "open",
        draft: false,
        maintainer_can_modify: true,
        user: { login: "different-author" },
        head: {
          sha: receipt.sourceHeadSha,
          ref: receipt.headRef,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        base: {
          sha: receipt.baseSha,
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
        },
      }),
    ).toThrow("identity or ownership changed");
    await expect(
      assertPublicationMaintainerPermissions(
        receipt,
        "token",
        asGitHubRequest(
          vi.fn().mockResolvedValue({
            permission: "write",
            role_name: "write",
            user: {
              login: "cjagwani",
              permissions: { admin: false, maintain: false },
            },
          }),
        ),
      ),
    ).rejects.toThrow("admin or maintain permission");
  });

  it("binds deterministic recovery to the original validated artifact (#10791)", async () => {
    const request = asGitHubRequest(vi.fn(reconciliationResponder));
    await expect(
      collectReconciliationSource({
        sourceRunId: 900,
        validationArtifactId: 901,
        actor: "maintainer",
        triggeringActor: "maintainer",
        token: "token",
        request,
      }),
    ).resolves.toMatchObject({
      sourceRunId: 900,
      sourceRunAttempt: 1,
      validationArtifactId: 901,
    });
    const bundle = selection();
    const receipt = validationReceipt(bundle, Buffer.from("validated patch"));
    expect(formatReconciliationBindingOutput(receipt)).toContain(
      `attempt_key=${receipt.attemptKey}`,
    );
  });

  it("binds generated-head jobs to trusted main and enforces DCO (#10791)", async () => {
    const bundle = selection();
    const trusted = "e".repeat(40);
    const request = asGitHubRequest(
      vi.fn().mockResolvedValue({
        number: 42,
        state: "open",
        draft: false,
        maintainer_can_modify: true,
        title: "fix(cli): preserve exact generated head",
        body: "Summary\n\nSigned-off-by: Maintainer <maintainer@example.com>",
        user: { login: "cjagwani" },
        head: {
          sha: bundle.input.sourceHeadSha,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        base: {
          sha: bundle.input.baseSha,
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
      }),
    );
    const env = {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_SHA: trusted,
      GITHUB_TOKEN: "token",
      GITHUB_WORKFLOW_SHA: trusted,
      PR_NUMBER: "42",
      SOURCE_HEAD_SHA: bundle.input.sourceHeadSha,
      BASE_SHA: bundle.input.baseSha,
      REPAIR_ATTEMPT_KEY: bundle.attemptKey,
    };
    const context = await collectGeneratedHeadContext(env, request);
    expect(() => assertDcoDeclaration(context)).not.toThrow();
    await expect(
      collectGeneratedHeadContext({ ...env, GITHUB_SHA: "f".repeat(40) }, request),
    ).rejects.toThrow("not executing one exact trusted workflow revision");
    const nonPilot = asGitHubRequest(
      vi.fn().mockResolvedValue({
        ...(await request.mock.results[0]?.value),
        user: { login: "dependabot[bot]" },
      }),
    );
    await expect(collectGeneratedHeadContext(env, nonPilot)).rejects.toThrow(
      "no longer matches generated-head dispatch",
    );
  });

  it("reconstructs, verifies, and atomically publishes one exact tree (#10791)", async () => {
    const fixture = publisherFixture();
    const commitSha = "d".repeat(40);
    expect(() =>
      reconstructValidatedTree({
        sourceCheckout: fixture.repository,
        receipt: { ...fixture.receipt, candidateTreeSha: "f".repeat(40) },
        patchFile: fixture.patchFile,
        stagingDirectory: path.join(fixture.root, "mismatch"),
      }),
    ).toThrow("different candidate tree");
    const request = asGitHubRequest(vi.fn(successfulPublicationResponder(fixture, commitSha)));
    const reviewState = {
      version: 1 as const,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      headSha: fixture.receipt.sourceHeadSha,
      issueComments: [],
      reviews: [],
      threads: [],
    };
    const graphql = vi.fn().mockResolvedValue({
      data: { updateRefs: { clientMutationId: commitSha } },
    });
    await expect(
      publishValidatedRepair({
        sourceCheckout: fixture.repository,
        receipt: fixture.receipt,
        patchFile: fixture.patchFile,
        stagingDirectory: path.join(fixture.root, "publisher"),
        token: "token",
        request,
        graphql,
        wait: async () => undefined,
        collectReviewState: async () => reviewState,
      }),
    ).resolves.toMatchObject({
      commitSha,
      candidateTreeSha: fixture.candidateTreeSha,
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("updateRefs"), {
      input: expect.objectContaining({
        refUpdates: [
          expect.objectContaining({
            beforeOid: fixture.receipt.sourceHeadSha,
            afterOid: commitSha,
            force: false,
          }),
        ],
      }),
    });
  });

  it("permits only source-to-verified-head publication and confirms CAS (#10791)", async () => {
    const source = "a".repeat(40);
    const commit = "d".repeat(40);
    expect(publicationHeadAction(source, source, commit)).toBe("atomic-update");
    expect(publicationHeadAction(source, commit, commit)).toBe("resume-generated-head");
    expect(() => publicationHeadAction(source, "f".repeat(40), commit)).toThrow(
      "neither the approved source nor the verified repair commit",
    );
    await expect(
      atomicUpdate({
        repositoryId: "R_repo",
        headRef: "fix/demo",
        beforeOid: source,
        afterOid: commit,
        graphql: vi.fn().mockResolvedValue({
          data: { updateRefs: { clientMutationId: "e".repeat(40) } },
        }),
      }),
    ).rejects.toThrow("did not confirm");
  });

  it("requires the approved one-parent commit to become GitHub-verified (#10791)", async () => {
    const input = {
      commitSha: "d".repeat(40),
      message: "fix(advisor): test",
      parentSha: "a".repeat(40),
      treeSha: "e".repeat(40),
    };
    const verified = {
      sha: input.commitSha,
      message: input.message,
      tree: { sha: input.treeSha },
      parents: [{ sha: input.parentSha }],
      verification: { verified: true, reason: "valid" },
    };
    const request = asGitHubRequest(
      vi
        .fn()
        .mockResolvedValueOnce({ verification: { verified: false } })
        .mockResolvedValueOnce(verified),
    );
    const wait = vi.fn();
    await waitForVerifiedCommit(input, "token", request, wait);
    expect(wait).toHaveBeenCalledWith(5000);
    await expect(
      waitForVerifiedCommit(
        input,
        "token",
        asGitHubRequest(
          vi.fn().mockResolvedValue({
            ...verified,
            tree: { sha: "f".repeat(40) },
          }),
        ),
        vi.fn(),
      ),
    ).rejects.toThrow("approved one-parent tree");

    const neverVerified = asGitHubRequest(
      vi.fn().mockResolvedValue({
        verification: { verified: false, reason: "unsigned" },
      }),
    );
    await expect(waitForVerifiedCommit(input, "token", neverVerified, vi.fn())).rejects.toThrow(
      "did not verify",
    );
    expect(neverVerified).toHaveBeenCalledTimes(12);

    const bundle = selection();
    const receipt = validationReceipt(bundle, Buffer.from("validated patch"));
    const message = `fix(advisor): apply validated review repair\n\nAdvisor-Repair-Attempt: ${bundle.attemptKey}`;
    const resume = asGitHubRequest(
      vi.fn().mockResolvedValue({
        sha: input.commitSha,
        message,
        tree: { sha: receipt.candidateTreeSha },
        parents: [{ sha: receipt.sourceHeadSha }],
        verification: { verified: true, reason: "valid" },
      }),
    );
    await expect(
      ensureVerifiedRepairCommit({
        liveHeadSha: input.commitSha,
        repository: "/unused-on-resume",
        receipt,
        candidateTreeSha: receipt.candidateTreeSha,
        token: "token",
        request: resume,
        wait: vi.fn(),
      }),
    ).resolves.toBe(input.commitSha);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("never dispatches a generated-head workflow twice (#10791)", async () => {
    const bundle = selection();
    const receipt = validationReceipt(bundle, Buffer.from("validated patch"));
    const commitSha = "d".repeat(40);
    const request = asGitHubRequest(
      vi.fn(async (apiPath: string, _token: string, options?: { method?: string }) =>
        apiPath.includes(`/commits/${commitSha}/check-runs`)
          ? {
              total_count: 1,
              check_runs: [
                {
                  name: "Advisor repair validation dispatch",
                  external_id: `${bundle.attemptKey}:pr.yaml`,
                },
              ],
            }
          : { total_count: 0, workflow_runs: [] },
      ),
    );
    await expect(
      ensureGeneratedHeadValidation(receipt, commitSha, "token", request),
    ).rejects.toThrow("durably claimed but its exact run is not visible");
    expect(
      request.mock.calls.some(
        ([apiPath, , options]) =>
          String(apiPath).endsWith("/dispatches") && options?.method === "POST",
      ),
    ).toBe(false);
  });

  it("attests exact trusted-main gates and records manual recovery on failure (#10791)", async () => {
    const bundle = selection();
    const commitSha = "d".repeat(40);
    const success = asGitHubRequest(
      vi.fn(generatedHeadEvidenceResponder(bundle.attemptKey, commitSha)),
    );
    await expect(
      verifyGeneratedHeadOnce({
        prNumber: bundle.input.prNumber,
        commitSha,
        baseSha: bundle.input.baseSha,
        attemptKey: bundle.attemptKey,
        token: "token",
        request: success,
      }),
    ).resolves.toBe("success");
    expect(
      success.mock.calls.filter(
        ([apiPath, , options]) =>
          apiPath === "repos/NVIDIA/NemoClaw/check-runs" && options?.method === "POST",
      ),
    ).toHaveLength(5);

    const outputDirectory = temporaryDirectory();
    const failure = asGitHubRequest(
      vi.fn(
        generatedHeadEvidenceResponder(bundle.attemptKey, commitSha, {
          failedJob: "checks",
        }),
      ),
    );
    await expect(
      verifyGeneratedHeadWithReceipt({
        prNumber: bundle.input.prNumber,
        commitSha,
        sourceHeadSha: bundle.input.sourceHeadSha,
        baseSha: bundle.input.baseSha,
        attemptKey: bundle.attemptKey,
        token: "token",
        outputDirectory,
        request: failure,
      }),
    ).rejects.toThrow("checks failed generated-head validation");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(outputDirectory, "generated-head-verification-receipt.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      outcome: "manual-remediation-required",
      failedGate: "checks",
    });

    const duplicate = asGitHubRequest(
      vi.fn(
        generatedHeadEvidenceResponder(bundle.attemptKey, commitSha, {
          duplicateWorkflow: "pr.yaml",
        }),
      ),
    );
    await expect(
      verifyGeneratedHeadOnce({
        prNumber: bundle.input.prNumber,
        commitSha,
        baseSha: bundle.input.baseSha,
        attemptKey: bundle.attemptKey,
        token: "token",
        request: duplicate,
      }),
    ).rejects.toThrow("ambiguous generated-head validation results");
  });

  it.each(["head", "base"] as const)(
    "refuses to attest generated-head checks after the live %s changes (#10791)",
    async (changedIdentity) => {
      const bundle = selection();
      const commitSha = "d".repeat(40);
      const request = asGitHubRequest(
        vi.fn(
          generatedHeadEvidenceResponder(bundle.attemptKey, commitSha, {
            changedPullIdentity: changedIdentity,
          }),
        ),
      );

      await expect(
        verifyGeneratedHeadOnce({
          prNumber: bundle.input.prNumber,
          commitSha,
          baseSha: bundle.input.baseSha,
          attemptKey: bundle.attemptKey,
          token: "token",
          request,
        }),
      ).rejects.toThrow("no longer matches generated-head dispatch");
      expect(
        request.mock.calls.some(
          ([apiPath, , options]) =>
            apiPath === "repos/NVIDIA/NemoClaw/check-runs" && options?.method === "POST",
        ),
      ).toBe(false);
    },
  );
});
