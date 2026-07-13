// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertStickyComment } from "../tools/advisors/github.mts";
import { runReadOnlyAdvisor } from "../tools/advisors/session.mts";
import { buildComment } from "../tools/pr-review-advisor/comment.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("PR review advisor security boundaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the model credential from the tool environment after in-memory setup", async () => {
    const credentialEnv = "PR_REVIEW_ADVISOR_TEST_API_KEY";
    vi.stubEnv(credentialEnv, "test-secret");
    const configDir = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-config-"));

    try {
      await expect(
        runReadOnlyAdvisor({
          cwd: ROOT,
          promptTurns: [],
          systemPrompt: "test",
          configDir,
          htmlExportPath: path.join(configDir, "session.html"),
          timeoutMs: 1000,
          heartbeatMs: 1000,
          maxCaptureBytes: 1024,
          modelId: "missing-model",
          credentialEnv,
          logPrefix: "test",
          logProgress: () => undefined,
        }),
      ).rejects.toThrow(/Could not configure advisor model/);
      expect(process.env[credentialEnv]).toBeUndefined();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("creates a bot-owned sticky comment when a user squats the marker", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          '[{"id":7,"body":"<!-- marker --> user text","user":{"login":"contributor"}}]',
      } as Response)
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
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("issues/1/comments");
    expect(String(fetchMock.mock.calls[1]?.[1]?.method)).toBe("POST");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("comments/7");
  });

  it("surfaces sticky comment publication permission failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, text: async () => "[]" } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Resource not accessible by integration",
      } as Response);

    await expect(
      upsertStickyComment({
        repo: "NVIDIA/NemoClaw",
        pr: "1",
        token: "token",
        marker: "<!-- marker -->",
        body: "<!-- marker --> pending",
        label: "test",
      }),
    ).rejects.toThrow(/403.*Resource not accessible/);
  });

  it("bounds rendered comments while preserving trusted metadata", () => {
    const comment = buildComment({
      summary: "unused",
      result: {
        summary: { recommendation: "merge_after_fixes" },
        findings: Array.from({ length: 20 }, (_, index) => ({
          severity: "blocker",
          category: "correctness",
          file: `src/oversized-${index}.ts`,
          line: index + 1,
          title: `Oversized finding ${index}`,
          description: "x".repeat(10_000),
          impact: "impact",
          recommendation: "fix it",
          verificationHint: "verify it",
          missingRegressionTest: "test it",
          evidence: "evidence",
        })),
      },
      metadata: {
        runId: "99",
        runAttempt: "2",
        commentId: "7",
        eventName: "pull_request_target",
        prNumber: "42",
        workflowSha: "f".repeat(40),
        baseSha: "d".repeat(40),
        workflowPath: ".github/workflows/pr-review-advisor.yaml",
      },
    });

    expect(Buffer.byteLength(comment, "utf8")).toBeLessThanOrEqual(60 * 1024);
    expect(comment).toContain("<!-- nemoclaw-pr-review-advisor -->");
    expect(comment).toContain("comment_id: 7");
    expect(comment).toContain("workflow_path: .github/workflows/pr-review-advisor.yaml -->");
    expect(comment).toContain("Comment truncated to fit GitHub's size limit");
  });
});
