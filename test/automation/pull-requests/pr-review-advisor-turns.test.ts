// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { settleAdvisorTurn } from "../../../tools/advisors/session.mts";


describe("PR review advisor turn trace", () => {

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
  });
});
