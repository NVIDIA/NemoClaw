// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  type Listener = (event: unknown) => void;
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
  };

  const reset = (): void => {
    state.omitContextTool = false;
    state.activeToolCalls = [];
    state.contextContents = [];
    state.customTools = [];
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
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setActiveToolsByName(toolNames: string[]) {
        activeToolNames = [...toolNames];
        state.activeToolCalls.push([...toolNames]);
      },
      async prompt(prompt: string) {
        const contextTool = state.customTools.find(
          (tool) => activeToolNames.includes(tool.name) && tool.name.endsWith("_context"),
        );
        await (contextTool && !state.omitContextTool
          ? executeContextTool(contextTool, emit)
          : Promise.resolve());
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `analysis for ${prompt}` },
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

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal()),
  createAgentSession: sdk.createAgentSession,
}));

import {
  type AdvisorPromptTurn,
  READ_ONLY_TOOLS,
  runReadOnlyAdvisor,
} from "../tools/advisors/session.mts";

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

async function run(promptTurns: AdvisorPromptTurn[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-session-runner-"));
  tempDirs.push(dir);
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
    customTools: [customTool("turn_action")],
  });
}

afterEach(() => {
  delete process.env.TEST_ADVISOR_KEY;
  sdk.reset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("advisor session runner", () => {
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
