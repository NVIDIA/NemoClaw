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
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    body: `NemoClaw-Upgrade-E2E: approve ${identity.candidateSha} ${identity.baseSha}`,
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
    ["/repos/NVIDIA/NemoClaw/issues/123/comments?per_page=100&page=1", records],
    ["/repos/NVIDIA/NemoClaw/collaborators/reviewer/permission", permission],
    [`/repos/NVIDIA/NemoClaw/contents/${sourcePath}?ref=${identity.candidateSha}`, blob],
  ]);
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

describe("candidate upgrade admission", () => {
  it("reads reviewed commit data and rechecks both PR identity and current maintainer authority", async () => {
    const f = fixture();
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).resolves.toEqual({
      sources: { [sourcePath]: f.source },
      reviewer: "reviewer",
      commentId: 50,
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
      commentId: 50,
    });
    f.records.length = 0;
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /independent maintainer/,
    );
  });

  it("rejects a malformed bot author login before reading approval comments", async () => {
    const f = fixture();
    f.pr.user.login = "nvidia-nemopatch-writer[bot]suffix";
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /open upstream PR/,
    );
    expect(f.request.mock.calls.some(([path]) => path.includes("/comments"))).toBe(false);
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

  it.each([
    "author",
    "bot",
    "edited",
    "quoted",
    "newline",
    "old-commit",
    "old-base",
    "revoke",
    "deleted",
  ])("rejects %s approval records", async (kind) => {
    const f = fixture();
    const mutations: Record<string, () => void> = {
      author: () => {
        f.approval.user.login = "AUTHOR";
      },
      bot: () => {
        f.approval.user.type = "Bot";
      },
      edited: () => {
        f.approval.updated_at = "2026-10-14T00:01:00Z";
      },
      quoted: () => {
        f.approval.body = `> ${f.approval.body}`;
      },
      newline: () => {
        f.approval.body += "\n";
      },
      "old-commit": () => {
        f.approval.body = f.approval.body.replace(identity.candidateSha, "c".repeat(40));
      },
      "old-base": () => {
        f.approval.body = f.approval.body.replace(identity.baseSha, "c".repeat(40));
      },
      revoke: () => {
        f.approval.body = f.approval.body.replace("approve", "revoke");
      },
      deleted: () => {
        f.records.length = 0;
      },
    };
    mutations[kind]!();
    await expect(readApprovedCandidateUpgrade(identity, [sourcePath], f.request)).rejects.toThrow(
      /independent maintainer/,
    );
  });

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
      "/repos/NVIDIA/NemoClaw/issues/123/comments?per_page=100&page=1",
      Array.from({ length: 100 }, (_, i) => ({ ...f.approval, id: i + 1 })),
    );
    f.routes.set("/repos/NVIDIA/NemoClaw/issues/123/comments?per_page=100&page=2", [
      { ...f.approval, id: 101, body: f.approval.body.replace("approve", "revoke") },
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
            body: f.approval.body.replace("approve", "revoke"),
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
