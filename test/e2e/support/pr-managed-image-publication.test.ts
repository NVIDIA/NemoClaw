// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { githubRequest } from "../../../tools/e2e/base-image-publication.mts";
import { resolvePrManagedImageSource } from "../../../tools/e2e/pr-managed-image-publication.mts";

const BASE_SHA = "b".repeat(40);
const CANDIDATE_SHA = "a".repeat(40);
const BASE_TREE_SHA = "1".repeat(40);
const CANDIDATE_TREE_SHA = "2".repeat(40);
const PR_NUMBER = 10_263;
const CANONICAL_REPOSITORY = "NVIDIA/NemoClaw";
const WORKFLOW_SOURCE = `on:
  push:
    branches: [main]
    paths:
      - ".github/workflows/base-image.yaml"
      - "Dockerfile.base"
  workflow_dispatch:
jobs: {}
`;

function treeEntry(path: string, sha: string) {
  return { mode: "100644", path, sha, type: "blob" };
}

function requestFor(candidateRepository: string, imageChanged: boolean) {
  const baseEntries = [
    treeEntry("Dockerfile.base", "3".repeat(40)),
    treeEntry("docs/guide.mdx", "4".repeat(40)),
  ];
  const candidateEntries = [
    treeEntry("Dockerfile.base", (imageChanged ? "5" : "3").repeat(40)),
    treeEntry("docs/guide.mdx", "4".repeat(40)),
  ];
  const responses = new Map<string, unknown>([
    [
      `/repos/${CANONICAL_REPOSITORY}/pulls/${PR_NUMBER}`,
      {
        state: "open",
        base: { sha: BASE_SHA, repo: { full_name: CANONICAL_REPOSITORY } },
        head: { sha: CANDIDATE_SHA, repo: { full_name: candidateRepository } },
      },
    ],
    [
      `/repos/${CANONICAL_REPOSITORY}/git/commits/${BASE_SHA}`,
      { sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } },
    ],
    [
      `/repos/${CANONICAL_REPOSITORY}/git/trees/${BASE_TREE_SHA}?recursive=1`,
      { sha: BASE_TREE_SHA, tree: baseEntries, truncated: false },
    ],
    [
      `/repos/${candidateRepository}/git/commits/${CANDIDATE_SHA}`,
      { sha: CANDIDATE_SHA, tree: { sha: CANDIDATE_TREE_SHA } },
    ],
    [
      `/repos/${candidateRepository}/git/trees/${CANDIDATE_TREE_SHA}?recursive=1`,
      { sha: CANDIDATE_TREE_SHA, tree: candidateEntries, truncated: false },
    ],
  ]);
  return async (requestPath: string): Promise<unknown> =>
    responses.get(requestPath) ?? Promise.reject(new Error(`unexpected request ${requestPath}`));
}

function selectorInput(candidateRepository: string) {
  return {
    baseSha: BASE_SHA,
    candidateRepository,
    candidateSha: CANDIDATE_SHA,
    prNumber: PR_NUMBER,
    token: "test-token",
    workflowSource: WORKFLOW_SOURCE,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PR managed-image source selection", () => {
  it("keeps source selection bound to commit A during A-to-B-to-A PR drift", async () => {
    await expect(
      resolvePrManagedImageSource(
        selectorInput(CANONICAL_REPOSITORY),
        requestFor(CANONICAL_REPOSITORY, true),
      ),
    ).resolves.toBe("local-dockerfile");
  });

  it("reads a validated external candidate repository through the default request policy", async () => {
    const candidateRepository = "external-contributor/NemoClaw";
    const request = requestFor(candidateRepository, false);
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(input);
      return new Response(JSON.stringify(await request(`${url.pathname}${url.search}`)), {
        status: 200,
      });
    });

    await expect(resolvePrManagedImageSource(selectorInput(candidateRepository))).resolves.toBe(
      "managed-image",
    );
  });

  it("rejects a GitHub request outside the canonical and candidate repositories", async () => {
    await expect(
      githubRequest(`/repos/other-owner/other-repository/git/commits/${CANDIDATE_SHA}`, "token", {
        additionalRepository: "external-contributor/NemoClaw",
        attempts: 1,
        fetchImpl: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow("GitHub API path must stay within an allowed repository");
  });
});
