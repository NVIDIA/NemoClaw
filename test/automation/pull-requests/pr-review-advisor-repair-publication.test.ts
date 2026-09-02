// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { claimRepairAttempt } from "../../../tools/pr-review-advisor-repair/claim.mts";
import {
  parseSelectionInput,
  selectRepairAttempt,
  type FindingInput,
  type SelectionBundle,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  assertDcoDeclaration,
  collectGeneratedHeadContext,
} from "../../../tools/pr-review-advisor-repair/generated-head-context.mts";
import {
  atomicUpdate,
  dispatchGeneratedHeadValidation,
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

function selection(): SelectionBundle {
  const head = "a".repeat(40);
  return selectRepairAttempt(
    parseSelectionInput({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
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
    }),
  );
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
    await dispatchGeneratedHeadValidation(bundle, afterOid, "token", request);
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

  it("requires GitHub verification before publication (#10791)", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ verification: { verified: false, reason: "unsigned" } })
      .mockResolvedValueOnce({ verification: { verified: true, reason: "valid" } });
    const wait = vi.fn().mockResolvedValue(undefined);

    await waitForVerifiedCommit("d".repeat(40), "token", request, wait);
    expect(request).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(5000);
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
});
