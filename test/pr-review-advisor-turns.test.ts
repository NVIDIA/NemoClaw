// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";
import { settleAdvisorTurn } from "../tools/advisors/session.mts";
import { advisorExecutionErrors } from "../tools/pr-review-advisor/analyze.mts";
import { artifactPaths } from "../tools/pr-review-advisor/artifacts.mts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("PR review advisor turn trace", () => {
  it("keeps the HTML session as the only debugging transcript", () => {
    expect(artifactPaths("artifacts/pr-review-advisor")).toEqual({
      result: path.join("artifacts/pr-review-advisor", "pr-review-advisor-result.json"),
      finalResult: path.join("artifacts/pr-review-advisor", "pr-review-advisor-final-result.json"),
      summary: path.join("artifacts/pr-review-advisor", "pr-review-advisor-summary.md"),
      sessionHtml: path.join("artifacts/pr-review-advisor", "pr-review-advisor-session.html"),
    });
  });

  it("settles turns and reports provider or callback errors (#6446)", async () => {
    const settle = (overrides: Partial<Parameters<typeof settleAdvisorTurn>[0]>) =>
      settleAdvisorTurn({
        index: 1,
        total: 1,
        name: "stage",
        run: async () => {},
        readText: () => "partial notes",
        readError: () => undefined,
        ...overrides,
      });

    const [timedOut, reasonless, syncArtifact, asyncArtifact, reasonlessArtifact] =
      await Promise.all([
        settle({ run: async () => Promise.reject(new Error("timed out after 100 ms")) }),
        settle({ run: () => Promise.reject(undefined) }),
        settle({
          onTurnComplete: () => {
            throw new Error("artifact disk full");
          },
        }),
        settle({
          onTurnComplete: async () => {
            throw new Error("async artifact disk full");
          },
        }),
        settle({ onTurnComplete: () => Promise.reject(undefined) }),
      ]);

    expect(timedOut.turn).toMatchObject({
      status: "timed_out",
      text: "partial notes",
      error: "timed out after 100 ms",
    });
    expect(reasonless.turn.error).toBe("unknown advisor turn failure");
    expect(reasonless.didThrow).toBe(true);
    expect(reasonless).toHaveProperty("thrown", undefined);
    let completedText: string | undefined;
    const completed = await settle({
      onTurnComplete: (turn) => {
        completedText = turn.text;
      },
    });
    expect(completed.didThrow).toBe(false);
    expect(completedText).toBe("partial notes");
    expect([
      syncArtifact.callbackError,
      asyncArtifact.callbackError,
      reasonlessArtifact.callbackError,
    ]).toEqual([
      "artifact disk full",
      "async artifact disk full",
      "unknown advisor turn callback failure",
    ]);
    expect(
      advisorExecutionErrors({
        text: "partial",
        raw: "raw transcript\n",
        turnTexts: ["partial"],
        turnErrors: ["stage: provider rejected"],
        turnCallbackErrors: ["stage: disk full"],
        fatalError: "timed out after 100 ms",
      }),
    ).toEqual([
      "session: timed out after 100 ms",
      "turn: stage: provider rejected",
      "artifact: stage: disk full",
    ]);
  });
});
