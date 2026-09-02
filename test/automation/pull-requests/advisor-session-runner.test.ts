// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
  type TerminalResponse =
    | "omit"
    | "fail-once"
    | "fail-twice"
    | "fail-thrice"
    | "fail-four-times"
    | "fail-four-times-then-success"
    | "fail-five-times"
    | "fail-five-times-then-success"
    | "fail-twice-then-success"
    | "fail-then-success"
    | "success";
  const terminalPlans: Record<TerminalResponse, { failureCount: number; succeeds: boolean }> = {
    omit: { failureCount: 0, succeeds: false },
    "fail-once": { failureCount: 1, succeeds: false },
    "fail-twice": { failureCount: 2, succeeds: false },
    "fail-thrice": { failureCount: 3, succeeds: false },
    "fail-four-times": { failureCount: 4, succeeds: false },
    "fail-four-times-then-success": { failureCount: 4, succeeds: true },
    "fail-five-times": { failureCount: 5, succeeds: false },
    "fail-five-times-then-success": { failureCount: 5, succeeds: true },
    "fail-twice-then-success": { failureCount: 2, succeeds: true },
    "fail-then-success": { failureCount: 1, succeeds: true },
    success: { failureCount: 0, succeeds: true },
  };
  type MockTool = {
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, never>,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      context: never,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  };

  const state = {
    omitContextTool: false,
    activeToolCalls: [] as string[][],
    contextContents: [] as string[],
    customTools: [] as MockTool[],
    emitAnalysisError: false,
    emitCommitProse: false,
    emitRepairProse: false,
    omitAnalysis: false,
    omitAnalysisPrompts: 0,
    prompts: [] as string[],
    retryResponses: [] as Array<"exhausted" | "success">,
    terminalResponses: [] as TerminalResponse[],
  };

  const reset = (): void => {
    state.omitContextTool = false;
    state.activeToolCalls = [];
    state.contextContents = [];
    state.customTools = [];
    state.emitAnalysisError = false;
    state.emitCommitProse = false;
    state.emitRepairProse = false;
    state.omitAnalysis = false;
    state.omitAnalysisPrompts = 0;
    state.prompts = [];
    state.retryResponses = [];
    state.terminalResponses = [];
  };

  const executeTerminalTool = async (tool: MockTool, emit: Listener): Promise<void> => {
    emit({ type: "tool_execution_start", toolName: tool.name });
    try {
      await tool.execute(`${tool.name}-call`, {}, undefined, undefined, undefined as never);
      emit({ type: "tool_execution_end", toolName: tool.name, isError: false });
    } catch {
      emit({ type: "tool_execution_end", toolName: tool.name, isError: true });
    }
  };

  const failTerminalTool = (tool: MockTool, emit: Listener): void => {
    emit({ type: "tool_execution_start", toolName: tool.name });
    emit({ type: "tool_execution_end", toolName: tool.name, isError: true });
  };

  const executeReadTool = async (tool: MockTool, target: string, emit: Listener): Promise<void> => {
    emit({ type: "tool_execution_start", toolName: tool.name });
    try {
      await tool.execute(
        `${tool.name}-call`,
        { path: target } as never,
        undefined,
        undefined,
        undefined as never,
      );
      emit({ type: "tool_execution_end", toolName: tool.name, isError: false });
    } catch {
      emit({ type: "tool_execution_end", toolName: tool.name, isError: true });
    }
  };

  const executeContextTool = async (contextTool: MockTool, emit: Listener): Promise<void> => {
    emit({ type: "tool_execution_start", toolName: contextTool.name });
    try {
      const result = await contextTool.execute(
        `${contextTool.name}-call`,
        {},
        undefined,
        undefined,
        undefined as never,
      );
      state.contextContents.push(result.content[0]?.text ?? "");
      emit({ type: "tool_execution_end", toolName: contextTool.name, isError: false });
    } catch {
      emit({ type: "tool_execution_end", toolName: contextTool.name, isError: true });
    }
  };

  const createAgentSession = vi.fn(async (options: { customTools?: MockTool[] }) => {
    state.customTools = options.customTools ?? [];
    const listeners = new Set<Listener>();
    let activeToolNames: string[] = [];
    const emit = (event: unknown): void => {
      for (const listener of listeners) listener(event);
    };
    const session = {
      sessionFile: "/tmp/pi-session.jsonl",
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setActiveToolsByName(toolNames: string[]) {
        activeToolNames = [...toolNames];
        state.activeToolCalls.push([...toolNames]);
      },
      async prompt(prompt: string) {
        state.prompts.push(prompt);
        const contextTool = state.customTools.find(
          (tool) => activeToolNames.includes(tool.name) && tool.name.endsWith("_context"),
        );
        const terminalTool = state.customTools.find(
          (tool) => activeToolNames.includes(tool.name) && tool.name === "turn_action",
        );
        const terminalResponse = terminalTool
          ? (state.terminalResponses.shift() ?? "omit")
          : "omit";
        const terminalPlan = terminalPlans[terminalResponse];
        const retryResponse = terminalTool ? undefined : state.retryResponses.shift();
        const isRepairPrompt =
          prompt.includes("Call `turn_action` now") || prompt.includes("Complete the repair");
        await (contextTool && !state.omitContextTool
          ? executeContextTool(contextTool, emit)
          : Promise.resolve());
        const requiredReadPath = /^- (.+)$/mu.exec(prompt.split("Required files:\n")[1] ?? "")?.[1];
        const readTool = state.customTools.find(
          (tool) => requiredReadPath && activeToolNames.includes(tool.name) && tool.name === "read",
        );
        await (readTool && requiredReadPath
          ? executeReadTool(readTool, requiredReadPath, emit)
          : Promise.resolve());
        const repairTools = state.customTools.filter(
          (tool) => isRepairPrompt && activeToolNames.includes(tool.name) && tool !== terminalTool,
        );
        for (const repairTool of repairTools) await executeTerminalTool(repairTool, emit);
        Array.from({ length: terminalTool ? terminalPlan.failureCount : 0 }).forEach(() =>
          failTerminalTool(terminalTool as MockTool, emit),
        );
        const retryError = "429 status code (no body)";
        const retryAttemptEvents = [
          {
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              error: { errorMessage: "transient stream failure before response" },
              reason: "error",
            },
          },
          {
            type: "message_end",
            message: { role: "assistant", stopReason: "error", errorMessage: retryError },
          },
          {
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 4,
            delayMs: 6_000,
            errorMessage: retryError,
          },
        ];
        const retryPlans = {
          none: [],
          success: [...retryAttemptEvents, { type: "auto_retry_end", success: true, attempt: 1 }],
          exhausted: [
            ...retryAttemptEvents,
            { type: "auto_retry_end", success: false, attempt: 1, finalError: retryError },
          ],
        };
        retryPlans[retryResponse ?? "none"].forEach(emit);
        const omitThisAnalysis = state.omitAnalysis || state.omitAnalysisPrompts > 0;
        state.omitAnalysisPrompts = Math.max(0, state.omitAnalysisPrompts - 1);
        const shouldEmitText =
          !omitThisAnalysis &&
          retryResponse !== "exhausted" &&
          !prompt.startsWith("Prepare ") &&
          (!prompt.includes("Emit no prose before or after") ||
            (state.emitCommitProse && !isRepairPrompt) ||
            (state.emitRepairProse && isRepairPrompt));
        shouldEmitText &&
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: `analysis for ${prompt}` },
          });
        await (terminalTool && terminalPlan.succeeds
          ? executeTerminalTool(terminalTool, emit)
          : Promise.resolve());
        state.emitAnalysisError &&
          !terminalTool &&
          emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "error",
              error: { errorMessage: "analysis stream failed" },
              reason: "error",
            },
          });
        emit({ type: "agent_end" });
      },
      abort: vi.fn(async () => {}),
      exportToHtml: vi.fn(async (outputPath: string) => outputPath),
      dispose: vi.fn(),
    };
    return { session, modelFallbackMessage: undefined };
  });

  return {
    state,
    reset,
    createAgentSession,
  };
});

const transport = vi.hoisted(() => ({
  configure: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal()),
  createAgentSession: sdk.createAgentSession,
}));

vi.mock("../../../tools/advisors/http-dispatcher.mts", () => ({
  configureAdvisorHttpDispatcher: transport.configure,
}));

import {
  ADVISOR_OPENAI_COMPATIBLE_BASE_URL,
  ADVISOR_OPENSHELL_INFERENCE_BASE_URL,
  type AdvisorPromptTurn,
  advisorRetrySettings,
  READ_ONLY_TOOLS,
  runReadOnlyAdvisor,
} from "../../../tools/advisors/session.mts";

const tempDirs: string[] = [];

function turn(name: string, content: string, isError = false): AdvisorPromptTurn {
  return {
    name,
    prompt: `Review ${name}`,
    contextToolResults: [
      {
        toolName: "review_context",
        content,
        contentType: "json",
        isError,
      },
    ],
  };
}

function customTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: "Mock turn-only action",
    parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  };
}

function analysisTurn(name: string): AdvisorPromptTurn {
  return {
    ...turn(name, '{"repair":true}'),
    requireAssistantText: true,
    assistantTextRepairPrompt: "Return the required analysis.",
  };
}

function submitTurn(name: string): AdvisorPromptTurn {
  return {
    ...turn(name, '{"submit":true}'),
    activeToolNames: ["turn_action", "draft_action"],
    terminalSubmitToolName: "turn_action",
    terminalSubmitRepairPrompt: "Repair the failed draft and submit it.",
    terminalSubmitRepairToolNames: ["repair_action"],
  };
}

function commitTurn(name: string): AdvisorPromptTurn {
  return {
    name,
    prompt: "Commit the preceding analysis. Emit no prose before or after the tool call.",
    activeToolNames: ["turn_action"],
    requiredToolNames: ["turn_action"],
    atomicTerminalToolName: "turn_action",
    atomicTerminalRepairPrompt:
      "Retry only the atomic turn action. Emit no prose before or after the tool call.",
  };
}

async function run(promptTurns: AdvisorPromptTurn[], prepare?: (directory: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-session-runner-"));
  tempDirs.push(dir);
  prepare?.(dir);
  process.env.TEST_ADVISOR_KEY = "test-key";
  return runReadOnlyAdvisor({
    cwd: dir,
    promptTurns,
    systemPrompt: "system",
    configDir: path.join(dir, "config"),
    htmlExportPath: path.join(dir, "session.html"),
    timeoutMs: 5_000,
    heartbeatMs: 60_000,
    maxCaptureBytes: 64 * 1024,
    credentialEnv: "TEST_ADVISOR_KEY",
    logPrefix: "test-advisor",
    logProgress: () => {},
    customTools: [
      customTool("turn_action"),
      customTool("draft_action"),
      customTool("repair_action"),
    ],
  });
}

afterEach(() => {
  delete process.env.TEST_ADVISOR_KEY;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  sdk.reset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("advisor session runner", () => {
  it("uses one bounded, specialist-spread retry layer for transient failures", () => {
    const behavior = advisorRetrySettings(
      "azure/openai/gpt-5.6-terra",
      "pr-review-behavior",
    );
    const dependencyUse = advisorRetrySettings(
      "openai/openai/gpt-5.6-terra",
      "pr-review-dependency-use",
    );

    expect(behavior).toEqual({
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 13_909,
      provider: {
        maxRetries: 0,
        maxRetryDelayMs: 60_000,
      },
    });
    expect(dependencyUse.baseDelayMs).toBe(14_827);
  });

  it("configures Pi's proxy transport before an OpenShell SDK session", async () => {
    vi.stubEnv("PR_REVIEW_ADVISOR_BASE_URL", ADVISOR_OPENSHELL_INFERENCE_BASE_URL);

    const result = await run([analysisTurn("only-analysis")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.sessionFile).toBe("/tmp/pi-session.jsonl");
    expect(transport.configure).toHaveBeenCalledOnce();
    expect(transport.configure.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.createAgentSession.mock.invocationCallOrder[0] as number,
    );
  });

  it("leaves the global transport unchanged for hosted advisor inference", async () => {
    vi.stubEnv("PR_REVIEW_ADVISOR_BASE_URL", ADVISOR_OPENAI_COMPATIBLE_BASE_URL);

    const result = await run([analysisTurn("only-analysis")]);

    expect(result.fatalError).toBeUndefined();
    expect(transport.configure).not.toHaveBeenCalled();
  });

  it("clears a transient provider error after the same-session retry succeeds", async () => {
    sdk.state.retryResponses = ["success"];
    const result = await run([analysisTurn("only-analysis")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("retry 1/4 delay_ms=6000: 429 status code (no body)");
    expect(result.raw).toContain("retry_end success=true attempts=1");
  });

  it("keeps the provider error when same-session retries are exhausted", async () => {
    sdk.state.retryResponses = ["exhausted"];
    const result = await run([analysisTurn("only-analysis")]);

    expect(result.fatalError).toBe("429 status code (no body)");
    expect(result.turnErrors).toEqual(["only-analysis: 429 status code (no body)"]);
    expect(result.raw).toContain("retry_end success=false attempts=1");
  });

  it.each([
    ["omitted", "omit"],
    ["failed once", "fail-once"],
    ["failed twice", "fail-twice"],
  ] as const)("repairs a terminal tool that was %s (#6446)", async (_case, initialResponse) => {
    sdk.state.terminalResponses = [initialResponse, "success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("atomic_terminal_repair_start only-commit turn_action");
    expect(result.raw).toContain("atomic_terminal_repair_end only-commit turn_action ok");
    expect(sdk.state.activeToolCalls).toEqual([
      [...READ_ONLY_TOOLS, "review_context"],
      READ_ONLY_TOOLS,
      ["turn_action"],
      ["turn_action"],
      READ_ONLY_TOOLS,
    ]);
    expect(sdk.state.prompts).toHaveLength(3);
    expect(sdk.state.prompts[2]).toContain("Call `turn_action` now");
  });

  it("repairs a preparatory terminal submit only after a settled failure", async () => {
    sdk.state.terminalResponses = ["fail-once", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("terminal_submit_repair_start prepare-and-submit turn_action");
    expect(sdk.state.activeToolCalls).toContainEqual(["repair_action", "turn_action"]);
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("repairs two failed initial submit attempts (#9963)", async () => {
    const responses = ["fail-twice", "success"] as const;
    sdk.state.terminalResponses = [...responses];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.raw).toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("repairs three failed initial submit attempts (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-thrice", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.raw).toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("repairs four failed initial submit attempts (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-four-times", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.raw).toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("repairs five failed initial submit attempts (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-five-times", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.raw).toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("accepts one failed submit followed by one same-turn success (#9630)", async () => {
    sdk.state.terminalResponses = ["fail-then-success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).not.toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(1);
  });

  it("accepts two failed duplicate submits and one successful submit (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-twice-then-success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).not.toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(1);
  });

  it("accepts four failed submits followed by one same-turn success (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-four-times-then-success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).not.toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(1);
  });

  it("accepts five failed submits followed by one same-turn success (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-five-times-then-success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).not.toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(1);
  });

  it("deduplicates relative aliases before required-read preparation (#9963)", async () => {
    sdk.state.terminalResponses = ["success"];
    const result = await run(
      [
        {
          ...submitTurn("prepare-and-submit"),
          requiredReadPaths: ["required.txt", "./required.txt"],
        },
      ],
      (directory) => fs.writeFileSync(path.join(directory, "required.txt"), "required\n", "utf8"),
    );

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("required_read_preparation_end prepare-and-submit ok");
  });

  it("prepares every distinct required read before submission (#9963)", async () => {
    sdk.state.terminalResponses = ["success"];
    const result = await run(
      [
        {
          ...submitTurn("prepare-and-submit"),
          requiredReadPaths: ["first.txt", "second.txt"],
        },
      ],
      (directory) => {
        fs.writeFileSync(path.join(directory, "first.txt"), "first\n", "utf8");
        fs.writeFileSync(path.join(directory, "second.txt"), "second\n", "utf8");
      },
    );

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(sdk.state.prompts).toHaveLength(3);
    expect(sdk.state.prompts[0]).toMatch(/first\.txt/u);
    expect(sdk.state.prompts[1]).toMatch(/second\.txt/u);
    expect(result.raw).toContain("required_read_preparation_end prepare-and-submit ok");
  });

  it("accepts an empty required file at EOF (#9963)", async () => {
    const requiredReadTurn: AdvisorPromptTurn = {
      name: "read-empty",
      prompt: "Analyze the required file.",
      requiredReadPaths: ["empty.txt"],
      requireAssistantText: true,
    };
    const result = await run([requiredReadTurn], (directory) =>
      fs.writeFileSync(path.join(directory, "empty.txt"), "", "utf8"),
    );

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("required_read_preparation_end read-empty ok");
  });

  it("rejects a required read outside the workspace (#9963)", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-required-read-outside-"));
    tempDirs.push(outside);
    const outsideFile = path.join(outside, "outside.txt");
    fs.writeFileSync(outsideFile, "outside\n", "utf8");

    await expect(
      run([
        {
          name: "read-outside",
          prompt: "Analyze the required file.",
          requiredReadPaths: [outsideFile],
        },
      ]),
    ).rejects.toThrow("outside the workspace");
  });

  it("allows one failed initial submit followed by one repair success", async () => {
    sdk.state.terminalResponses = ["fail-once", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("rejects multiple submit attempts during terminal-submit repair", async () => {
    sdk.state.terminalResponses = ["fail-once", "fail-then-success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toContain("terminal-submit repair must make exactly 1");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("rejects prose during preparatory terminal-submit repair", async () => {
    sdk.state.emitRepairProse = true;
    sdk.state.terminalResponses = ["fail-once", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toContain("terminal-submit repair emitted prose during repair");
    expect(result.turnErrors).toEqual([
      expect.stringContaining("terminal-submit repair emitted prose during repair"),
    ]);
  });

  it("repairs an omitted preparatory terminal submit (#9963)", async () => {
    sdk.state.terminalResponses = ["omit", "success"];
    const result = await run([submitTurn("prepare-and-submit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.raw).toContain("terminal_submit_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("repairs omitted required recording tools before submit (#9963)", async () => {
    sdk.state.terminalResponses = ["fail-once", "success"];
    const requiredRecordingTurn = {
      ...submitTurn("prepare-and-submit"),
      requiredToolNames: ["draft_action", "turn_action"],
      terminalSubmitRepairToolNames: ["draft_action"],
    };
    const result = await run([requiredRecordingTurn]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("tool_end draft_action ok");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("accepts a failed atomic attempt followed by one same-turn success (#6446)", async () => {
    sdk.state.terminalResponses = ["fail-then-success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).not.toContain("atomic_terminal_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("rejects prose during the initial tool-only atomic commit (#6446)", async () => {
    sdk.state.emitCommitProse = true;
    sdk.state.terminalResponses = ["success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toContain("emitted prose during atomic turn_action commit");
    expect(result.turnErrors).toEqual([
      expect.stringContaining("emitted prose during atomic turn_action commit"),
    ]);
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("does not repair a prose-only atomic commit by mutating the ledger (#6446)", async () => {
    sdk.state.emitCommitProse = true;
    sdk.state.terminalResponses = ["omit", "success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toContain("emitted prose during atomic turn_action commit");
    expect(result.raw).not.toContain("atomic_terminal_repair_start");
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("fails closed after one unsuccessful atomic-terminal repair (#6446)", async () => {
    sdk.state.terminalResponses = ["omit", "omit"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toContain(
      "only-commit atomic-terminal repair must commit turn_action successfully once",
    );
    expect(result.turnErrors).toEqual([
      expect.stringContaining(
        "only-commit atomic-terminal repair must commit turn_action successfully once",
      ),
    ]);
    expect(sdk.state.prompts).toHaveLength(3);
  });

  it("rejects prose during the tool-only atomic-terminal repair (#6446)", async () => {
    sdk.state.emitRepairProse = true;
    sdk.state.terminalResponses = ["omit", "success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toContain(
      "only-commit atomic-terminal repair emitted prose during atomic turn_action commit",
    );
    expect(result.turnErrors).toEqual([
      expect.stringContaining("emitted prose during atomic turn_action commit"),
    ]);
  });

  it("repairs omitted required analysis before the next turn (#9963)", async () => {
    sdk.state.omitAnalysisPrompts = 1;
    sdk.state.terminalResponses = ["success"];
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(result.raw).toContain("assistant_text_repair_start only-analysis");
    expect(sdk.state.prompts).toHaveLength(3);
  });

  it("fails before the next turn when required analysis repair is empty (#9963)", async () => {
    sdk.state.omitAnalysis = true;
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toContain(
      "only-analysis assistant-text repair omitted required analysis",
    );
    expect(result.turnErrors).toEqual([
      expect.stringContaining("assistant-text repair omitted required analysis"),
    ]);
    expect(sdk.state.prompts).toHaveLength(2);
  });

  it("stops before the commit turn when the SDK reports an analysis error (#6446)", async () => {
    sdk.state.emitAnalysisError = true;
    const result = await run([analysisTurn("only-analysis"), commitTurn("only-commit")]);

    expect(result.fatalError).toBe("analysis stream failed");
    expect(result.turnErrors).toEqual(["only-analysis: analysis stream failed"]);
    expect(sdk.state.prompts).toHaveLength(1);
  });

  it.each([
    ["omitted", false],
    ["failed", true],
  ])("fails closed when required context is %s (#6446)", async (mode, isError) => {
    sdk.state.omitContextTool = mode === "omitted";
    const result = await run([turn("only", "required context", isError)]);

    expect(result.fatalError).toContain("omitted required tool result(s): review_context");
    expect(result.turnErrors).toEqual([
      expect.stringContaining("only: omitted required tool result(s): review_context"),
    ]);
    expect(sdk.state.activeToolCalls).toEqual([
      [...READ_ONLY_TOOLS, "review_context"],
      READ_ONLY_TOOLS,
    ]);
    const contextTool = sdk.state.customTools.find((tool) => tool.name === "review_context");
    await expect(
      contextTool?.execute("after-turn", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow("not active");
  });

  it("scopes context and extra active tools to each turn, then resets them (#6446)", async () => {
    const first = { ...turn("first", '{"turn":1}'), activeToolNames: ["turn_action"] };
    const result = await run([first, turn("second", '{"turn":2}')]);

    expect(result.fatalError).toBeUndefined();
    expect(result.turnErrors).toEqual([]);
    expect(sdk.state.contextContents).toEqual(['{"turn":1}', '{"turn":2}']);
    expect(sdk.state.activeToolCalls).toEqual([
      [...READ_ONLY_TOOLS, "review_context", "turn_action"],
      READ_ONLY_TOOLS,
      [...READ_ONLY_TOOLS, "review_context"],
      READ_ONLY_TOOLS,
    ]);
    const contextTool = sdk.state.customTools.find((tool) => tool.name === "review_context");
    await expect(
      contextTool?.execute("after-session", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow("not active");
  });
});
