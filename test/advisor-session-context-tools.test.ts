// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type AdvisorPromptTurn,
  advisorTurnFlowErrors,
  createAdvisorContextToolRuntime,
  missingRequiredAdvisorToolNames,
  promptWithRequiredContextTools,
  resolveAdvisorTurnTools,
} from "../tools/advisors/session.mts";

function contextTurn(name: string, content: string): AdvisorPromptTurn {
  return {
    name,
    prompt: `Turn ${name}`,
    contextToolResults: [
      { toolName: "pr_review_context", content, contentType: "json", label: `${name} context` },
    ],
  };
}

describe("advisor session context tool flow", () => {
  it("keeps turn context inert until its real scoped tool is invoked (#6446)", async () => {
    const first = contextTurn("first", '{"turn":1}');
    const second = contextTurn("second", '{"turn":2}');
    const runtime = createAdvisorContextToolRuntime([first, second]);
    const tool = runtime.customTools[0];

    expect(runtime.allToolNames).toEqual(["pr_review_context"]);
    expect(tool?.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    await expect(
      tool?.execute("inactive", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow("not active");

    runtime.activateTurn(first);
    await expect(
      tool?.execute("first", {}, undefined, undefined, undefined as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: '{"turn":1}' }] });
    runtime.activateTurn(second);
    await expect(
      tool?.execute("second", {}, undefined, undefined, undefined as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: '{"turn":2}' }] });
  });

  it("requires successful context and declared custom tool calls (#6446)", () => {
    const turn: AdvisorPromptTurn = {
      ...contextTurn("review", "{}"),
      activeToolNames: ["pr_review_update_ledger"],
      requiredToolNames: ["pr_review_update_ledger"],
      requireTextBeforeToolNames: ["pr_review_update_ledger"],
    };
    const tools = resolveAdvisorTurnTools(
      turn,
      ["pr_review_context"],
      new Set(["pr_review_context", "pr_review_update_ledger"]),
    );

    expect(tools.activeToolNames).toEqual(["pr_review_context", "pr_review_update_ledger"]);
    expect(tools.requiredToolNames).toEqual(["pr_review_context", "pr_review_update_ledger"]);
    expect(promptWithRequiredContextTools("Review", ["pr_review_context"])).toContain(
      "results are not preloaded; call each before answering",
    );
    expect(
      advisorTurnFlowErrors(
        "review",
        [
          { type: "tool_start", toolName: "pr_review_context" },
          { type: "tool_end", toolName: "pr_review_context", isError: false },
          { type: "text", text: "Finding F-001 is actionable." },
          { type: "tool_start", toolName: "pr_review_update_ledger" },
          { type: "tool_end", toolName: "pr_review_update_ledger", isError: false },
        ],
        tools,
      ),
    ).toEqual([]);
    expect(
      advisorTurnFlowErrors(
        "review",
        [
          { type: "text", text: "premature" },
          { type: "tool_start", toolName: "pr_review_update_ledger" },
        ],
        tools,
      ).join("; "),
    ).toContain("text before pr_review_context completed");
    expect(
      advisorTurnFlowErrors(
        "review",
        [
          { type: "tool_end", toolName: "pr_review_context", isError: false },
          { type: "text", text: "analysis" },
          { type: "tool_start", toolName: "pr_review_update_ledger" },
          { type: "tool_start", toolName: "read" },
        ],
        tools,
      ).join("; "),
    ).toContain("called read after pr_review_update_ledger");
    expect(
      missingRequiredAdvisorToolNames(tools.requiredToolNames, new Set(["pr_review_context"])),
    ).toEqual(["pr_review_update_ledger"]);
    expect(
      missingRequiredAdvisorToolNames(
        tools.requiredToolNames,
        new Set(["pr_review_context", "pr_review_update_ledger"]),
      ),
    ).toEqual([]);
  });
});
