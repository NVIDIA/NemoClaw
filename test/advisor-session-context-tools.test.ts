// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type AdvisorPromptTurn,
  type AdvisorTurnFlowEvent,
  advisorTurnFlowErrors,
  createAdvisorContextToolRuntime,
  missingRequiredAdvisorToolNames,
  promptWithRequiredContextTools,
  resolveAdvisorTurnTools,
} from "../tools/advisors/session.mts";
import {
  assistantTextRepairErrors,
  hasCompletedTerminalSubmitRepair,
  repairableAssistantText,
  repairableTerminalSubmitToolName,
  terminalSubmitRepairErrors,
} from "../tools/advisors/turn-protocol.mts";

function contextTurn(name: string, content: string): AdvisorPromptTurn {
  return {
    name,
    prompt: `Turn ${name}`,
    contextToolResults: [
      { toolName: "pr_review_context", content, contentType: "json", label: `${name} context` },
    ],
  };
}

const ledgerToolName = "pr_review_update_ledger";
const atomicMutationTools = {
  activeToolNames: [ledgerToolName],
  requiredToolNames: [ledgerToolName],
  requireToolsBeforeText: [],
  requireAssistantText: false,
  atomicTerminalToolName: ledgerToolName,
};

function terminalSubmitRepairContract(repairToolNames = ["repair_draft"]) {
  const turn: AdvisorPromptTurn = {
    name: "prepare",
    prompt: "prepare",
    terminalSubmitToolName: ledgerToolName,
    terminalSubmitRepairPrompt: "repair",
  };
  return {
    turn,
    tools: {
      ...atomicMutationTools,
      atomicTerminalToolName: undefined,
      terminalSubmitToolName: ledgerToolName,
      terminalSubmitRepairToolNames: repairToolNames,
    },
  };
}
const analysisEvent: AdvisorTurnFlowEvent = { type: "text", text: "analysis" };
const ledgerStart: AdvisorTurnFlowEvent = { type: "tool_start", toolName: ledgerToolName };
const ledgerSuccess: AdvisorTurnFlowEvent = {
  type: "tool_end",
  toolName: ledgerToolName,
  isError: false,
};
const ledgerFailure: AdvisorTurnFlowEvent = { ...ledgerSuccess, isError: true };
const invalidFinalMutationFlows: Array<[string, AdvisorTurnFlowEvent[], string]> = [
  ["an omitted call", [], "observed 0 successful and 0 failed"],
  ["an omitted completion", [ledgerStart], "observed 1 starts and 0 completions"],
  [
    "duplicate successful completions",
    [ledgerStart, ledgerSuccess, ledgerStart, ledgerSuccess],
    "observed 2 successful and 0 failed",
  ],
  ["a failed completion", [ledgerStart, ledgerFailure], "0 successful and 1 failed"],
  [
    "prose before a successful commit",
    [analysisEvent, ledgerStart, ledgerSuccess],
    "emitted prose during atomic",
  ],
  [
    "a read before a successful commit",
    [
      { type: "tool_start", toolName: "read" },
      { type: "tool_end", toolName: "read", isError: false },
      ledgerStart,
      ledgerSuccess,
    ],
    "called unexpected tool read during atomic commit",
  ],
  [
    "activity after a successful commit",
    [ledgerStart, ledgerSuccess, analysisEvent],
    "emitted activity after successful",
  ],
];

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
      missingRequiredAdvisorToolNames(tools.requiredToolNames, new Set(["pr_review_context"])),
    ).toEqual(["pr_review_update_ledger"]);
    expect(
      missingRequiredAdvisorToolNames(
        tools.requiredToolNames,
        new Set(["pr_review_context", "pr_review_update_ledger"]),
      ),
    ).toEqual([]);
  });

  it("rejects an atomic commit configuration with context or extra tools (#6446)", () => {
    const turn: AdvisorPromptTurn = {
      ...contextTurn("invalid-atomic", "{}"),
      activeToolNames: [ledgerToolName],
      atomicTerminalToolName: ledgerToolName,
    };

    expect(() =>
      resolveAdvisorTurnTools(
        turn,
        ["pr_review_context"],
        new Set(["pr_review_context", ledgerToolName]),
      ),
    ).toThrow("atomic terminal tool must be the turn's only active and required tool");
  });

  it.each(invalidFinalMutationFlows)(
    "rejects %s for an atomic mutation tool (#6446)",
    (_case, events, expectedError) => {
      expect(advisorTurnFlowErrors("review", events, atomicMutationTools).join("; ")).toContain(
        expectedError,
      );
    },
  );

  it("accepts failed atomic attempts before one successful commit (#6446)", () => {
    const errors = advisorTurnFlowErrors(
      "review",
      [ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess],
      atomicMutationTools,
    );

    expect(errors).toEqual([]);
  });

  it("allows reads, prose, and draft tools before one terminal submit", () => {
    const turn: AdvisorPromptTurn = {
      ...contextTurn("prepare", "{}"),
      activeToolNames: ["batch_draft", "submit_review"],
      terminalSubmitToolName: "submit_review",
      terminalSubmitRepairToolNames: ["repair_draft"],
    };
    const tools = resolveAdvisorTurnTools(
      turn,
      ["pr_review_context"],
      new Set(["pr_review_context", "batch_draft", "repair_draft", "submit_review"]),
    );
    const events: AdvisorTurnFlowEvent[] = [
      { type: "tool_start", toolName: "pr_review_context" },
      { type: "tool_end", toolName: "pr_review_context", isError: false },
      { type: "tool_start", toolName: "read" },
      { type: "tool_end", toolName: "read", isError: false },
      { type: "text", text: "prepared findings" },
      { type: "tool_start", toolName: "batch_draft" },
      { type: "tool_end", toolName: "batch_draft", isError: false },
      { type: "tool_start", toolName: "submit_review" },
      { type: "tool_end", toolName: "submit_review", isError: false },
    ];

    expect(tools.requiredToolNames).toContain("submit_review");
    expect(tools.terminalSubmitRepairToolNames).toEqual(["repair_draft"]);
    expect(advisorTurnFlowErrors("prepare", events, tools)).toEqual([]);
  });

  it.each([
    [
      "an unexpected tool with a failed submit",
      [
        { type: "tool_start", toolName: "unexpected" },
        { type: "tool_end", toolName: "unexpected", isError: false },
        ledgerStart,
        ledgerFailure,
      ],
      undefined,
      new Set<string>(),
    ],
    ["provider error", [ledgerStart, ledgerFailure], "provider failed", new Set<string>()],
    ["unsettled call", [ledgerStart], undefined, new Set<string>()],
    ["malformed call", [ledgerFailure, ledgerStart], undefined, new Set<string>()],
    ["prior success", [ledgerStart, ledgerSuccess], undefined, new Set([ledgerToolName])],
  ] as const)(
    "does not repair terminal submit after %s",
    (_case, events, turnError, successful) => {
      const { turn, tools } = terminalSubmitRepairContract([]);
      expect(
        repairableTerminalSubmitToolName(turn, [...events], tools, successful, turnError),
      ).toBe(undefined);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 20])(
    "repairs a submit after %i settled failed attempt(s) (#9963)",
    (failureCount) => {
      const { turn, tools } = terminalSubmitRepairContract();
      const events = Array.from({ length: failureCount }, () => [
        ledgerStart,
        ledgerFailure,
      ]).flat();
      expect(repairableTerminalSubmitToolName(turn, events, tools, new Set(), undefined)).toBe(
        ledgerToolName,
      );
    },
  );

  it("accepts one settled same-turn terminal submit repair (#9630)", () => {
    const { turn, tools } = terminalSubmitRepairContract();
    const events = [ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess];

    expect(hasCompletedTerminalSubmitRepair(turn, events, tools, undefined)).toBe(true);
    expect(advisorTurnFlowErrors("prepare", events, tools, true)).toEqual([]);
  });

  it.each([
    {
      case: "many failures after success",
      events: [
        ledgerStart,
        ledgerSuccess,
        ...Array.from({ length: 20 }, () => [ledgerStart, ledgerFailure]).flat(),
      ],
    },
    {
      case: "five failures before success",
      events: [
        ...Array.from({ length: 5 }, () => [ledgerStart, ledgerFailure]).flat(),
        ledgerStart,
        ledgerSuccess,
      ],
    },
  ])("accepts $case around one success (#9963)", ({ events }) => {
    const { turn, tools } = terminalSubmitRepairContract();
    expect(hasCompletedTerminalSubmitRepair(turn, events, tools, undefined)).toBe(true);
    expect(advisorTurnFlowErrors("prepare", events, tools, true)).toEqual([]);
  });

  it("ignores a read observation after a successful terminal submit (#9963)", () => {
    const { turn, tools } = terminalSubmitRepairContract();
    const events: AdvisorTurnFlowEvent[] = [
      ledgerStart,
      ledgerFailure,
      ledgerStart,
      ledgerSuccess,
      {
        type: "read",
        path: "/workspace/review.jsonl",
        offset: 1,
        endOffset: 1,
        fileSize: 2,
        reachesEnd: true,
      },
    ];

    expect(hasCompletedTerminalSubmitRepair(turn, events, tools, undefined)).toBe(true);
    expect(advisorTurnFlowErrors("prepare", events, tools, true)).toEqual([]);
  });

  it("requires configured repair and no provider error for same-turn repair (#9630)", () => {
    const { turn, tools } = terminalSubmitRepairContract();
    const events = [ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess];
    const withoutConfiguredRepair = hasCompletedTerminalSubmitRepair(
      { ...turn, terminalSubmitRepairPrompt: undefined },
      events,
      tools,
      undefined,
    );
    const withProviderFailure = hasCompletedTerminalSubmitRepair(
      turn,
      events,
      tools,
      "provider failed",
    );

    expect(withoutConfiguredRepair).toBe(false);
    expect(advisorTurnFlowErrors("prepare", events, tools, withoutConfiguredRepair)).not.toEqual(
      [],
    );
    expect(withProviderFailure).toBe(false);
    expect(advisorTurnFlowErrors("prepare", events, tools, withProviderFailure)).not.toEqual([]);
  });

  it.each([
    ["all attempts fail", [ledgerStart, ledgerFailure, ledgerStart, ledgerFailure]],
    ["the second attempt is unsettled", [ledgerStart, ledgerFailure, ledgerStart]],
    ["attempt events overlap", [ledgerStart, ledgerStart, ledgerFailure, ledgerSuccess]],
    [
      "activity follows success",
      [ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess, analysisEvent],
    ],
  ])("does not accept same-turn terminal submit repair when %s (#9630)", (_case, events) => {
    const { turn, tools } = terminalSubmitRepairContract();

    const repaired = hasCompletedTerminalSubmitRepair(turn, events, tools, undefined);
    expect(repaired).toBe(false);
    expect(advisorTurnFlowErrors("prepare", events, tools, repaired)).not.toEqual([]);
  });

  it("repairs required assistant text only after every required tool succeeds (#9963)", () => {
    const turn: AdvisorPromptTurn = {
      ...contextTurn("investigate", "{}"),
      requireAssistantText: true,
      assistantTextRepairPrompt: "Return the investigation receipt.",
    };
    const tools = resolveAdvisorTurnTools(
      turn,
      ["pr_review_context"],
      new Set(["pr_review_context"]),
    );
    const completedContext: AdvisorTurnFlowEvent[] = [
      { type: "tool_start", toolName: "pr_review_context" },
      { type: "tool_end", toolName: "pr_review_context", isError: false },
    ];

    expect(
      repairableAssistantText(
        turn,
        completedContext,
        tools,
        new Set(["pr_review_context"]),
        undefined,
      ),
    ).toBe(true);
    expect(repairableAssistantText(turn, completedContext, tools, new Set(), undefined)).toBe(
      false,
    );
    expect(assistantTextRepairErrors("investigate", [{ type: "text", text: "receipt" }])).toEqual(
      [],
    );
    expect(assistantTextRepairErrors("investigate", [])).toContain(
      "investigate assistant-text repair omitted required analysis",
    );
    expect(
      assistantTextRepairErrors("investigate", [
        { type: "tool_start", toolName: "pr_review_context" },
      ]),
    ).toContain("investigate assistant-text repair called unexpected tool pr_review_context");
    const readObservation: AdvisorTurnFlowEvent = {
      type: "read",
      path: "/workspace/required.txt",
      offset: 1,
      endOffset: null,
      fileSize: 9,
      reachesEnd: true,
    };
    expect(assistantTextRepairErrors("investigate", [readObservation])).toContain(
      "investigate assistant-text repair called unexpected tool read",
    );
    expect(
      repairableAssistantText(
        turn,
        [
          ...completedContext,
          { type: "tool_start", toolName: "read" },
          readObservation,
          { type: "tool_end", toolName: "read", isError: false },
        ],
        tools,
        new Set(["pr_review_context"]),
        undefined,
      ),
    ).toBe(true);
    expect(
      repairableAssistantText(
        turn,
        [...completedContext, { type: "tool_end", toolName: "read", isError: true }],
        tools,
        new Set(["pr_review_context"]),
        undefined,
      ),
    ).toBe(false);
    expect(
      repairableAssistantText(
        turn,
        [...completedContext, { type: "tool_start", toolName: "read" }],
        tools,
        new Set(["pr_review_context"]),
        undefined,
      ),
    ).toBe(false);
  });

  it("repairs required assistant text for a prose-only turn (#9963)", () => {
    const turn: AdvisorPromptTurn = {
      name: "prose-only",
      prompt: "Analyze the evidence.",
      requireAssistantText: true,
      assistantTextRepairPrompt: "Return the analysis.",
    };
    const tools = resolveAdvisorTurnTools(turn, [], new Set());

    expect(repairableAssistantText(turn, [], tools, new Set(), undefined)).toBe(true);
  });

  it("rejects prose, unconfigured tools, and multiple submits during terminal-submit repair", () => {
    const successfulSubmit = [ledgerStart, ledgerSuccess];
    expect(
      terminalSubmitRepairErrors("prepare", [analysisEvent, ...successfulSubmit], ledgerToolName, [
        "repair_draft",
      ]).join("; "),
    ).toContain("emitted prose during repair");
    expect(
      terminalSubmitRepairErrors(
        "prepare",
        [
          { type: "tool_start", toolName: "read" },
          { type: "tool_end", toolName: "read", isError: false },
          ...successfulSubmit,
        ],
        ledgerToolName,
        ["repair_draft"],
      ).join("; "),
    ).toContain("called unexpected tool read");
    expect(
      terminalSubmitRepairErrors(
        "prepare",
        [
          { type: "tool_start", toolName: "repair_draft" },
          { type: "tool_end", toolName: "repair_draft", isError: false },
          ...successfulSubmit,
        ],
        ledgerToolName,
        ["repair_draft"],
      ),
    ).toEqual([]);
    expect(
      terminalSubmitRepairErrors(
        "prepare",
        [ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess],
        ledgerToolName,
        ["repair_draft"],
      ).join("; "),
    ).toContain("exactly 1");
  });

  it.each([
    ["duplicate success", [ledgerStart, ledgerSuccess, ledgerStart, ledgerSuccess]],
    [
      "failed twice then successful initial attempts",
      [ledgerStart, ledgerFailure, ledgerStart, ledgerFailure, ledgerStart, ledgerSuccess],
    ],
    ["activity after success", [ledgerStart, ledgerSuccess, analysisEvent]],
  ])("rejects terminal submit %s", (_case, events) => {
    const tools = {
      ...atomicMutationTools,
      atomicTerminalToolName: undefined,
      terminalSubmitToolName: ledgerToolName,
      terminalSubmitRepairToolNames: [],
    };
    expect(advisorTurnFlowErrors("prepare", events, tools).join("; ")).toMatch(
      /exactly 1|activity after successful/,
    );
  });

  it("permits read observations after a successful terminal submit", () => {
    const tools = {
      ...atomicMutationTools,
      atomicTerminalToolName: undefined,
      terminalSubmitToolName: ledgerToolName,
      terminalSubmitRepairToolNames: [],
    };
    const readObservation: AdvisorTurnFlowEvent = {
      type: "read",
      path: "/workspace/required.txt",
      offset: 1,
      endOffset: null,
      fileSize: 9,
      reachesEnd: true,
    };

    expect(
      advisorTurnFlowErrors("prepare", [ledgerStart, ledgerSuccess, readObservation], tools),
    ).toEqual([]);
  });
});
