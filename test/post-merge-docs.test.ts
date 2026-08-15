// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PATCH_FILE,
  RESULT_FILE,
  REVIEW_FILE,
  validateArtifact,
  validateCandidateArtifact,
} from "../tools/post-merge-docs/artifact.mts";
import { prepareCombinedBase } from "../tools/post-merge-docs/base.mts";
import {
  BOT_LOGIN,
  BOT_SIGN_OFF,
  MANAGED_END,
  MANAGED_START,
  PR_BODY_MAX_BYTES,
  ROLLING_BRANCH,
  ROLLING_TITLE,
  retirementPendingMarker,
  retiredEmptyMarker,
  validateManagedBlock,
} from "../tools/post-merge-docs/contract.mts";
import { latestReachableSemverTag } from "../tools/post-merge-docs/discover.mts";
import { discoverState } from "../tools/post-merge-docs/discover.mts";
import { finalizeAnalysis } from "../tools/post-merge-docs/finalize.mts";
import { analysisPrompt, createSandbox, reviewPrompt } from "../tools/post-merge-docs/model.mts";
import { publishArtifact } from "../tools/post-merge-docs/publish.mts";
import { validateWorkflowBoundary } from "../tools/post-merge-docs/workflow-boundary.mts";
import type { OpenShellTools } from "../tools/openshell-agent/runtime.mts";

const temporaryDirectories: string[] = [];
const sha = (letter: string): string => letter.repeat(40);

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function repository(): { directory: string; mainSha: string; mainTree: string } {
  const directory = temporaryDirectory("post-merge-docs-repo");
  git(directory, ["init", "-b", "main"]);
  fs.mkdirSync(path.join(directory, "docs"));
  fs.writeFileSync(path.join(directory, "AGENTS.md"), "agent\n");
  fs.writeFileSync(path.join(directory, "docs", "guide.mdx"), "old\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "docs: initialize"]);
  git(directory, ["tag", "-a", "v1.2.3", "-m", "v1.2.3"]);
  return {
    directory,
    mainSha: git(directory, ["rev-parse", "HEAD"]),
    mainTree: git(directory, ["rev-parse", "HEAD^{tree}"]),
  };
}

function result(input: {
  mainSha: string;
  rangeStartSha?: string;
  baseTreeSha: string;
  finalTreeSha?: string;
  outcome?: "changes" | "no_changes";
  authorPaths?: string[];
  documentationPaths?: string[];
  rollingHeadSha?: string | null;
  rollingPrNumber?: number | null;
}): Record<string, unknown> {
  return {
    version: 1,
    repository: "NVIDIA/NemoClaw",
    rangeStartTag: "v1.2.3",
    rangeStartSha: input.rangeStartSha ?? input.mainSha,
    mainSha: input.mainSha,
    rollingHeadSha: input.rollingHeadSha ?? null,
    rollingPrNumber: input.rollingPrNumber ?? null,
    baseTreeSha: input.baseTreeSha,
    finalTreeSha: input.finalTreeSha ?? input.baseTreeSha,
    outcome: input.outcome ?? "no_changes",
    summary: "The merged changes need no documentation update.",
    authorPaths: input.authorPaths ?? [],
    documentationPaths: input.documentationPaths ?? [],
    includesCodeSampleChanges: false,
  };
}

function writeApprovedArtifact(
  directory: string,
  value: Record<string, unknown>,
  patch?: string,
): void {
  const resultText = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, RESULT_FILE), resultText);
  if (patch !== undefined) fs.writeFileSync(path.join(directory, PATCH_FILE), patch);
  const review = {
    version: 1,
    repository: value.repository,
    rangeStartTag: value.rangeStartTag,
    rangeStartSha: value.rangeStartSha,
    mainSha: value.mainSha,
    rollingHeadSha: value.rollingHeadSha,
    rollingPrNumber: value.rollingPrNumber,
    baseTreeSha: value.baseTreeSha,
    resultSha256: createHash("sha256").update(resultText).digest("hex"),
    patchSha256: patch === undefined ? null : createHash("sha256").update(patch).digest("hex"),
    outcome: "approved",
    summary: "Independent review approved the complete result.",
  };
  fs.writeFileSync(path.join(directory, REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`);
}

function createChangedArtifact(repo: ReturnType<typeof repository>): {
  artifact: string;
  finalTree: string;
  patch: string;
} {
  const work = temporaryDirectory("post-merge-docs-change");
  git(work, ["clone", "--no-hardlinks", repo.directory, "."]);
  fs.writeFileSync(path.join(work, "docs", "new-page.mdx"), "new page\n");
  git(work, ["add", "docs/new-page.mdx"]);
  const finalTree = git(work, ["write-tree"]);
  const patch = execFileSync(
    "git",
    ["diff", "--binary", "--full-index", repo.mainTree, finalTree],
    { cwd: work, encoding: "utf8" },
  );
  const artifact = temporaryDirectory("post-merge-docs-artifact");
  writeApprovedArtifact(
    artifact,
    result({
      mainSha: repo.mainSha,
      baseTreeSha: repo.mainTree,
      finalTreeSha: finalTree,
      outcome: "changes",
      authorPaths: ["docs/new-page.mdx"],
      documentationPaths: ["docs/new-page.mdx"],
    }),
    patch,
  );
  return { artifact, finalTree, patch };
}

function gitBlobSha(content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${content.length}\0`))
    .update(content)
    .digest("hex");
}

function pullRequest(input: {
  number: number;
  headSha: string;
  body: string;
  draft?: boolean;
}): Record<string, unknown> {
  return {
    body: input.body,
    draft: input.draft ?? true,
    html_url: `https://github.com/NVIDIA/NemoClaw/pull/${input.number}`,
    number: input.number,
    state: "open",
    user: { login: BOT_LOGIN },
    base: { ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
    head: {
      ref: ROLLING_BRANCH,
      repo: { full_name: "NVIDIA/NemoClaw" },
      sha: input.headSha,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("post-merge documentation artifacts", () => {
  it("accepts an independently approved no-change result bound to the exact main tree", () => {
    const repo = repository();
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(artifact, result({ mainSha: repo.mainSha, baseTreeSha: repo.mainTree }));

    const validated = validateArtifact({
      artifactDirectory: artifact,
      expectedRepository: "NVIDIA/NemoClaw",
      expectedRangeStartTag: "v1.2.3",
      expectedRangeStartSha: repo.mainSha,
      expectedMainSha: repo.mainSha,
      expectedRollingHeadSha: null,
      expectedRollingPrNumber: null,
    });

    expect(validated.result.finalTreeSha).toBe(repo.mainTree);
    expect(validated.review?.outcome).toBe("approved");
  });

  it("rejects a candidate that contains a forged review receipt", () => {
    const repo = repository();
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(artifact, result({ mainSha: repo.mainSha, baseTreeSha: repo.mainTree }));
    expect(() =>
      validateCandidateArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/must not contain a review receipt/u);
  });

  it("rejects symlink artifacts and documentation path traversal", () => {
    const repo = repository();
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    const outside = path.join(temporaryDirectory("post-merge-docs-outside"), "result.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, path.join(artifact, RESULT_FILE));
    expect(() =>
      validateCandidateArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/non-symlink/u);

    fs.rmSync(path.join(artifact, RESULT_FILE));
    fs.writeFileSync(
      path.join(artifact, RESULT_FILE),
      `${JSON.stringify({
        ...result({
          mainSha: repo.mainSha,
          baseTreeSha: repo.mainTree,
          outcome: "changes",
          authorPaths: ["docs/../AGENTS.md"],
        }),
      })}\n`,
    );
    expect(() =>
      validateCandidateArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/outside docs/u);
  });

  it("rejects missing and mismatched independent review evidence", () => {
    const repo = repository();
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(artifact, result({ mainSha: repo.mainSha, baseTreeSha: repo.mainTree }));
    fs.rmSync(path.join(artifact, REVIEW_FILE));
    expect(() =>
      validateArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/review receipt is required/u);

    writeApprovedArtifact(artifact, result({ mainSha: repo.mainSha, baseTreeSha: repo.mainTree }));
    const reviewPath = path.join(artifact, REVIEW_FILE);
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
    review.resultSha256 = "0".repeat(64);
    fs.writeFileSync(reviewPath, `${JSON.stringify(review)}\n`);
    expect(() =>
      validateArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/does not match/u);
  });

  it("binds a changes result to its patch digest and final tree", () => {
    const repo = repository();
    const changed = createChangedArtifact(repo);
    expect(
      validateArtifact({
        artifactDirectory: changed.artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }).result.finalTreeSha,
    ).toBe(changed.finalTree);
    fs.appendFileSync(path.join(changed.artifact, PATCH_FILE), "\n");
    expect(() =>
      validateArtifact({
        artifactDirectory: changed.artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
      }),
    ).toThrow(/does not match/u);
  });
});

describe("post-merge documentation state", () => {
  it("selects the highest reachable annotated exact semver tag", () => {
    const repo = repository();
    git(repo.directory, ["tag", "-a", "v1.10.0", "-m", "v1.10.0"]);
    expect(latestReachableSemverTag(repo.directory, repo.mainSha)).toEqual({
      tag: "v1.10.0",
      sha: repo.mainSha,
    });
  });

  it("preserves rolling documentation content in the combined base tree", () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", "automation/post-merge-docs"]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "human release text\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: add release text"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    git(repo.directory, ["checkout", "main"]);
    const prepared = prepareCombinedBase({
      sourceRepository: repo.directory,
      destination: temporaryDirectory("post-merge-docs-combined"),
      mainSha: repo.mainSha,
      rollingHeadSha: rollingSha,
    });
    const content = execFileSync("git", ["show", `${prepared.baseTreeSha}:docs/guide.mdx`], {
      cwd: prepared.repository,
      encoding: "utf8",
    });
    expect(content).toBe("human release text\n");
  });

  it("accepts only a reconstructable retired-empty marker inside the managed block", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "caught up\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: catch up guide"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    git(repo.directory, ["checkout", "main"]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "caught up\n");
    fs.writeFileSync(path.join(repo.directory, "source.ts"), "export const current = true;\n");
    git(repo.directory, ["add", "docs/guide.mdx", "source.ts"]);
    git(repo.directory, ["commit", "-m", "feat: advance main"]);
    const currentMain = git(repo.directory, ["rev-parse", "HEAD"]);
    expect(git(repo.directory, ["rev-parse", `${rollingSha}^{tree}`])).not.toBe(
      git(repo.directory, ["rev-parse", `${currentMain}^{tree}`]),
    );
    const marker = retiredEmptyMarker(currentMain, rollingSha);
    const body = `${MANAGED_START}\n${marker}\n${MANAGED_END}`;
    const retired = {
      ...pullRequest({ number: 9, headSha: rollingSha, body }),
      state: "closed",
      merged_at: null,
      merge_commit_sha: null,
    };
    const request = vi.fn(async (_method: string, apiPath: string) => {
      if (apiPath.endsWith("/git/ref/heads/main")) return { object: { sha: currentMain } };
      if (apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) {
        return { object: { sha: rollingSha } };
      }
      if (apiPath.includes("/pulls?")) return [retired];
      throw new Error(`unexpected request: ${apiPath}`);
    });
    await expect(
      discoverState({
        repository: "NVIDIA/NemoClaw",
        mainSha: currentMain,
        sourceRepository: repo.directory,
        request,
      }),
    ).resolves.toMatchObject({ rollingHeadSha: rollingSha, rollingPrNumber: null });

    const forged = { ...retired, body: `${marker}\n${MANAGED_START}\ntext\n${MANAGED_END}` };
    request.mockImplementation(async (_method: string, apiPath: string) => {
      if (apiPath.endsWith("/git/ref/heads/main")) return { object: { sha: currentMain } };
      if (apiPath.endsWith("/git/ref/heads/automation/post-merge-docs"))
        return { object: { sha: rollingSha } };
      if (apiPath.includes("/pulls?")) return [forged];
      throw new Error(`unexpected request: ${apiPath}`);
    });
    await expect(
      discoverState({
        repository: "NVIDIA/NemoClaw",
        mainSha: currentMain,
        sourceRepository: repo.directory,
        request,
      }),
    ).rejects.toThrow(/closed without merge/u);
  });

  it("recovers a verified managed orphan after a retired branch advances", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    git(repo.directory, ["commit", "--allow-empty", "-m", "docs: retire empty"]);
    const retiredHead = git(repo.directory, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "managed orphan\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`]);
    const orphanHead = git(repo.directory, ["rev-parse", "HEAD"]);
    const orphanTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    git(repo.directory, ["checkout", "main"]);
    const retiredBody = `${MANAGED_START}\n${retiredEmptyMarker(repo.mainSha, retiredHead)}\n${MANAGED_END}`;
    const retired = {
      ...pullRequest({ number: 9, headSha: retiredHead, body: retiredBody }),
      state: "closed",
      merged_at: null,
      merge_commit_sha: null,
    };
    const request = vi.fn(async (_method: string, apiPath: string) => {
      if (apiPath.endsWith("/git/ref/heads/main")) return { object: { sha: repo.mainSha } };
      if (apiPath.endsWith("/git/ref/heads/automation/post-merge-docs"))
        return { object: { sha: orphanHead } };
      if (apiPath.includes("/pulls?")) return [retired];
      if (apiPath.endsWith(`/commits/${orphanHead}`)) {
        return {
          author: { login: BOT_LOGIN },
          committer: { login: "web-flow" },
          commit: {
            author: {
              name: BOT_LOGIN,
              email: "41898282+github-actions[bot]@users.noreply.github.com",
            },
            committer: { name: "GitHub", email: "noreply@github.com" },
            message: `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
            verification: { verified: true },
            tree: { sha: orphanTree },
          },
          parents: [{ sha: retiredHead }],
        };
      }
      throw new Error(`unexpected request: ${apiPath}`);
    });
    await expect(
      discoverState({
        repository: "NVIDIA/NemoClaw",
        mainSha: repo.mainSha,
        sourceRepository: repo.directory,
        request,
      }),
    ).resolves.toMatchObject({ rollingHeadSha: orphanHead, rollingPrNumber: null });
  });

  it("rejects a rolling branch that conflicts with exact main", () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", "automation/post-merge-docs"]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "rolling\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: rolling"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    git(repo.directory, ["checkout", "main"]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "main\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: main"]);
    const mainSha = git(repo.directory, ["rev-parse", "HEAD"]);
    expect(() =>
      prepareCombinedBase({
        sourceRepository: repo.directory,
        destination: temporaryDirectory("post-merge-docs-conflict"),
        mainSha,
        rollingHeadSha: rollingSha,
      }),
    ).toThrow(/conflicts with exact main/u);
  });

  it("includes a newly authored untracked documentation page in the trusted artifact", () => {
    const repo = repository();
    const modelRepo = temporaryDirectory("post-merge-docs-model-repo");
    git(modelRepo, ["clone", "--no-hardlinks", repo.directory, "."]);
    fs.writeFileSync(path.join(modelRepo, "docs", "new-page.mdx"), "new page\n");
    git(modelRepo, ["add", "-N", "-A"]);
    const raw = temporaryDirectory("post-merge-docs-raw");
    fs.writeFileSync(
      path.join(raw, PATCH_FILE),
      execFileSync(
        "git",
        ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", repo.mainTree],
        { cwd: modelRepo },
      ),
    );
    fs.writeFileSync(
      path.join(raw, "model-result.json"),
      `${JSON.stringify({ outcome: "changes", summary: "Add the new page.", includesCodeSampleChanges: false })}\n`,
    );
    const output = temporaryDirectory("post-merge-docs-output");
    finalizeAnalysis({
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_SHA: repo.mainSha,
      RANGE_START_TAG: "v1.2.3",
      RANGE_START_SHA: repo.mainSha,
      ROLLING_HEAD_SHA: "",
      ROLLING_PR_NUMBER: "",
      POST_MERGE_DOCS_BASE_TREE_SHA: repo.mainTree,
      POST_MERGE_DOCS_OUTPUT_DIR: output,
      POST_MERGE_DOCS_RAW_EXPORT_DIR: raw,
      TRUSTED_CHECKOUT: repo.directory,
    });
    const candidate = validateCandidateArtifact({
      artifactDirectory: output,
      expectedRepository: "NVIDIA/NemoClaw",
      expectedRangeStartTag: "v1.2.3",
      expectedRangeStartSha: repo.mainSha,
      expectedMainSha: repo.mainSha,
    });
    expect(candidate.result.authorPaths).toEqual(["docs/new-page.mdx"]);
    expect(candidate.result.documentationPaths).toEqual(["docs/new-page.mdx"]);
  });

  it("publishes no-change readiness only after reconstructing the exact main tree", async () => {
    const repo = repository();
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(artifact, result({ mainSha: repo.mainSha, baseTreeSha: repo.mainTree }));
    const request = vi.fn(async (_method: string, apiPath: string) => {
      if (apiPath.endsWith("/git/ref/heads/main")) return { object: { sha: repo.mainSha } };
      if (apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) return null;
      if (apiPath.includes("/pulls?")) return [];
      if (apiPath === "/repos/NVIDIA/NemoClaw") return { node_id: "repository-id" };
      throw new Error(`unexpected request: ${apiPath}`);
    });
    await expect(
      publishArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
        sourceRepository: repo.directory,
        request,
        graphql: vi.fn(),
      }),
    ).resolves.toEqual({ status: "no_changes", coveredSha: repo.mainSha });
  });

  it("creates one draft PR from an approved documentation patch", async () => {
    const repo = repository();
    const changed = createChangedArtifact(repo);
    const commitSha = sha("c");
    const request = vi.fn(async (method: string, apiPath: string, body?: unknown) => {
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/main")) {
        return { object: { sha: repo.mainSha } };
      }
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) {
        return null;
      }
      if (method === "GET" && apiPath.includes("/pulls?")) return [];
      if (method === "GET" && apiPath === "/repos/NVIDIA/NemoClaw") {
        return { node_id: "repository-id" };
      }
      if (method === "POST" && apiPath.endsWith("/git/blobs")) {
        const value = body as { content: string };
        return { sha: gitBlobSha(Buffer.from(value.content, "base64")) };
      }
      if (method === "POST" && apiPath.endsWith("/git/trees")) {
        expect((body as { base_tree: string }).base_tree).toBe(repo.mainTree);
        return { sha: changed.finalTree };
      }
      if (method === "POST" && apiPath.endsWith("/git/commits")) {
        return { sha: commitSha, verification: { verified: true } };
      }
      if (method === "POST" && apiPath.endsWith("/git/refs")) {
        return { ref: `refs/heads/${ROLLING_BRANCH}`, object: { sha: commitSha } };
      }
      if (method === "POST" && apiPath.endsWith("/pulls")) {
        const value = body as { body: string; draft: boolean };
        expect(value.draft).toBe(true);
        expect(value.body).toContain(`docs-review-head-sha: ${commitSha.slice(0, 12)}`);
        return pullRequest({ number: 42, headSha: commitSha, body: value.body });
      }
      throw new Error(`unexpected request: ${method} ${apiPath}`);
    });

    await expect(
      publishArtifact({
        artifactDirectory: changed.artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
        sourceRepository: repo.directory,
        request,
        graphql: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "pr_pending",
      coveredSha: repo.mainSha,
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/NVIDIA/NemoClaw/pull/42",
    });
  });

  it("preserves human PR text while reconciling an idempotent rolling receipt", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "human release text\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: add release text"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    const rollingTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    git(repo.directory, ["checkout", "main"]);
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(
      artifact,
      result({
        mainSha: repo.mainSha,
        baseTreeSha: rollingTree,
        finalTreeSha: rollingTree,
        documentationPaths: ["docs/guide.mdx"],
        rollingHeadSha: rollingSha,
        rollingPrNumber: 7,
      }),
    );
    const oldBlock = `${MANAGED_START}\nold receipt\n${MANAGED_END}`;
    const oldBody = `Human release notes\n\n${oldBlock}\n\nHuman checklist`;
    const initialPull = pullRequest({ number: 7, headSha: rollingSha, body: oldBody });
    let patchedBody = "";
    const request = vi.fn(async (method: string, apiPath: string, body?: unknown) => {
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/main"))
        return { object: { sha: repo.mainSha } };
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) {
        return { object: { sha: rollingSha } };
      }
      if (method === "GET" && apiPath.includes("/pulls?")) return [initialPull];
      if (method === "GET" && apiPath === "/repos/NVIDIA/NemoClaw")
        return { node_id: "repository-id" };
      if (method === "GET" && apiPath.endsWith("/pulls/7")) return initialPull;
      if (method === "PATCH" && apiPath.endsWith("/pulls/7")) {
        patchedBody = (body as { body: string }).body;
        return pullRequest({ number: 7, headSha: rollingSha, body: patchedBody });
      }
      throw new Error(`unexpected request: ${method} ${apiPath}`);
    });
    await expect(
      publishArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
        sourceRepository: repo.directory,
        request,
        graphql: vi.fn(),
      }),
    ).resolves.toMatchObject({ status: "pr_pending", pullRequestNumber: 7 });
    expect(patchedBody).toContain("Human release notes");
    expect(patchedBody).toContain("Human checklist");
    expect(patchedBody).toContain(`docs-review-head-sha: ${rollingSha.slice(0, 12)}`);
  });

  it("advances the same rolling PR across a newer divergent main", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "rolling docs\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: add rolling text"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    git(repo.directory, ["checkout", "main"]);
    fs.writeFileSync(path.join(repo.directory, "source.ts"), "export const next = true;\n");
    git(repo.directory, ["add", "source.ts"]);
    git(repo.directory, ["commit", "-m", "feat: advance main"]);
    const currentMain = git(repo.directory, ["rev-parse", "HEAD"]);
    const currentMainTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    const combined = prepareCombinedBase({
      sourceRepository: repo.directory,
      destination: temporaryDirectory("post-merge-docs-cycle"),
      mainSha: currentMain,
      rollingHeadSha: rollingSha,
    });
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(
      artifact,
      result({
        mainSha: currentMain,
        rangeStartSha: repo.mainSha,
        baseTreeSha: combined.baseTreeSha,
        finalTreeSha: combined.baseTreeSha,
        documentationPaths: ["docs/guide.mdx"],
        rollingHeadSha: rollingSha,
        rollingPrNumber: 27,
      }),
    );
    const commitSha = sha("e");
    let currentHead = rollingSha;
    let currentBody = `Human release plan\n\n${MANAGED_START}\nold\n${MANAGED_END}\n\nHuman checklist`;
    let commitInput: Record<string, unknown> | undefined;
    const currentPull = (): Record<string, unknown> =>
      pullRequest({ number: 27, headSha: currentHead, body: currentBody, draft: false });
    const graphql = vi.fn(async (_query: string, variables: Record<string, unknown>) => {
      const update = variables.input as {
        clientMutationId: string;
        refUpdates: Array<{ afterOid: string; beforeOid: string; force: boolean }>;
      };
      expect(update.refUpdates).toEqual([
        {
          afterOid: commitSha,
          beforeOid: rollingSha,
          force: false,
          name: `refs/heads/${ROLLING_BRANCH}`,
        },
      ]);
      currentHead = commitSha;
      return { updateRefs: { clientMutationId: update.clientMutationId } };
    });
    const request = vi.fn(async (method: string, apiPath: string, body?: unknown) => {
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/main")) {
        return { object: { sha: currentMain } };
      }
      if (method === "GET" && apiPath.endsWith(`/git/ref/heads/${ROLLING_BRANCH}`)) {
        return { object: { sha: currentHead } };
      }
      if (method === "GET" && apiPath.includes("/pulls?")) return [currentPull()];
      if (method === "GET" && apiPath === "/repos/NVIDIA/NemoClaw") {
        return { node_id: "repository-id" };
      }
      if (method === "GET" && apiPath.endsWith("/pulls/27")) return currentPull();
      if (method === "PATCH" && apiPath.endsWith("/pulls/27")) {
        currentBody = (body as { body: string }).body;
        return currentPull();
      }
      if (method === "POST" && apiPath.endsWith("/git/blobs")) {
        const value = body as { content: string };
        return { sha: gitBlobSha(Buffer.from(value.content, "base64")) };
      }
      if (method === "POST" && apiPath.endsWith("/git/trees")) {
        expect((body as { base_tree: string }).base_tree).toBe(currentMainTree);
        return { sha: combined.baseTreeSha };
      }
      if (method === "POST" && apiPath.endsWith("/git/commits")) {
        commitInput = body as Record<string, unknown>;
        return { sha: commitSha, verification: { verified: true } };
      }
      throw new Error(`unexpected request: ${method} ${apiPath}`);
    });

    await expect(
      publishArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: currentMain,
        sourceRepository: repo.directory,
        request,
        graphql,
      }),
    ).resolves.toMatchObject({ status: "pr_pending", pullRequestNumber: 27 });
    expect(commitInput).toMatchObject({
      parents: [rollingSha, currentMain],
      tree: combined.baseTreeSha,
    });
    expect(currentBody).toContain("Human release plan");
    expect(currentBody).toContain("Human checklist");
    expect(currentBody).toContain(`docs-review-head-sha: ${commitSha.slice(0, 12)}`);
    expect(currentHead).toBe(commitSha);
  }, 30_000);

  it("recovers a closed pending retirement after main advances", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "stale rolling docs\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", "docs: add stale rolling text"]);
    const rollingSha = git(repo.directory, ["rev-parse", "HEAD"]);
    const rollingTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    git(repo.directory, ["checkout", "main"]);
    const removalPatch = execFileSync(
      "git",
      ["diff", "--binary", "--full-index", rollingTree, repo.mainTree],
      { cwd: repo.directory, encoding: "utf8" },
    );
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(
      artifact,
      result({
        mainSha: repo.mainSha,
        baseTreeSha: rollingTree,
        finalTreeSha: repo.mainTree,
        outcome: "changes",
        authorPaths: ["docs/guide.mdx"],
        documentationPaths: [],
        rollingHeadSha: rollingSha,
        rollingPrNumber: 11,
      }),
      removalPatch,
    );
    const cleanSha = git(repo.directory, [
      "commit-tree",
      repo.mainTree,
      "-p",
      rollingSha,
      "-p",
      repo.mainSha,
      "-m",
      `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
    ]);
    let currentMainSha = repo.mainSha;
    let currentMainTree = repo.mainTree;
    let advancedCleanSha: string | null = null;
    let currentHead = rollingSha;
    let pullHead = rollingSha;
    let state = "open";
    let body = `${MANAGED_START}\nold\n${MANAGED_END}`;
    const currentPull = (): Record<string, unknown> => ({
      ...pullRequest({ number: 11, headSha: pullHead, body }),
      state,
      merged_at: null,
      merge_commit_sha: null,
    });
    const writes: Array<Record<string, unknown>> = [];
    let rejectBranchUpdate = true;
    let rejectFinalBodyUpdate = true;
    let ambiguousPendingRetirement = false;
    const graphql = vi.fn(async (_query: string, variables: Record<string, unknown>) => {
      const update = variables.input as {
        clientMutationId: string;
        refUpdates: Array<{ afterOid: string; beforeOid: string; force: boolean }>;
      };
      const expectedAfter = currentMainSha === repo.mainSha ? cleanSha : advancedCleanSha;
      const expectedBefore = currentMainSha === repo.mainSha ? rollingSha : cleanSha;
      expect(update.refUpdates).toEqual([
        {
          afterOid: expectedAfter,
          beforeOid: expectedBefore,
          force: false,
          name: `refs/heads/${ROLLING_BRANCH}`,
        },
      ]);
      if (expectedAfter === cleanSha && rejectBranchUpdate) {
        throw new Error("simulated branch update failure");
      }
      currentHead = expectedAfter as string;
      if (state === "open") pullHead = currentHead;
      return { updateRefs: { clientMutationId: update.clientMutationId } };
    });
    const request = vi.fn(async (method: string, apiPath: string, value?: unknown) => {
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/main"))
        return { object: { sha: currentMainSha } };
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) {
        return { object: { sha: currentHead } };
      }
      if (method === "GET" && apiPath.includes("/pulls?state=open")) {
        return state === "open" ? [currentPull()] : [];
      }
      if (method === "GET" && apiPath.includes("/pulls?")) {
        const pulls = [currentPull()];
        if (ambiguousPendingRetirement) {
          pulls.push({
            ...pullRequest({ number: 12, headSha: pullHead, body }),
            state: "closed",
            merged_at: null,
            merge_commit_sha: null,
          });
        }
        return pulls;
      }
      if (method === "GET" && apiPath.endsWith(`/git/commits/${cleanSha}`)) {
        return { sha: cleanSha, tree: { sha: repo.mainTree } };
      }
      if (
        advancedCleanSha &&
        method === "GET" &&
        apiPath.endsWith(`/git/commits/${advancedCleanSha}`)
      ) {
        return { sha: advancedCleanSha, tree: { sha: currentMainTree } };
      }
      if (method === "GET" && apiPath === "/repos/NVIDIA/NemoClaw")
        return { node_id: "repository-id" };
      if (method === "GET" && apiPath.endsWith("/pulls/11")) return currentPull();
      if (method === "POST" && apiPath.endsWith("/git/commits")) {
        const expectedSha = currentMainSha === repo.mainSha ? cleanSha : advancedCleanSha;
        expect(value).toMatchObject({
          message: `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
          parents:
            currentMainSha === repo.mainSha
              ? [rollingSha, repo.mainSha]
              : [cleanSha, currentMainSha],
          tree: currentMainTree,
        });
        return { sha: expectedSha, verification: { verified: true } };
      }
      if (method === "PATCH" && apiPath.endsWith("/pulls/11")) {
        const update = value as { body?: string; state?: string };
        writes.push(update);
        if (update.body?.includes("Result: `no-docs-needed`") && rejectFinalBodyUpdate) {
          throw new Error("simulated final body update failure");
        }
        if (update.body) body = update.body;
        if (update.state) state = update.state;
        return currentPull();
      }
      throw new Error(`unexpected request: ${method} ${apiPath}`);
    });
    const publish = (artifactDirectory = artifact) =>
      publishArtifact({
        artifactDirectory,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: currentMainSha,
        sourceRepository: repo.directory,
        request,
        graphql,
      });
    await expect(publish()).rejects.toThrow("simulated branch update failure");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain("Result: `blocked`");
    expect(writes[0].body).toContain("The reviewed candidate contains no documentation diff");
    expect(writes[0].body).not.toContain("This rolling documentation PR is closed");
    expect(writes[0].body).not.toContain("Result: `no-docs-needed`");
    expect(state).toBe("open");
    expect(currentHead).toBe(rollingSha);

    rejectBranchUpdate = false;
    await expect(publish()).rejects.toThrow("simulated final body update failure");
    expect(writes).toHaveLength(5);
    expect(writes[1].body).toContain(retirementPendingMarker(repo.mainSha, cleanSha));
    expect(writes[1].body).toContain("Result: `blocked`");
    expect(writes[2]).toEqual({ state: "closed" });
    expect(writes[3].body).toContain("Result: `no-docs-needed`");
    expect(writes[4].body).toContain("Result: `no-docs-needed`");
    expect(body).toContain("Result: `blocked`");
    expect(state).toBe("closed");
    expect(currentHead).toBe(cleanSha);

    fs.writeFileSync(path.join(repo.directory, "source.ts"), "export const next = true;\n");
    git(repo.directory, ["add", "source.ts"]);
    git(repo.directory, ["commit", "-m", "feat: advance main before retirement retry"]);
    currentMainSha = git(repo.directory, ["rev-parse", "HEAD"]);
    currentMainTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    advancedCleanSha = git(repo.directory, [
      "commit-tree",
      currentMainTree,
      "-p",
      cleanSha,
      "-p",
      currentMainSha,
      "-m",
      `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
    ]);
    const advancedBase = prepareCombinedBase({
      sourceRepository: repo.directory,
      destination: temporaryDirectory("post-merge-docs-advanced-recovery"),
      mainSha: currentMainSha,
      rollingHeadSha: cleanSha,
    });
    expect(advancedBase.baseTreeSha).toBe(currentMainTree);
    const recoveryArtifact = temporaryDirectory("post-merge-docs-recovery");
    writeApprovedArtifact(
      recoveryArtifact,
      result({
        mainSha: currentMainSha,
        rangeStartSha: repo.mainSha,
        baseTreeSha: currentMainTree,
        finalTreeSha: currentMainTree,
        rollingHeadSha: cleanSha,
        rollingPrNumber: 11,
      }),
    );
    rejectFinalBodyUpdate = false;
    ambiguousPendingRetirement = true;
    await expect(publish(recoveryArtifact)).rejects.toThrow(/ambiguous pending retirement/u);
    expect(writes).toHaveLength(5);
    ambiguousPendingRetirement = false;
    await expect(publish(recoveryArtifact)).resolves.toEqual({
      status: "no_changes",
      coveredSha: currentMainSha,
    });
    expect(writes).toHaveLength(6);
    expect(writes[5].body).toContain(retiredEmptyMarker(repo.mainSha, cleanSha));
    expect(writes[5].body).toContain(
      "This rolling documentation PR is closed because its reviewed tree matches `main`",
    );
    expect(writes[5].body).toContain("Result: `no-docs-needed`");
    expect(writes[5].body).toContain(
      "Docs not applicable — justification: The reviewed tree matches `main`.",
    );
    expect(writes[5].body).not.toContain("This draft updates documentation");
    expect(writes[5].body).not.toContain("Result: `docs-updated`");
    expect(state).toBe("closed");
    expect(pullHead).toBe(cleanSha);
    expect(currentHead).toBe(advancedCleanSha);
    expect(graphql).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("recreates a PR for an approved no-change managed orphan with documentation content", async () => {
    const repo = repository();
    git(repo.directory, ["checkout", "-b", ROLLING_BRANCH]);
    fs.writeFileSync(path.join(repo.directory, "docs", "guide.mdx"), "orphan docs\n");
    git(repo.directory, ["add", "docs/guide.mdx"]);
    git(repo.directory, ["commit", "-m", `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`]);
    const orphanHead = git(repo.directory, ["rev-parse", "HEAD"]);
    const orphanTree = git(repo.directory, ["rev-parse", "HEAD^{tree}"]);
    git(repo.directory, ["checkout", "main"]);
    const artifact = temporaryDirectory("post-merge-docs-artifact");
    writeApprovedArtifact(
      artifact,
      result({
        mainSha: repo.mainSha,
        baseTreeSha: orphanTree,
        finalTreeSha: orphanTree,
        documentationPaths: ["docs/guide.mdx"],
        rollingHeadSha: orphanHead,
        rollingPrNumber: null,
      }),
    );
    const commitSha = sha("d");
    const graphql = vi.fn(async (_query: string, variables: Record<string, unknown>) => {
      const update = variables.input as {
        clientMutationId: string;
        refUpdates: Array<{ force: boolean }>;
      };
      expect(update.refUpdates[0].force).toBe(false);
      return { updateRefs: { clientMutationId: update.clientMutationId } };
    });
    const request = vi.fn(async (method: string, apiPath: string, body?: unknown) => {
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/main"))
        return { object: { sha: repo.mainSha } };
      if (method === "GET" && apiPath.endsWith("/git/ref/heads/automation/post-merge-docs")) {
        return { object: { sha: orphanHead } };
      }
      if (method === "GET" && apiPath.includes("/pulls?")) return [];
      if (method === "GET" && apiPath.endsWith(`/commits/${orphanHead}`)) {
        return {
          author: { login: BOT_LOGIN },
          committer: { login: "web-flow" },
          commit: {
            author: {
              name: BOT_LOGIN,
              email: "41898282+github-actions[bot]@users.noreply.github.com",
            },
            committer: { name: "GitHub", email: "noreply@github.com" },
            message: `${ROLLING_TITLE}\n\n${BOT_SIGN_OFF}`,
            verification: { verified: true },
            tree: { sha: orphanTree },
          },
          parents: [{ sha: repo.mainSha }],
        };
      }
      if (method === "GET" && apiPath === "/repos/NVIDIA/NemoClaw")
        return { node_id: "repository-id" };
      if (method === "POST" && apiPath.endsWith("/git/blobs")) {
        const value = body as { content: string };
        return { sha: gitBlobSha(Buffer.from(value.content, "base64")) };
      }
      if (method === "POST" && apiPath.endsWith("/git/trees")) return { sha: orphanTree };
      if (method === "POST" && apiPath.endsWith("/git/commits")) {
        return { sha: commitSha, verification: { verified: true } };
      }
      if (method === "POST" && apiPath.endsWith("/pulls")) {
        const value = body as { body: string };
        return pullRequest({ number: 19, headSha: commitSha, body: value.body });
      }
      throw new Error(`unexpected request: ${method} ${apiPath}`);
    });
    await expect(
      publishArtifact({
        artifactDirectory: artifact,
        expectedRepository: "NVIDIA/NemoClaw",
        expectedRangeStartTag: "v1.2.3",
        expectedRangeStartSha: repo.mainSha,
        expectedMainSha: repo.mainSha,
        sourceRepository: repo.directory,
        request,
        graphql,
      }),
    ).resolves.toMatchObject({ status: "pr_pending", pullRequestNumber: 19 });
    expect(graphql).toHaveBeenCalledOnce();
  });
});

describe("post-merge documentation workflow contract", () => {
  it("uploads each prepared directory into its expected sandbox path", () => {
    const tools: OpenShellTools = {
      run: vi.fn(() => ""),
      start: vi.fn(),
      wait: vi.fn(async () => undefined),
    };
    const common = {
      HOME: "/home/test",
      PATH: "/usr/bin",
      PI_IMAGE: "pi-image",
      POST_MERGE_DOCS_CONFIG_DIR: "/config",
      POST_MERGE_DOCS_WORKDIR: "/work",
      SANDBOX_NAME: "docs-main-author",
      TRUSTED_CHECKOUT: "/trusted",
    };

    createSandbox({ ...common, POST_MERGE_DOCS_PHASE: "analyze" }, tools);
    expect(vi.mocked(tools.run).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "--upload",
        "/work/repo:/sandbox",
        "--upload",
        "/config:/sandbox",
        "/usr/bin/git",
        "-C",
        "/sandbox/repo",
      ]),
    );

    vi.mocked(tools.run).mockClear();
    createSandbox(
      { ...common, POST_MERGE_DOCS_PHASE: "review", SANDBOX_NAME: "docs-main-review" },
      tools,
    );
    expect(vi.mocked(tools.run).mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "--upload",
        "/work/repo:/sandbox",
        "--upload",
        "/config:/sandbox",
        "--upload",
        "/work/input:/sandbox",
      ]),
    );
  });

  it("bounds every managed PR body by UTF-8 bytes below GitHub's limit", () => {
    const fixed = `${MANAGED_START}\n\n${MANAGED_END}`;
    const withinLimit = `${MANAGED_START}\n${"a".repeat(PR_BODY_MAX_BYTES - Buffer.byteLength(fixed))}\n${MANAGED_END}`;
    expect(Buffer.byteLength(withinLimit)).toBe(PR_BODY_MAX_BYTES);
    expect(() => validateManagedBlock(withinLimit)).not.toThrow();
    expect(() => validateManagedBlock(`${withinLimit}é`)).toThrow(
      `rolling documentation PR body exceeds ${PR_BODY_MAX_BYTES} bytes`,
    );
  });

  it("keeps model phases isolated and terminal readiness exact", () => {
    expect(validateWorkflowBoundary()).toEqual([]);
    expect(analysisPrompt("NVIDIA/NemoClaw", sha("a"), sha("b"))).toContain(
      ".agents/skills/nemoclaw-contributor-update-docs/SKILL.md",
    );
    const prompt = reviewPrompt("NVIDIA/NemoClaw", sha("a"), sha("b"));
    expect(prompt).not.toContain("build passed");
    expect(prompt).toContain("validation runs independently");
  });

  it("rejects workflow permission and publisher execution mutations", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "post-merge-docs.yaml"),
      "utf8",
    );
    const permissionMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "permission.yaml",
    );
    fs.writeFileSync(
      permissionMutation,
      source.replace(
        "    permissions:\n      contents: read\n    outputs:\n      candidate_artifact_id:",
        "    permissions:\n      contents: write\n    outputs:\n      candidate_artifact_id:",
      ),
    );
    expect(validateWorkflowBoundary(permissionMutation)).toContain(
      "analyze permissions must match the least-privilege contract",
    );

    const executionMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "execution.yaml",
    );
    fs.writeFileSync(
      executionMutation,
      source.replace(
        '"$TRUSTED_CHECKOUT/tools/post-merge-docs/publish.mts"',
        '"$TRUSTED_CHECKOUT/tools/post-merge-docs/publish.mts"\n          npm run docs',
      ),
    );
    expect(validateWorkflowBoundary(executionMutation)).toContain(
      "publisher must not run model, docs, package, or OpenShell commands",
    );

    const artifactMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "artifact.yaml",
    );
    fs.writeFileSync(
      artifactMutation,
      source.replace(
        "artifact-ids: ${{ needs.analyze.outputs.candidate_artifact_id }}",
        "name: post-merge-docs-candidate",
      ),
    );
    expect(validateWorkflowBoundary(artifactMutation)).toContain(
      "validate artifact download must use one immutable ID from the same workflow run",
    );

    const secretMutation = path.join(temporaryDirectory("post-merge-docs-workflow"), "secret.yaml");
    fs.writeFileSync(
      secretMutation,
      source.replace(
        "      SANDBOX_NAME: docs-main-author",
        "      EXTRA_SECRET: ${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}\n      SANDBOX_NAME: docs-main-author",
      ),
    );
    expect(validateWorkflowBoundary(secretMutation)).toContain(
      "workflow must have exactly two configure-only model secret uses",
    );

    const topLevelMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "top-level.yaml",
    );
    fs.writeFileSync(
      topLevelMutation,
      source.replace("permissions: {}", "env:\n  BASH_ENV: /tmp/override\n\npermissions: {}"),
    );
    expect(validateWorkflowBoundary(topLevelMutation)).toContain(
      "workflow contains a key outside the trusted top-level contract",
    );

    const actionMutation = path.join(temporaryDirectory("post-merge-docs-workflow"), "action.yaml");
    fs.writeFileSync(
      actionMutation,
      source.replace(
        "    steps:\n      - name: Checkout the trusted publisher",
        "    steps:\n      - name: Added publisher action\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - name: Checkout the trusted publisher",
      ),
    );
    expect(validateWorkflowBoundary(actionMutation)).toContain(
      "publish steps must match the trusted step allowlist",
    );

    const checkoutMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "checkout.yaml",
    );
    fs.writeFileSync(
      checkoutMutation,
      source.replace(
        "          submodules: false",
        "          submodules: false\n          sparse-checkout: docs",
      ),
    );
    expect(validateWorkflowBoundary(checkoutMutation)).toContain(
      "discover checkout must bind exact main without persisted credentials",
    );

    const skippedValidationMutation = path.join(
      temporaryDirectory("post-merge-docs-workflow"),
      "skipped-validation.yaml",
    );
    fs.writeFileSync(
      skippedValidationMutation,
      source.replace(
        "      - name: Build the complete candidate documentation\n        working-directory:",
        "      - name: Build the complete candidate documentation\n        if: false\n        working-directory:",
      ),
    );
    expect(validateWorkflowBoundary(skippedValidationMutation)).toContain(
      "validate step metadata must match the trusted contract: Build the complete candidate documentation",
    );

    const imageMutation = path.join(temporaryDirectory("post-merge-docs-workflow"), "image.yaml");
    fs.writeFileSync(imageMutation, source.replace(/PI_IMAGE: .*$/mu, "PI_IMAGE: pi:latest"));
    expect(validateWorkflowBoundary(imageMutation)).toContain(
      "analyze runtime, environment, and outputs must match the trusted contract",
    );
  });

  it("rejects any model policy expansion", () => {
    const policyDirectory = temporaryDirectory("post-merge-docs-policies");
    for (const phase of ["analyze", "review"]) {
      fs.copyFileSync(
        path.join(process.cwd(), "tools", "post-merge-docs", `${phase}-policy.yaml`),
        path.join(policyDirectory, `${phase}-policy.yaml`),
      );
    }
    fs.appendFileSync(path.join(policyDirectory, "review-policy.yaml"), "unexpected: true\n");

    expect(validateWorkflowBoundary(undefined, policyDirectory)).toContain(
      "review policy must match the exact isolated phase contract",
    );
  });
});
