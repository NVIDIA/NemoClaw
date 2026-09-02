// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { claimRepairAttempt } from "../../../tools/pr-review-advisor-repair/claim.mts";
import {
  parseValidatedReceiptForPublication,
  parseValidationReceipt,
  parseSelectionInput,
  selectRepairAttempt,
  sha256,
  type FindingInput,
  type SelectionBundle,
  type ValidationReceipt,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  assertDcoDeclaration,
  collectGeneratedHeadContext,
} from "../../../tools/pr-review-advisor-repair/generated-head-context.mts";
import {
  assertPublicationPullRequest,
  atomicUpdate,
  dispatchGeneratedHeadValidation,
  publishValidatedRepair,
  reconstructValidatedTree,
  waitForVerifiedCommit,
} from "../../../tools/pr-review-advisor-repair/publish.mts";
import {
  collectRepairSelection,
  expectedAdvisorArtifactNames,
  type GitHubRequest as SelectionGitHubRequest,
} from "../../../tools/pr-review-advisor-repair/select.mts";
import { verifyGeneratedHeadOnce } from "../../../tools/pr-review-advisor-repair/verify-generated-head.mts";

function finding(): FindingInput {
  return {
    id: "behavior:001",
    repairClass: "source",
    summary: "Return the normalized value without changing the public contract.",
    path: "src/demo.ts",
    exclusions: [],
  };
}

function selection(overrides: Record<string, unknown> = {}): SelectionBundle {
  const head = "a".repeat(40);
  return selectRepairAttempt(
    parseSelectionInput({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
        author: "contributor",
        baseRef: "main",
        headRepository: "NVIDIA/NemoClaw",
        headRef: "fix/demo",
        maintainerCanModify: true,
      },
      sourceHeadSha: head,
      baseSha: "b".repeat(40),
      advisor: {
        workflowSha: "c".repeat(40),
        runId: 700,
        runAttempt: 2,
        artifactIds: Array.from({ length: 10 }, (_value, index) => index + 100),
      },
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha: head,
      },
      productScope: {
        kind: "accepted-issue",
        identity: "#10791",
      },
      findings: [finding()],
      ...overrides,
    }),
  );
}

function validationReceipt(
  bundle: SelectionBundle,
  patch: Buffer,
  overrides: Partial<ValidationReceipt> = {},
): ValidationReceipt {
  const candidateDigest = `sha256:${sha256("candidate")}`;
  return {
    version: 1,
    attemptKey: bundle.attemptKey,
    repository: "NVIDIA/NemoClaw",
    prNumber: bundle.input.prNumber,
    author: bundle.input.pullRequest.author,
    headRef: bundle.input.pullRequest.headRef,
    sourceHeadSha: bundle.input.sourceHeadSha,
    baseSha: bundle.input.baseSha,
    advisor: bundle.input.advisor,
    findingIds: bundle.selectedFindingIds,
    selectedPaths: bundle.selectedPaths,
    patchSha256: sha256(patch),
    candidateTreeSha: "f".repeat(40),
    changedPaths: [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 24 }],
    validation: {
      candidateDigestBefore: candidateDigest,
      candidateDigestAfter: candidateDigest,
      commands: [{ argv: ["npm", "run", "test:fast"], exitCode: 0 }],
    },
    productScope: bundle.input.productScope,
    optIn: bundle.input.optIn,
    outcome: "validated",
    reason: null,
    ...overrides,
  };
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

describe("PR Review Advisor repair Phase 1 publication", () => {
  it("claims an exact attempt once with a neutral GitHub check (#10791)", async () => {
    const bundle = selection();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ total_count: 0, check_runs: [] })
      .mockResolvedValueOnce({ id: 9001 });

    await expect(
      claimRepairAttempt(bundle, "token", "https://example.test/run", request),
    ).resolves.toBe(9001);
    expect(request).toHaveBeenLastCalledWith(
      "repos/NVIDIA/NemoClaw/check-runs",
      "token",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          name: "Advisor repair attempt",
          head_sha: bundle.input.sourceHeadSha,
          external_id: bundle.attemptKey,
          conclusion: "neutral",
        }),
      }),
    );

    const duplicateRequest = vi.fn().mockResolvedValue({
      total_count: 1,
      check_runs: [{ id: 7, name: "Advisor repair attempt", external_id: bundle.attemptKey }],
    });
    await expect(
      claimRepairAttempt(bundle, "token", "https://example.test/run", duplicateRequest),
    ).rejects.toThrow("already claimed");
    expect(duplicateRequest).toHaveBeenCalledTimes(1);
  });

  it("requires both dispatch identities to have maintain permission (#10791)", async () => {
    const sourceHeadSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const workflowSha = "c".repeat(40);
    const names = expectedAdvisorArtifactNames(700, 2);
    const requestMock = vi
      .fn()
      .mockResolvedValueOnce({
        number: 42,
        state: "open",
        draft: false,
        maintainer_can_modify: true,
        user: { login: "contributor" },
        head: {
          sha: sourceHeadSha,
          ref: "fix/demo",
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        base: {
          sha: baseSha,
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
      })
      .mockResolvedValueOnce({
        id: 700,
        run_attempt: 2,
        event: "pull_request_target",
        status: "completed",
        conclusion: "success",
        name: "Automation / PR Review Advisor",
        path: ".github/workflows/pr-review-advisor.yaml",
        head_sha: workflowSha,
        repository: { full_name: "NVIDIA/NemoClaw" },
        head_repository: { full_name: "NVIDIA/NemoClaw" },
        pull_requests: [{ number: 42 }],
      })
      .mockResolvedValueOnce({
        total_count: names.length,
        artifacts: names.map((name, index) => ({
          id: 100 + index,
          name,
          expired: false,
          size_in_bytes: 1024,
          digest: `sha256:${String(index).padStart(64, "0")}`,
          workflow_run: { id: 700, head_sha: workflowSha },
        })),
      })
      .mockResolvedValueOnce({
        permission: "write",
        role_name: "maintain",
        user: {
          login: "maintainer-one",
          permissions: { admin: false, maintain: true },
        },
      })
      .mockResolvedValueOnce({
        permission: "write",
        role_name: "maintain",
        user: {
          login: "maintainer-two",
          permissions: { admin: false, maintain: true },
        },
      });
    const request = requestMock as unknown as SelectionGitHubRequest;

    const collected = await collectRepairSelection(
      {
        token: "token",
        prNumber: 42,
        advisorRunId: 700,
        sourceHeadSha,
        actor: "maintainer-one",
        triggeringActor: "maintainer-two",
        productScopeKind: "maintainer-decision",
        productScopeIdentity: "#10791-maintainer-comment",
        findingsJson: JSON.stringify([finding()]),
      },
      request,
    );

    expect(collected.selection.input.optIn).toMatchObject({
      actor: "maintainer-one",
      triggeringActor: "maintainer-two",
      headSha: sourceHeadSha,
    });
    expect(
      requestMock.mock.calls.filter(([apiPath]) => String(apiPath).includes("/collaborators/")),
    ).toHaveLength(2);
  });

  it("rejects a changed PR author at the publication boundary (#10791)", () => {
    const bundle = selection();
    const receipt = validationReceipt(bundle, Buffer.from("validated patch"));

    expect(() =>
      assertPublicationPullRequest(receipt, {
        number: bundle.input.prNumber,
        state: "open",
        draft: false,
        maintainer_can_modify: true,
        user: { login: "different-author" },
        head: {
          sha: bundle.input.sourceHeadSha,
          ref: bundle.input.pullRequest.headRef,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        base: {
          sha: bundle.input.baseSha,
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
        },
      }),
    ).toThrow("identity or ownership changed");
  });

  it("rejects a validation receipt whose patch digest does not match (#10791)", () => {
    const bundle = selection();
    const patch = Buffer.from("not the validated patch\n");
    const candidateDigest = `sha256:${sha256("candidate")}`;
    const receipt: ValidationReceipt = {
      version: 1,
      attemptKey: bundle.attemptKey,
      repository: "NVIDIA/NemoClaw",
      prNumber: bundle.input.prNumber,
      author: bundle.input.pullRequest.author,
      headRef: bundle.input.pullRequest.headRef,
      sourceHeadSha: bundle.input.sourceHeadSha,
      baseSha: bundle.input.baseSha,
      advisor: bundle.input.advisor,
      findingIds: bundle.selectedFindingIds,
      selectedPaths: bundle.selectedPaths,
      patchSha256: "0".repeat(64),
      candidateTreeSha: "f".repeat(40),
      changedPaths: [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 24 }],
      validation: {
        candidateDigestBefore: candidateDigest,
        candidateDigestAfter: candidateDigest,
        commands: [{ argv: ["npm", "run", "test:fast"], exitCode: 0 }],
      },
      productScope: bundle.input.productScope,
      optIn: bundle.input.optIn,
      outcome: "validated",
      reason: null,
    };

    expect(() => parseValidationReceipt(receipt, bundle, patch)).toThrow("patch digest is invalid");
  });

  it("parses a self-contained validator receipt and recomputes its attempt identity (#10791)", () => {
    const bundle = selection();
    const patch = Buffer.from("validated patch\n");
    const receipt = validationReceipt(bundle, patch);

    expect(parseValidatedReceiptForPublication(receipt, patch)).toEqual(receipt);
    expect(() =>
      parseValidatedReceiptForPublication(
        { ...receipt, selectedPaths: ["scripts/unsafe.sh"] },
        patch,
      ),
    ).toThrow("selected paths are unsupported");
    expect(() =>
      parseValidatedReceiptForPublication({ ...receipt, author: "bad login" }, patch),
    ).toThrow("supported GitHub login");
    expect(() =>
      parseValidatedReceiptForPublication(
        { ...receipt, attemptKey: `sha256:${"0".repeat(64)}` },
        patch,
      ),
    ).toThrow("attempt digest is invalid");
  });

  it("binds generated-head validation to the live exact PR and checks DCO (#10791)", async () => {
    const bundle = selection();
    const request = vi.fn().mockResolvedValue({
      number: bundle.input.prNumber,
      state: "open",
      draft: false,
      maintainer_can_modify: true,
      title: "fix(cli): preserve exact generated head",
      body: "Summary\n\nSigned-off-by: Maintainer <maintainer@example.com>",
      user: { login: "maintainer" },
      head: {
        sha: bundle.input.sourceHeadSha,
        repo: { full_name: "NVIDIA/NemoClaw" },
      },
      base: {
        sha: bundle.input.baseSha,
        ref: "main",
        repo: { full_name: "NVIDIA/NemoClaw" },
      },
    });
    const context = await collectGeneratedHeadContext(
      {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_SHA: bundle.input.sourceHeadSha,
        GITHUB_TOKEN: "token",
        PR_NUMBER: String(bundle.input.prNumber),
        SOURCE_HEAD_SHA: bundle.input.sourceHeadSha,
        BASE_SHA: bundle.input.baseSha,
        REPAIR_ATTEMPT_KEY: bundle.attemptKey,
      },
      request,
    );

    expect(context.repairAttemptKey).toBe(bundle.attemptKey);
    expect(() => assertDcoDeclaration(context)).not.toThrow();
    await expect(
      collectGeneratedHeadContext(
        {
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          GITHUB_SHA: "f".repeat(40),
          GITHUB_TOKEN: "token",
          PR_NUMBER: String(bundle.input.prNumber),
          SOURCE_HEAD_SHA: bundle.input.sourceHeadSha,
          BASE_SHA: bundle.input.baseSha,
          REPAIR_ATTEMPT_KEY: bundle.attemptKey,
        },
        request,
      ),
    ).rejects.toThrow("not executing the requested exact head");
  });

  it("uses an atomic non-force update and exact generated-head dispatch payloads (#10791)", async () => {
    const bundle = selection();
    const afterOid = "d".repeat(40);
    const graphql = vi.fn().mockResolvedValue({
      data: { updateRefs: { clientMutationId: afterOid } },
    });
    await atomicUpdate({
      repositoryId: "R_repo",
      headRef: bundle.input.pullRequest.headRef,
      beforeOid: bundle.input.sourceHeadSha,
      afterOid,
      graphql,
    });
    expect(graphql.mock.calls[0]?.[1]).toEqual({
      input: {
        clientMutationId: afterOid,
        repositoryId: "R_repo",
        refUpdates: [
          {
            name: `refs/heads/${bundle.input.pullRequest.headRef}`,
            beforeOid: bundle.input.sourceHeadSha,
            afterOid,
            force: false,
          },
        ],
      },
    });

    const request = vi.fn().mockResolvedValue({});
    await dispatchGeneratedHeadValidation(
      validationReceipt(bundle, Buffer.from("validated patch")),
      afterOid,
      "token",
      request,
    );
    expect(request).toHaveBeenCalledTimes(6);
    expect(request.mock.calls.at(-1)?.[2]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          inputs: expect.objectContaining({
            source_head_sha: afterOid,
            base_sha: bundle.input.baseSha,
            repair_attempt_key: bundle.attemptKey,
          }),
        }),
      }),
    );
  });

  it("rejects an unconfirmed compare-and-swap ref update (#10791)", async () => {
    const bundle = selection();

    await expect(
      atomicUpdate({
        repositoryId: "R_repo",
        headRef: bundle.input.pullRequest.headRef,
        beforeOid: bundle.input.sourceHeadSha,
        afterOid: "d".repeat(40),
        graphql: vi.fn().mockResolvedValue({
          data: { updateRefs: { clientMutationId: "e".repeat(40) } },
        }),
      }),
    ).rejects.toThrow("did not confirm the atomic repair ref update");
  });

  it("reconstructs and publishes the validated tree through deterministic GitHub calls (#10791)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-advisor-publisher-test-"));
    try {
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
      git(repository, ["commit", "-m", "test: add publisher PR head"]);
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
        optIn: {
          kind: "phase1-maintainer-dispatch",
          actor: "maintainer",
          triggeringActor: "maintainer",
          headSha: sourceHeadSha,
        },
      });
      const candidateDigest = `sha256:${sha256("candidate")}`;
      const receipt: ValidationReceipt = {
        version: 1,
        attemptKey: bundle.attemptKey,
        repository: "NVIDIA/NemoClaw",
        prNumber: bundle.input.prNumber,
        author: bundle.input.pullRequest.author,
        headRef: bundle.input.pullRequest.headRef,
        sourceHeadSha,
        baseSha,
        advisor: bundle.input.advisor,
        findingIds: bundle.selectedFindingIds,
        selectedPaths: bundle.selectedPaths,
        patchSha256: sha256(patch),
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
        validation: {
          candidateDigestBefore: candidateDigest,
          candidateDigestAfter: candidateDigest,
          commands: [{ argv: ["npm", "run", "test:fast"], exitCode: 0 }],
        },
        productScope: bundle.input.productScope,
        optIn: bundle.input.optIn,
        outcome: "validated",
        reason: null,
      };
      expect(() =>
        reconstructValidatedTree({
          sourceCheckout: repository,
          receipt: { ...receipt, candidateTreeSha: "f".repeat(40) },
          patchFile,
          stagingDirectory: path.join(root, "mismatched-publisher"),
        }),
      ).toThrow("reconstructed a different candidate tree");
      expect(() =>
        reconstructValidatedTree({
          sourceCheckout: repository,
          receipt: {
            ...receipt,
            changedPaths: [
              {
                ...receipt.changedPaths[0]!,
                bytes: receipt.changedPaths[0]!.bytes + 1,
              },
            ],
          },
          patchFile,
          stagingDirectory: path.join(root, "mismatched-receipt-metadata"),
        }),
      ).toThrow("candidate differs from the validation receipt");
      const commitSha = "d".repeat(40);
      const pullRequest = {
        number: bundle.input.prNumber,
        state: "open",
        draft: false,
        maintainer_can_modify: true,
        user: { login: bundle.input.pullRequest.author },
        head: {
          sha: sourceHeadSha,
          ref: bundle.input.pullRequest.headRef,
          repo: { full_name: "NVIDIA/NemoClaw" },
        },
        base: {
          sha: baseSha,
          ref: "main",
          repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
        },
      };
      const workflowNames = [
        "pr.yaml",
        "commit-lint.yaml",
        "dco-check.yaml",
        "installer-hash-check.yaml",
        "code-scanning.yaml",
        "pr-review-advisor.yaml",
      ];
      const responseEntries: Array<[string, unknown[]]> = [
        ["GET repos/NVIDIA/NemoClaw/pulls/42", [pullRequest, pullRequest]],
        ...workflowNames.map((workflow): [string, unknown[]] => [
          `GET repos/NVIDIA/NemoClaw/actions/workflows/${workflow}`,
          [{ state: "active", path: `.github/workflows/${workflow}` }],
        ]),
        ["POST repos/NVIDIA/NemoClaw/git/blobs", [{ sha: candidateBlobSha }]],
        ["POST repos/NVIDIA/NemoClaw/git/trees", [{ sha: candidateTreeSha }]],
        ["POST repos/NVIDIA/NemoClaw/git/commits", [{ sha: commitSha }]],
        [
          `GET repos/NVIDIA/NemoClaw/git/commits/${commitSha}`,
          [
            {
              sha: commitSha,
              message: `fix(advisor): apply validated review repair\n\nAdvisor-Repair-Attempt: ${bundle.attemptKey}`,
              tree: { sha: candidateTreeSha },
              parents: [{ sha: sourceHeadSha }],
              verification: { verified: true, reason: "valid" },
            },
          ],
        ],
        ...workflowNames.map((workflow): [string, unknown[]] => [
          `POST repos/NVIDIA/NemoClaw/actions/workflows/${workflow}/dispatches`,
          [{}],
        ]),
      ];
      const responses = new Map(responseEntries);
      const requestMock = vi.fn(
        async (
          apiPath: string,
          _token: string,
          options?: { method?: string; body?: unknown },
        ): Promise<unknown> => {
          const key = `${options?.method ?? "GET"} ${apiPath}`;
          const queue = responses.get(key);
          expect(queue, `unexpected GitHub request: ${key}`).toBeDefined();
          expect(queue, `exhausted GitHub response queue: ${key}`).not.toHaveLength(0);
          return queue?.shift();
        },
      );
      const request = requestMock as unknown as NonNullable<
        Parameters<typeof publishValidatedRepair>[0]["request"]
      >;
      const graphql = vi.fn(async () => ({
        data: { updateRefs: { clientMutationId: commitSha } },
      }));

      const publication = await publishValidatedRepair({
        sourceCheckout: repository,
        receipt,
        patchFile,
        stagingDirectory: path.join(root, "publisher"),
        token: "token",
        request,
        graphql,
      });

      expect(publication).toMatchObject({
        attemptKey: bundle.attemptKey,
        sourceHeadSha,
        candidateTreeSha,
        commitSha,
        headRef: bundle.input.pullRequest.headRef,
      });
      expect(Array.from(responses.values()).flat()).toEqual([]);
      expect(
        requestMock.mock.calls.find(
          ([apiPath, , options]) =>
            apiPath === "repos/NVIDIA/NemoClaw/git/commits" && options?.method === "POST",
        )?.[2]?.body,
      ).toEqual(
        expect.objectContaining({
          tree: candidateTreeSha,
          parents: [sourceHeadSha],
        }),
      );
      expect(graphql).toHaveBeenCalledWith(expect.stringContaining("updateRefs"), {
        input: expect.objectContaining({
          repositoryId: "R_repo",
          refUpdates: [
            expect.objectContaining({
              beforeOid: sourceHeadSha,
              afterOid: commitSha,
              force: false,
            }),
          ],
        }),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires GitHub verification before publication (#10791)", async () => {
    const commitSha = "d".repeat(40);
    const parentSha = "a".repeat(40);
    const treeSha = "e".repeat(40);
    const message = "fix(advisor): test";
    const request = vi
      .fn()
      .mockResolvedValueOnce({ verification: { verified: false, reason: "unsigned" } })
      .mockResolvedValueOnce({
        sha: commitSha,
        message,
        tree: { sha: treeSha },
        parents: [{ sha: parentSha }],
        verification: { verified: true, reason: "valid" },
      });
    const wait = vi.fn().mockResolvedValue(undefined);

    await waitForVerifiedCommit({ commitSha, message, parentSha, treeSha }, "token", request, wait);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5000);
  });

  it("rejects a verified commit with a different approved tree or parent (#10791)", async () => {
    const commitSha = "d".repeat(40);
    const request = vi.fn().mockResolvedValue({
      sha: commitSha,
      message: "fix(advisor): test",
      tree: { sha: "f".repeat(40) },
      parents: [{ sha: "a".repeat(40) }],
      verification: { verified: true, reason: "valid" },
    });

    await expect(
      waitForVerifiedCommit(
        {
          commitSha,
          message: "fix(advisor): test",
          parentSha: "a".repeat(40),
          treeSha: "e".repeat(40),
        },
        "token",
        request,
        vi.fn(),
      ),
    ).rejects.toThrow("verified repair commit does not match the approved one-parent tree");
  });

  it("fails closed when GitHub never verifies the commit (#10791)", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ verification: { verified: false, reason: "unsigned" } });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForVerifiedCommit(
        {
          commitSha: "d".repeat(40),
          message: "fix(advisor): test",
          parentSha: "a".repeat(40),
          treeSha: "e".repeat(40),
        },
        "token",
        request,
        wait,
      ),
    ).rejects.toThrow("GitHub did not verify the repair commit before publication");
    expect(request).toHaveBeenCalledTimes(12);
    expect(wait).toHaveBeenCalledTimes(11);
  });

  it("accepts generated-head gates only from the exact commit (#10791)", async () => {
    const bundle = selection();
    const commitSha = "d".repeat(40);
    const checks = ["changes", "checks", "commit-lint", "dco-check", "check-hash"].map((name) => ({
      name,
      head_sha: commitSha,
      status: "completed",
      conclusion: "success",
      app: { slug: "github-actions" },
    }));
    const successfulWorkflow = {
      event: "workflow_dispatch",
      head_sha: commitSha,
      status: "completed",
      conclusion: "success",
      display_title: `Generated-head ${bundle.attemptKey}`,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ total_count: checks.length, check_runs: checks })
      .mockResolvedValueOnce({ total_count: 1, workflow_runs: [successfulWorkflow] })
      .mockResolvedValueOnce({ total_count: 1, workflow_runs: [successfulWorkflow] });

    await expect(
      verifyGeneratedHeadOnce({
        commitSha,
        headRef: bundle.input.pullRequest.headRef,
        attemptKey: bundle.attemptKey,
        token: "token",
        request,
      }),
    ).resolves.toBe("success");
  });

  it("fails closed when an exact generated-head required check fails (#10791)", async () => {
    const bundle = selection();
    const commitSha = "d".repeat(40);
    const checks = ["changes", "checks", "commit-lint", "dco-check", "check-hash"].map((name) => ({
      name,
      head_sha: commitSha,
      status: "completed",
      conclusion: name === "checks" ? "failure" : "success",
      app: { slug: "github-actions" },
    }));
    const request = vi.fn().mockResolvedValueOnce({
      total_count: checks.length,
      check_runs: checks,
    });

    await expect(
      verifyGeneratedHeadOnce({
        commitSha,
        headRef: bundle.input.pullRequest.headRef,
        attemptKey: bundle.attemptKey,
        token: "token",
        request,
      }),
    ).rejects.toThrow("checks failed generated-head validation");
  });

  it("fails closed on ambiguous duplicate generated-head evidence (#10791)", async () => {
    const bundle = selection();
    const commitSha = "d".repeat(40);
    const successfulCheck = {
      name: "checks",
      head_sha: commitSha,
      status: "completed",
      conclusion: "success",
      app: { slug: "github-actions" },
    };
    const checks = [
      ...["changes", "commit-lint", "dco-check", "check-hash"].map((name) => ({
        ...successfulCheck,
        name,
      })),
      successfulCheck,
      { ...successfulCheck },
    ];
    const request = vi.fn().mockResolvedValueOnce({
      total_count: checks.length,
      check_runs: checks,
    });

    await expect(
      verifyGeneratedHeadOnce({
        commitSha,
        headRef: bundle.input.pullRequest.headRef,
        attemptKey: bundle.attemptKey,
        token: "token",
        request,
      }),
    ).rejects.toThrow("ambiguous generated-head validation results");
  });
});
