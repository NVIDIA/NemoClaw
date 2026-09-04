// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  collectRepairSelectionAuthority,
  expectedAdvisorArtifactNames,
  type GitHubRequest as SelectionGitHubRequest,
} from "../../../tools/pr-review-advisor-repair/select.mts";

describe("PR Review Advisor repair Phase 1 permissions", () => {
  it("requires the pilot author and both dispatch identities to have maintain permission (#10791)", async () => {
    const sourceHeadSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const workflowSha = "c".repeat(40);
    const names = expectedAdvisorArtifactNames(700, 2);
    const pull = {
      number: 42,
      state: "open",
      draft: false,
      maintainer_can_modify: true,
      user: { login: "cjagwani" },
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
    };
    const advisorRun = {
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
    };
    const artifacts = {
      total_count: names.length,
      artifacts: names.map((name, index) => ({
        id: 100 + index,
        name,
        expired: false,
        size_in_bytes: 1024,
        digest: `sha256:${String(index).padStart(64, "0")}`,
        workflow_run: { id: 700, head_sha: workflowSha },
      })),
    };
    const maintainerOne = {
      permission: "write",
      role_name: "maintain",
      user: {
        login: "maintainer-one",
        permissions: { admin: false, maintain: true },
      },
    };
    const maintainerTwo = {
      permission: "write",
      role_name: "maintain",
      user: {
        login: "maintainer-two",
        permissions: { admin: false, maintain: true },
      },
    };
    const pilotAuthor = {
      permission: "write",
      role_name: "maintain",
      user: {
        login: "cjagwani",
        permissions: { admin: false, maintain: true },
      },
    };
    const requestMock = vi
      .fn()
      .mockResolvedValueOnce(pull)
      .mockResolvedValueOnce(advisorRun)
      .mockResolvedValueOnce(artifacts)
      .mockResolvedValueOnce(maintainerOne)
      .mockResolvedValueOnce(maintainerTwo)
      .mockResolvedValueOnce(pilotAuthor);

    const collected = await collectRepairSelectionAuthority(
      {
        token: "token",
        prNumber: 42,
        advisorRunId: 700,
        sourceHeadSha,
        actor: "maintainer-one",
        triggeringActor: "maintainer-two",
        findingIdsJson: JSON.stringify(["behavior:001"]),
      },
      requestMock as unknown as SelectionGitHubRequest,
    );

    expect(collected.authority.optIn).toMatchObject({
      actor: "maintainer-one",
      triggeringActor: "maintainer-two",
      headSha: sourceHeadSha,
    });
    expect(
      requestMock.mock.calls.filter(([apiPath]) => String(apiPath).includes("/collaborators/")),
    ).toHaveLength(3);
    expect(collected.authority.pullRequest.author).toBe("cjagwani");
    expect(collected.authority.productScope).toEqual({
      kind: "accepted-issue",
      identity: "#10791",
    });

    await expect(
      collectRepairSelectionAuthority(
        {
          token: "token",
          prNumber: 42,
          advisorRunId: 700,
          sourceHeadSha,
          actor: "maintainer-one",
          triggeringActor: "maintainer-two",
          findingIdsJson: JSON.stringify(["behavior:001"]),
        },
        vi.fn().mockResolvedValueOnce({
          ...pull,
          maintainer_can_modify: false,
        }) as unknown as SelectionGitHubRequest,
      ),
    ).rejects.toThrow("maintainer edits enabled");

    const deniedRequest = vi
      .fn()
      .mockResolvedValueOnce(pull)
      .mockResolvedValueOnce(advisorRun)
      .mockResolvedValueOnce(artifacts)
      .mockResolvedValueOnce(maintainerOne)
      .mockResolvedValueOnce({
        permission: "write",
        role_name: "write",
        user: {
          login: "maintainer-two",
          permissions: { admin: false, maintain: false },
        },
      })
      .mockResolvedValueOnce(pilotAuthor);

    await expect(
      collectRepairSelectionAuthority(
        {
          token: "token",
          prNumber: 42,
          advisorRunId: 700,
          sourceHeadSha,
          actor: "maintainer-one",
          triggeringActor: "maintainer-two",
          findingIdsJson: JSON.stringify(["behavior:001"]),
        },
        deniedRequest as unknown as SelectionGitHubRequest,
      ),
    ).rejects.toThrow("admin or maintain permission");
  });
});
