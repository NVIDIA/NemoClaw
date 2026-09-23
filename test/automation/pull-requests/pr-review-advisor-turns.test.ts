// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { settleAdvisorTurn } from "../../../tools/advisors/session.mts";
import { advisorTurnFlowDiagnostics } from "../../../tools/advisors/turn-protocol.mts";

describe("PR review advisor turn trace", () => {
  it("reports bounded tool-flow metadata without tool arguments (#11686)", () => {
    const repeatedUnknownStarts = new Array<{ type: "tool_start"; toolName: string }>(10_000).fill({
      type: "tool_start",
      toolName: "untrusted\nvalue",
    });
    const diagnostics = advisorTurnFlowDiagnostics(
      [
        { type: "tool_start", toolName: "read" },
        { type: "tool_end", toolName: "read", isError: true },
        { type: "tool_end", toolName: "submit", isError: false },
        ...repeatedUnknownStarts,
        {
          type: "read",
          path: "/secret/path",
          offset: 0,
          endOffset: 1,
          fileSize: 1,
          reachesEnd: true,
        },
      ],
      ["context", "submit"],
      new Set(["context", "read", "submit"]),
    );

    expect(diagnostics).toEqual({
      textEvents: 0,
      readEvents: 1,
      toolStarts: 10_001,
      toolEnds: 2,
      toolFailures: 1,
      failedToolNames: ["read"],
      unmatchedToolEndNames: ["submit"],
      unsettledToolNames: ["<unknown>"],
      missingRequiredToolNames: ["context"],
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    expect(JSON.stringify(diagnostics)).not.toContain("untrusted");
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
  });
});
