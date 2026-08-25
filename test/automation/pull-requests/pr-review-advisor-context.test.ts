// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubGraphql, upsertStickyComment } from "../../../tools/advisors/github.mts";
import { collectStaticTestInventory } from "../../../tools/pr-review-advisor/deterministic-context.mts";
import {
  declaresReplacement,
  extractIssueRefs,
  hasOpenPrReplacement,
  type OpenPrOverlap,
} from "../../../tools/pr-review-advisor/github-context.mts";
import { buildSystemPrompt } from "../../../tools/pr-review-advisor/trusted-guidance.mts";
import { ROOT } from "../../helpers/pr-review-advisor-test-fixtures.ts";

describe("PR review advisor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires an explicit replacement relation for superseded recommendations", () => {
    const overlap = (overrides: Partial<OpenPrOverlap>): OpenPrOverlap => ({
      number: 7654,
      title: "Concurrent change",
      labels: [],
      linkedIssues: [123],
      linkedIssueCount: 1,
      sameFiles: ["src/lib/example.ts"],
      sameFileCount: 1,
      duplicateLinkedIssues: [123],
      replacesCurrentPr: false,
      ...overrides,
    });

    expect(declaresReplacement("Refs #123 and shares files", 7542)).toBe(false);
    expect(declaresReplacement("Replaces PR #7542", 7542)).toBe(true);
    expect(hasOpenPrReplacement([overlap({})])).toBe(false);
    expect(hasOpenPrReplacement([overlap({ replacesCurrentPr: true })])).toBe(true);
  });

  it("surfaces GitHub GraphQL errors even when the HTTP status is successful", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { repository: null }, errors: [{ message: "rate limit" }] }),
    } as Response);

    await expect(githubGraphql("token", "query { viewer { login } }", {})).rejects.toThrow(
      "GitHub GraphQL returned errors: rate limit",
    );
  });

  it("does not fall back when the trusted security rubric is unavailable", () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("missing rubric fixture");
    });

    expect(() => buildSystemPrompt()).toThrow("Security rubric unavailable");
  });

  it("collects static test inventory from changed test files", () => {
    const inventory = collectStaticTestInventory(["test/automation/pull-requests/pr-review-advisor-context.test.ts"]);

    expect(inventory.changedTestFiles).toContain("test/automation/pull-requests/pr-review-advisor-context.test.ts");
    expect(inventory.nearbyTestNames.some((name) => name.includes("PR review advisor"))).toBe(true);
    expect(inventory.candidateExistingCoverage.join("\n")).toContain("named test block");
  });

  it("recognizes issue relations used by the PR template and common PR prose (#6446)", () => {
    expect(
      extractIssueRefs(
        "Follow-up to #6446\nFollow up #21\nfollowup to #22\nFollow-up to #6547\nRefs #6258\nReferences #6194",
        6547,
      ),
    ).toEqual([21, 22, 6194, 6258, 6446]);
  });

  it.each([
    ["conjunction", "Follow-up to #6547 and #6446.", [6446, 6547]],
    ["comma-separated list", "Refs #1, #2 and #3.", [1, 2, 3]],
    ["Oxford-comma list", "References #4, #5, and #6.", [4, 5, 6]],
  ] as const)("recognizes every issue in a %s relation (#6446)", (_case, text, expected) => {
    expect(extractIssueRefs(text, 6566)).toEqual(expected);
  });

  it("skips symlinked changed test files in static test inventory", () => {
    const tmp = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-symlink-"));
    const outside = fs.mkdtempSync(path.join(tmpdir(), "nemoclaw-pr-advisor-outside-"));
    const outsideFile = path.join(outside, "secret.test.ts");
    const linkPath = path.join(tmp, "linked.test.ts");
    fs.writeFileSync(outsideFile, 'describe("secret outside test", () => {});\n');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }

    try {
      const changedPath = path.relative(ROOT, linkPath);
      const inventory = collectStaticTestInventory([changedPath]);

      expect(inventory.nearbyTestNames.join("\n")).not.toContain("secret outside test");
      expect(inventory.candidateExistingCoverage.join("\n")).toContain(
        "not a regular in-repository file",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("upserts sticky comments with created comment-scoped bodies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, text: async () => "[]" } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => '{"id":123}' } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    await upsertStickyComment({
      repo: "NVIDIA/NemoClaw",
      pr: "1",
      token: "token",
      marker: "<!-- marker -->",
      body: "<!-- marker --> pending",
      label: "test",
      bodyForComment: (comment) => `<!-- marker --> comment_id=${comment.id}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("issues/comments/123");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      body: "<!-- marker --> comment_id=123",
    });
  });

  it("upserts sticky comments with existing comment-scoped bodies", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '[{"id":7,"body":"<!-- marker --> old","user":{"login":"github-actions[bot]"}}]',
      } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => "{}" } as Response);

    await upsertStickyComment({
      repo: "NVIDIA/NemoClaw",
      pr: "1",
      token: "token",
      marker: "<!-- marker -->",
      body: "<!-- marker --> pending",
      label: "test",
      bodyForComment: (comment) => `<!-- marker --> comment_id=${comment.id}`,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("issues/comments/7");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      body: "<!-- marker --> comment_id=7",
    });
  });
});
