// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { readApprovedCandidateUpgrade } from "../../../tools/e2e/candidate-upgrade-admission.mts";

const identity = { prNumber: 123, candidateSha: "a".repeat(40), baseSha: "b".repeat(40) };
const sourcePath = "ci/candidate.json";
function fixture() {
  const repository = { full_name: "NVIDIA/NemoClaw" };
  const pr = {
    number: identity.prNumber,
    state: "open",
    user: { login: "author" },
    head: { sha: identity.candidateSha, repo: { ...repository } },
    base: { sha: identity.baseSha, ref: "main", repo: { ...repository } },
  };
  const approval = {
    id: 50,
    user: { login: "reviewer", type: "User" },
    submitted_at: "2026-10-14T00:00:00Z",
    state: "APPROVED",
    commit_id: identity.candidateSha,
  };
  const records = [approval];
  const permission = { role_name: "maintain" };
  const source = '{"version":"9.8.7"}';
  const blob = {
    type: "file",
    path: sourcePath,
    encoding: "base64",
    size: Buffer.byteLength(source),
    content: Buffer.from(source).toString("base64"),
  };
  const routes = new Map<string, unknown>([
    ["/repos/NVIDIA/NemoClaw/pulls/123", pr],
    ["/repos/NVIDIA/NemoClaw/pulls/123/reviews?per_page=100&page=1", records],
    ["/repos/NVIDIA/NemoClaw/collaborators/reviewer/permission", permission],
    [`/repos/NVIDIA/NemoClaw/contents/${sourcePath}?ref=${identity.candidateSha}`, blob],
  ]);
  routes.set(
    `/repos/NVIDIA/NemoClaw/compare/${identity.baseSha}...${identity.candidateSha}?per_page=1`,
    {
      status: "ahead",
      base_commit: { sha: identity.baseSha },
      merge_base_commit: { sha: identity.baseSha },
      files: [],
    },
  );
  const request = vi.fn(async (path: string): Promise<unknown> => routes.get(path));
  return { pr, approval, records, permission, source, blob, request, routes };
}

function mergeFixture() {
  const f = fixture();
  const mergeSha = "c".repeat(40);
  const pr = Object.assign(f.pr, { merge_commit_sha: mergeSha });
  const commit = {
    sha: mergeSha,
    parents: [{ sha: identity.baseSha }, { sha: identity.candidateSha }],
  };
  f.routes.set(`/repos/NVIDIA/NemoClaw/git/commits/${mergeSha}`, commit);
  const mergeSource = '{"version":"9.8.7","merged":true}';
  f.routes.set(`/repos/NVIDIA/NemoClaw/contents/${sourcePath}?ref=${mergeSha}`, {
    ...f.blob,
    size: Buffer.byteLength(mergeSource),
    content: Buffer.from(mergeSource).toString("base64"),
  });
  return { ...f, pr, commit, mergeSha, mergeSource };
}

function retainedReviewFixture() {
  const f = fixture();
  const reviewed = "d".repeat(40);
  const oldBase = "e".repeat(40);
  f.approval.commit_id = reviewed;
  const changes = {
    status: "ahead",
    base_commit: { sha: reviewed },
    merge_base_commit: { sha: reviewed },
    files: [{ filename: "test/unrelated.test.ts" }],
  };
  const policy = {
    status: "ahead",
    base_commit: { sha: oldBase },
    merge_base_commit: { sha: oldBase },
    files: [{ filename: "package-lock.json" }],
  };
  f.routes.set(
    `/repos/NVIDIA/NemoClaw/compare/${reviewed}...${identity.candidateSha}?per_page=1`,
    changes,
  );
  f.routes.set(`/repos/NVIDIA/NemoClaw/compare/${identity.baseSha}...${reviewed}?per_page=1`, {
    status: "diverged",
    base_commit: { sha: identity.baseSha },
    merge_base_commit: { sha: oldBase },
  });
  f.routes.set(
    `/repos/NVIDIA/NemoClaw/compare/${oldBase}...${identity.baseSha}?per_page=1`,
    policy,
  );
  return { ...f, reviewed, changes, policy };
}

describe("candidate upgrade admission", () => {
  it("retains approval after an unrelated test edit and a main lockfile synchronization", async () => {
    const f = retainedReviewFixture();
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).resolves.toEqual({
      sources: { [sourcePath]: f.source },
      reviewer: "reviewer",
      reviewId: 50,
    });
  });

  it.each([
    sourcePath,
    "tools/e2e/candidate-upgrade-admission.mts",
    "scripts/checks/extract-installer-pins.mts",
  ])("requires a new review after changing %s", async (filename) => {
    const f = retainedReviewFixture();
    f.changes.files = [{ filename }];
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /PR approval covering/,
    );
  });

  it("requires renewed review when main changes the trusted verification policy", async () => {
    const f = retainedReviewFixture();
    f.policy.files = [{ filename: "tools/e2e/candidate-review-scope.mts" }];
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /PR approval covering/,
    );
  });

  it.each(
    [
      {
        admission: "installer",
        path: sourcePath,
        history: "changes" as const,
        branch: "candidate",
      },
      {
        admission: "installer",
        path: sourcePath,
        history: "policy" as const,
        branch: "trusted base",
      },
      { admission: "SDK", path: "package.json", history: "changes" as const, branch: "candidate" },
      {
        admission: "SDK",
        path: "package.json",
        history: "policy" as const,
        branch: "trusted base",
      },
    ].flatMap((scenario) =>
      [
        "tools/e2e/protected-openshell-projection.mts",
        "tools/e2e/protected-openshell-filesystem.mts",
        "tools/e2e/protected-openshell-filesystem.py",
      ].map((policyPath) => ({ ...scenario, policyPath })),
    ),
  )(
    "invalidates $admission approval when the $branch changes projection policy $policyPath",
    async ({ path, history, policyPath }) => {
      const f = retainedReviewFixture();
      f.routes.set(`/repos/NVIDIA/NemoClaw/contents/${path}?ref=${identity.candidateSha}`, {
        ...f.blob,
        path,
      });
      await expect(
        readApprovedCandidateUpgrade(identity, [path], f.request),
      ).resolves.toMatchObject({
        reviewId: 50,
      });
      f[history].files = [{ filename: policyPath }];
      await expect(readApprovedCandidateUpgrade(identity, [path], f.request)).rejects.toThrow(
        /PR approval covering/,
      );
    },
  );

  it("includes the previous name when a sensitive input is renamed", async () => {
    const f = retainedReviewFixture();
    Object.assign(f.changes.files[0]!, { previous_filename: sourcePath });
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /PR approval covering/,
    );
  });

  it.each(["unrelated-history", "truncated", "missing-files", "invalid-path", "wrong-base"])(
    "denies reuse with %s comparison evidence",
    async (kind) => {
      const f = retainedReviewFixture();
      const mutate: Record<string, () => unknown> = {
        "unrelated-history": () => {
          f.changes.merge_base_commit.sha = "f".repeat(40);
        },
        truncated: () => {
          f.changes.files = Array.from({ length: 300 }, () => ({ filename: "docs/example.mdx" }));
        },
        "missing-files": () => Object.assign(f.changes, { files: undefined }),
        "invalid-path": () => Object.assign(f.changes, { files: [null] }),
        "wrong-base": () => {
          f.changes.base_commit.sha = "f".repeat(40);
        },
      };
      const error: Record<string, string> = {
        "unrelated-history": "PR approval covering",
        truncated: "incomplete file list",
        "missing-files": "incomplete file list",
        "invalid-path": "invalid file path",
        "wrong-base": "invalid commit identities",
      };
      mutate[kind]!();
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        error[kind]!,
      );
    },
  );

  it("denies review reuse when the comparison API is unavailable", async () => {
    const f = retainedReviewFixture();
    const comparison = `/repos/NVIDIA/NemoClaw/compare/${f.reviewed}...${identity.candidateSha}?per_page=1`;
    const responses = new Map([...f.routes].map(([path, value]) => [path, async () => value]));
    responses.set(comparison, async () => {
      throw new Error("API unavailable");
    });
    f.request.mockImplementation(async (path) => responses.get(path)!());
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      "comparison was unavailable",
    );
    expect(f.request).toHaveBeenCalledWith(comparison);
  });

  it.each(["package.json", "scripts/lib/reviewed-npm-archive.mts", ".github/workflows/pr.yaml"])(
    "requires a new SDK review when %s changes",
    async (filename) => {
      const f = retainedReviewFixture();
      f.changes.files = [{ filename }];
      await expect(
        readApprovedCandidateUpgrade(identity, ["package.json"], f.request),
      ).rejects.toThrow(/PR approval covering/);
    },
  );

  it.each(["unavailable", "truncated", "invalid-identity"])(
    "accepts an independently covered review after another comparison is %s",
    async (kind) => {
      const f = retainedReviewFixture();
      f.records.push({
        ...f.approval,
        id: 49,
        commit_id: identity.candidateSha,
        user: { type: "User", login: "other" },
      });
      f.routes.set("/repos/NVIDIA/NemoClaw/collaborators/other/permission", {
        role_name: "maintain",
      });
      const mutations: Record<string, () => void> = {
        unavailable: () => {
          const responses = new Map(
            [...f.routes].map(([path, value]) => [path, async () => value]),
          );
          responses.set(
            `/repos/NVIDIA/NemoClaw/compare/${f.reviewed}...${identity.candidateSha}?per_page=1`,
            async () => {
              throw new Error("private transport diagnostic");
            },
          );
          f.request.mockImplementation(async (path) => responses.get(path)!());
        },
        truncated: () => {
          f.changes.files = Array.from({ length: 300 }, () => ({ filename: "docs/example.mdx" }));
        },
        "invalid-identity": () => {
          f.changes.base_commit.sha = "f".repeat(40);
        },
      };
      mutations[kind]!();
      await expect(
        readApprovedCandidateUpgrade(identity, [sourcePath], f.request),
      ).resolves.toMatchObject({ reviewId: 49, reviewer: "other" });
    },
  );

  it.each(["changes", "policy"] as const)(
    "reports the required recovery for an incomplete %s comparison",
    async (history) => {
      const f = retainedReviewFixture();
      f[history].files = Array.from({ length: 300 }, () => ({ filename: "docs/example.mdx" }));
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        history === "policy"
          ? "synchronize the branch and obtain a new review"
          : "refresh the review",
      );
      expect(f.request.mock.calls.some(([path]) => path.includes("/contents/"))).toBe(false);
    },
  );

  it.each(["permission", "review-state"])(
    "does not skip an invalid %s record in favor of another approval",
    async (kind) => {
      const f = fixture();
      f.records.push({ ...f.approval, id: 49, user: { type: "User", login: "other" } });
      f.routes.set("/repos/NVIDIA/NemoClaw/collaborators/other/permission", {
        role_name: "maintain",
      });
      const mutations: Record<string, () => void> = {
        permission: () => {
          f.routes.set("/repos/NVIDIA/NemoClaw/collaborators/reviewer/permission", null);
        },
        "review-state": () => {
          f.approval.state = "unknown";
        },
      };
      mutations[kind]!();
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        /invalid GitHub record|unknown review state/,
      );
      expect(f.request.mock.calls.some(([path]) => path.includes("/contents/"))).toBe(false);
    },
  );

  it("does not discard approval when the reviewer adds an ordinary comment", async () => {
    const f = fixture();
    f.records.push({ ...f.approval, id: 51, state: "COMMENTED" });
    await expect(
      readApprovedCandidateUpgrade(identity, [sourcePath], f.request),
    ).resolves.toMatchObject({ reviewId: 50 });
  });

  it("does not revive an older approval after dismissing the replacement review", async () => {
    const f = fixture();
    f.records.push({ ...f.approval, id: 51, state: "DISMISSED" });
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /PR approval covering/,
    );
  });

  it("honors another maintainer's outstanding request for changes", async () => {
    const f = fixture();
    f.records.push({
      ...f.approval,
      id: 51,
      user: { type: "User", login: "other" },
      state: "CHANGES_REQUESTED",
    });
    f.routes.set("/repos/NVIDIA/NemoClaw/collaborators/other/permission", {
      role_name: "maintain",
    });
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /changes-requested/,
    );
  });

  it.each(["duplicate", "invalid-id", "invalid-time", "mutable-commit", "unknown-state"])(
    "rejects %s review evidence",
    async (kind) => {
      const f = fixture();
      const mutate: Record<string, () => unknown> = {
        duplicate: () => f.records.push({ ...f.approval }),
        "invalid-id": () => {
          f.approval.id = 0;
        },
        "invalid-time": () => {
          f.approval.submitted_at = "invalid";
        },
        "mutable-commit": () => {
          f.approval.commit_id = "main";
        },
        "unknown-state": () => {
          f.approval.state = "unknown";
        },
      };
      mutate[kind]!();
      await expect(
        readApprovedCandidateUpgrade(identity, [sourcePath], f.request),
      ).rejects.toThrow();
    },
  );

  it("reads reviewed commit data and rechecks both PR identity and current maintainer authority", async () => {
    const f = fixture();
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).resolves.toEqual({
      sources: { [sourcePath]: f.source },
      reviewer: "reviewer",
      reviewId: 50,
    });
    expect(f.request.mock.calls.filter(([path]) => path.endsWith("/permission"))).toHaveLength(2);
    expect(f.request.mock.calls.filter(([path]) => path.endsWith("/pulls/123"))).toHaveLength(2);
  });

  it("accepts a bot-authored PR only with an independent human maintainer's approval", async () => {
    const f = fixture();
    f.pr.user.login = "nvidia-nemopatch-writer[bot]";
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).resolves.toEqual({
      sources: { [sourcePath]: f.source },
      reviewer: "reviewer",
      reviewId: 50,
    });
    f.records.length = 0;
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /independent maintainer/,
    );
  });

  it("rejects a malformed bot author login before reading PR reviews", async () => {
    const f = fixture();
    f.pr.user.login = "nvidia-nemopatch-writer[bot]suffix";
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /open upstream PR/,
    );
    expect(f.request.mock.calls.some(([path]) => path.includes("/reviews"))).toBe(false);
  });

  it.each([{ prNumber: 0 }, { candidateSha: "main" }, { baseSha: "main" }])(
    "rejects invalid identity %j before any request",
    async (change) => {
      const f = fixture();
      await expect(
        readApprovedCandidateUpgrade({ ...identity, ...change }, [sourcePath], f.request),
      ).rejects.toThrow(/immutable/);
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(["write", "read", "triage", "none", "custom-role"])(
    "rejects the %s role before reading candidate data",
    async (role) => {
      const f = fixture();
      f.permission.role_name = role;
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        /independent maintainer/,
      );
      expect(f.request.mock.calls.some(([path]) => path.includes("/contents/"))).toBe(false);
    },
  );

  it.each(["author", "bot", "dismissed", "commented", "pending", "changes-requested", "deleted"])(
    "rejects %s review records",
    async (kind) => {
      const f = fixture();
      const mutate: Record<string, () => void> = {
        author: () => {
          f.approval.user.login = "AUTHOR";
        },
        bot: () => {
          f.approval.user.type = "Bot";
        },
        deleted: () => {
          f.records.length = 0;
        },
        dismissed: () => {
          f.approval.state = "DISMISSED";
        },
        commented: () => {
          f.approval.state = "COMMENTED";
        },
        pending: () => {
          f.approval.state = "PENDING";
        },
        "changes-requested": () => {
          f.approval.state = "CHANGES_REQUESTED";
        },
      };
      mutate[kind]!();
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        /independent maintainer/,
      );
    },
  );

  it.each(["closed", "fork", "base", "head"])(
    "rejects a PR with changed %s identity",
    async (kind) => {
      const f = fixture();
      const mutations: Record<string, () => void> = {
        closed: () => {
          f.pr.state = "closed";
        },
        fork: () => {
          f.pr.head.repo.full_name = "other/NemoClaw";
        },
        base: () => {
          f.pr.base.ref = "release";
        },
        head: () => {
          f.pr.head.sha = "c".repeat(40);
        },
      };
      mutations[kind]!();
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
        /open upstream PR/,
      );
    },
  );

  it("reads every page and honors a later revocation", async () => {
    const f = fixture();
    f.routes.set(
      "/repos/NVIDIA/NemoClaw/pulls/123/reviews?per_page=100&page=1",
      Array.from({ length: 100 }, (_, i) => ({ ...f.approval, id: i + 1 })),
    );
    f.routes.set("/repos/NVIDIA/NemoClaw/pulls/123/reviews?per_page=100&page=2", [
      { ...f.approval, id: 101, state: "CHANGES_REQUESTED" },
    ]);
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /independent maintainer/,
    );
  });

  it.each(["head", "revocation", "role", "deletion"])(
    "rejects %s changes during source acquisition",
    async (kind) => {
      const f = fixture();
      const mutations: Record<string, () => void> = {
        head: () => {
          f.pr.head.sha = "c".repeat(40);
        },
        revocation: () => {
          f.records.push({
            ...f.approval,
            id: 51,
            state: "CHANGES_REQUESTED",
          });
        },
        role: () => {
          f.permission.role_name = "read";
        },
        deletion: () => {
          f.records.length = 0;
        },
      };
      const request = async (path: string) => {
        const result = await f.request(path);
        path.includes("/contents/") && mutations[kind]!();
        return result;
      };
      await expect(readApprovedCandidateUpgrade(identity, [sourcePath], request)).rejects.toThrow();
    },
  );

  it.each([
    { type: "symlink" },
    { size: 2_000_000 },
    { size: 0 },
    { path: "other" },
    { target: "other" },
    { content: "AA==", size: 1 },
    { content: "/w==", size: 1 },
  ])("rejects unsafe candidate file %j", async (change) => {
    const f = fixture();
    Object.assign(f.blob, change);
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /Invalid candidate/,
    );
  });

  it("does not treat incomplete API access as approval", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("API denied"));
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      "API denied",
    );
  });

  it("reads the GitHub merge sources when both parents match the approved commits", async () => {
    const f = mergeFixture();
    await expect(
      readApprovedCandidateUpgrade(identity, [sourcePath], f.request, f.mergeSha),
    ).resolves.toMatchObject({ sources: { [sourcePath]: f.mergeSource } });
  });

  it.each(["unrelated", "wrong-base", "wrong-head", "extra-parent", "wrong-sha", "mutable-ref"])(
    "rejects the %s merge before reading its sources",
    async (kind) => {
      const f = mergeFixture();
      const mutations = {
        unrelated: () => {
          f.pr.merge_commit_sha = "d".repeat(40);
        },
        "wrong-base": () => {
          f.commit.parents[0]!.sha = "d".repeat(40);
        },
        "wrong-head": () => {
          f.commit.parents[1]!.sha = "d".repeat(40);
        },
        "extra-parent": () => {
          f.commit.parents.push({ sha: "d".repeat(40) });
        },
        "wrong-sha": () => {
          f.commit.sha = "d".repeat(40);
        },
        "mutable-ref": () => {
          f.mergeSha = "main";
        },
      };
      mutations[kind as keyof typeof mutations]();
      await expect(
        readApprovedCandidateUpgrade(identity, [sourcePath], f.request, f.mergeSha),
      ).rejects.toThrow(/merge/);
      expect(f.request.mock.calls.some(([path]) => path.includes("/contents/"))).toBe(false);
    },
  );

  it.each(["replaced", "revoked"])(
    "rejects %s authority during merge source acquisition",
    async (kind) => {
      const f = mergeFixture();
      const mutations = {
        replaced: () => {
          f.pr.merge_commit_sha = "d".repeat(40);
        },
        revoked: () => {
          f.records.length = 0;
        },
      };
      const request = async (path: string) => {
        const value = await f.request(path);
        path.includes("/contents/") && mutations[kind as keyof typeof mutations]();
        return value;
      };
      await expect(
        readApprovedCandidateUpgrade(identity, [sourcePath], request, f.mergeSha),
      ).rejects.toThrow(/merge|independent maintainer/);
    },
  );
});
