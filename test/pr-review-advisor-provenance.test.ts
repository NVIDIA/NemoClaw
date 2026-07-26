// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectTrustedPreviousAdvisorReview } from "../tools/pr-review-advisor/analyze.mts";

const WORKFLOW_SHA = "feedface".repeat(5);
const BASE_SHA = "deadbeef".repeat(5);
const UPDATED_BASE_SHA = "cafebabe".repeat(5);
const HEAD_SHA = "abc1234";

function mockRun(overrides: Record<string, unknown> = {}): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      name: "PR Review / Advisor",
      path: ".github/workflows/pr-review-advisor.yaml@refs/heads/main",
      head_sha: WORKFLOW_SHA,
      event: "pull_request_target",
      run_attempt: 2,
      run_started_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:10:00Z",
      pull_requests: [{ number: 42, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } }],
      ...overrides,
    }),
  } as Response);
}

function comment(options: {
  id?: number;
  updatedAt?: string;
  runAttempt?: number;
  baseSha?: string;
  suffix?: string;
}) {
  const id = options.id ?? 7;
  return {
    id,
    updated_at: options.updatedAt ?? "2026-01-01T00:05:00Z",
    user: { login: "github-actions[bot]" },
    body: `<!-- nemoclaw-pr-review-advisor -->\n<!-- head_sha: ${HEAD_SHA}; recommendation: merge_after_fixes; run_id: 99; run_attempt: ${options.runAttempt ?? 2}; comment_id: ${id}; event: pull_request_target; pr_number: 42; workflow_sha: ${WORKFLOW_SHA}; base_sha: ${options.baseSha ?? BASE_SHA}; workflow_path: .github/workflows/pr-review-advisor.yaml -->\n${options.suffix ?? "target review"}`,
  };
}

describe("PR review advisor target-event provenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts metadata only when the run binds the workflow, PR, head, and base", async () => {
    mockRun();

    const previous = await collectTrustedPreviousAdvisorReview(
      "NVIDIA/NemoClaw",
      "token",
      [comment({ suffix: "trusted target review" })],
      { prNumber: 42, currentBaseSha: BASE_SHA },
    );

    expect(previous).toMatchObject({
      headSha: HEAD_SHA,
      body: expect.stringContaining("trusted target review"),
    });
  });

  it("rejects a prior target review after the live PR base changes", async () => {
    mockRun();

    const previous = await collectTrustedPreviousAdvisorReview(
      "NVIDIA/NemoClaw",
      "token",
      [comment({ suffix: "stale target review" })],
      { prNumber: 42, currentBaseSha: UPDATED_BASE_SHA },
    );

    expect(previous).toBeNull();
  });

  it("rejects target-event provenance without the live PR base", async () => {
    mockRun();

    const previous = await collectTrustedPreviousAdvisorReview(
      "NVIDIA/NemoClaw",
      "token",
      [comment({ suffix: "unbound target review" })],
      { prNumber: 42 },
    );

    expect(previous).toBeNull();
  });

  it("rejects metadata when the run association binds a different base", async () => {
    mockRun({
      pull_requests: [{ number: 42, head: { sha: HEAD_SHA }, base: { sha: UPDATED_BASE_SHA } }],
    });

    const previous = await collectTrustedPreviousAdvisorReview(
      "NVIDIA/NemoClaw",
      "token",
      [comment({ suffix: "wrong base" })],
      { prNumber: 42, currentBaseSha: BASE_SHA },
    );

    expect(previous).toBeNull();
  });

  it("rejects metadata without one matching run association", async () => {
    const association = { number: 42, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } };
    mockRun({ pull_requests: [association, association] });

    const previous = await collectTrustedPreviousAdvisorReview(
      "NVIDIA/NemoClaw",
      "token",
      [comment({ suffix: "ambiguous target review" })],
      { prNumber: 42, currentBaseSha: BASE_SHA },
    );

    expect(previous).toBeNull();
  });

  it("keeps the legacy run-attempt and timestamp checks during migration", async () => {
    mockRun({
      path: ".github/workflows/pr-review-advisor.yaml",
      head_sha: HEAD_SHA,
      event: "pull_request",
      run_attempt: 1,
      pull_requests: undefined,
    });
    const legacy = (id: number, updatedAt: string, runAttempt = 1) => ({
      id,
      updated_at: updatedAt,
      user: { login: "github-actions[bot]" },
      body: `<!-- nemoclaw-pr-review-advisor -->\n<!-- head_sha: ${HEAD_SHA}; recommendation: merge_after_fixes; run_id: 99; run_attempt: ${runAttempt}; comment_id: ${id} -->\nlegacy ${id}`,
    });

    const previous = await collectTrustedPreviousAdvisorReview("NVIDIA/NemoClaw", "token", [
      legacy(1, "2026-01-01T00:05:00Z"),
      legacy(2, "2026-01-01T00:20:00Z"),
      legacy(3, "2026-01-01T00:05:00Z", 2),
    ]);

    expect(previous).toMatchObject({ body: expect.stringContaining("legacy 1") });
  });
});
