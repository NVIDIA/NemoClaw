// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "openclaw-plugins",
  "kimi-inference-compat",
  "index.js",
);

const plugin = require(PLUGIN_PATH);

function makeProvider() {
  const providers: any[] = [];
  plugin.register({
    registerProvider(provider: any) {
      providers.push(provider);
    },
  });
  return providers[0];
}

function managedKimiCtx(streamFn?: any) {
  return {
    provider: "inference",
    modelId: "moonshotai/kimi-k2.6",
    modelApi: "openai-completions",
    model: {
      api: "openai-completions",
      baseUrl: "https://inference.local/v1",
    },
    streamFn,
  };
}

function toolMessage(command: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "call_kimi_exec",
        name: "exec",
        arguments: { command },
        ...overrides,
      },
    ],
  };
}

function failedToolContext() {
  return {
    messages: [
      {
        role: "toolResult",
        content: [
          {
            type: "toolResult",
            toolCallId: "call_kimi_exec",
            isError: true,
            text: "exec failed: command not found",
          },
        ],
      },
    ],
  };
}

function failedToolAssistantMessage() {
  return {
    role: "assistant",
    stopReason: "stop",
    reasoning: "PRIVATE reasoning after the exec tool failed",
    reasoning_content: "PRIVATE chain-of-thought after the tool failure",
    reasoningDetails: [{ text: "PRIVATE detailed reasoning" }],
    thinking: "PRIVATE thinking content",
    content: [
      { type: "thinking", text: "PRIVATE streamed thinking block" },
      { type: "text", text: "The exec tool failed: command not found." },
    ],
  };
}

describe("nemoclaw Kimi inference compat plugin", () => {
  it("splits the safe combined exec diagnostics into separate tool calls", () => {
    const message = toolMessage("hostname; date; uptime");

    expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(true);

    expect(message.content).toEqual([
      {
        type: "toolCall",
        id: "call_kimi_exec_split_1_hostname",
        name: "exec",
        arguments: { command: "hostname" },
      },
      {
        type: "toolCall",
        id: "call_kimi_exec_split_2_date",
        name: "exec",
        arguments: { command: "date" },
      },
      {
        type: "toolCall",
        id: "call_kimi_exec_split_3_uptime",
        name: "exec",
        arguments: { command: "uptime" },
      },
    ]);
  });

  it("trims harmless whitespace around safe diagnostic commands", () => {
    const message = toolMessage("ignored", {
      arguments: JSON.stringify({ command: " hostname ;  date ; uptime " }),
    });

    expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(true);

    expect(message.content.map((block: any) => block.arguments.command)).toEqual([
      "hostname",
      "date",
      "uptime",
    ]);
  });

  it("drops transient streaming fields from split tool calls", () => {
    const message = toolMessage("hostname; date; uptime", {
      partialArgs: JSON.stringify({ command: "hostname; date; uptime" }),
    });

    expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(true);

    expect(message.content).toEqual([
      {
        type: "toolCall",
        id: "call_kimi_exec_split_1_hostname",
        name: "exec",
        arguments: { command: "hostname" },
      },
      {
        type: "toolCall",
        id: "call_kimi_exec_split_2_date",
        name: "exec",
        arguments: { command: "date" },
      },
      {
        type: "toolCall",
        id: "call_kimi_exec_split_3_uptime",
        name: "exec",
        arguments: { command: "uptime" },
      },
    ]);
  });

  it("keeps split ids stable if a streaming partial was already rewritten", () => {
    const message = toolMessage("hostname; date; uptime", {
      id: "call_kimi_exec_split_1_hostname",
    });

    expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(true);

    expect(message.content.map((block: any) => block.id)).toEqual([
      "call_kimi_exec_split_1_hostname",
      "call_kimi_exec_split_2_date",
      "call_kimi_exec_split_3_uptime",
    ]);
  });

  it.each([
    "hostname && date && uptime",
    "hostname; date; uptime > /tmp/out",
    "hostname; date; uptime | cat",
    "hostname; date; echo ok",
    "hostname; date; $UPTIME",
    "hostname; date; $(uptime)",
    '"hostname"; date; uptime',
    "hostname; date; uptime;",
  ])("does not split unsafe or unknown command strings: %s", (command) => {
    const message = toolMessage(command);
    const before = structuredClone(message);

    expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(false);
    expect(message).toEqual(before);
  });

  it("does not affect non-Kimi providers", () => {
    const provider = makeProvider();
    const wrapper = provider.wrapStreamFn({
      ...managedKimiCtx(() => undefined),
      provider: "openai",
    });

    expect(wrapper).toBeUndefined();
  });

  it("does not split non-exec tools, multiple tool calls, or malformed args", () => {
    const nonExec = toolMessage("hostname; date; uptime", { name: "write" });
    const multipleToolCalls = {
      ...toolMessage("hostname; date; uptime"),
      content: [
        toolMessage("hostname").content[0],
        toolMessage("date").content[0],
      ],
    };
    const malformedArgs = toolMessage("hostname; date; uptime", {
      arguments: JSON.stringify({ command: "hostname; date; uptime", extra: true }),
    });

    for (const message of [nonExec, multipleToolCalls, malformedArgs]) {
      const before = structuredClone(message);
      expect(plugin.__testing.rewriteSafeCombinedExecToolCallInMessage(message)).toBe(false);
      expect(message).toEqual(before);
    }
  });

  it("filters Kimi reasoning fields from final assistant messages after tool failures", async () => {
    const provider = makeProvider();
    const wrapper = provider.wrapStreamFn(
      managedKimiCtx(() => ({
        async result() {
          return failedToolAssistantMessage();
        },
      })),
    );

    expect(wrapper).toEqual(expect.any(Function));

    const stream = wrapper({}, failedToolContext(), {});
    const result = await stream.result();

    expect(result).toEqual({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "The exec tool failed: command not found." }],
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("drops Kimi reasoning stream events while preserving content and tool-call deltas", async () => {
    const provider = makeProvider();
    const finalMessage = failedToolAssistantMessage();
    const wrapper = provider.wrapStreamFn(
      managedKimiCtx(() => ({
        async result() {
          return finalMessage;
        },
        async *[Symbol.asyncIterator]() {
          yield { type: "reasoning_delta", delta: "PRIVATE stream reasoning after tool failure" };
          yield {
            type: "content_delta",
            delta: "The exec tool failed: command not found.",
            reasoning_content: "PRIVATE event reasoning",
            partial: failedToolAssistantMessage(),
          };
          yield {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify({ command: "hostname" }),
            reasoning: "PRIVATE tool-call event reasoning",
            partial: toolMessage("hostname"),
          };
          yield { type: "done", message: finalMessage };
        },
      })),
    );

    expect(wrapper).toEqual(expect.any(Function));

    const stream = wrapper({}, failedToolContext(), {});
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((event: any) => event.type)).toEqual([
      "content_delta",
      "toolcall_delta",
      "done",
    ]);
    expect(events[0].partial.content).toEqual([
      { type: "text", text: "The exec tool failed: command not found." },
    ]);
    expect(events[0].delta).toBe("The exec tool failed: command not found.");
    expect(events[1].delta).toBe(JSON.stringify({ command: "hostname" }));
    expect(events[1].partial.content[0].arguments.command).toBe("hostname");
    expect(events[2].message.content).toEqual([
      { type: "text", text: "The exec tool failed: command not found." },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "The exec tool failed: command not found." },
    ]);
    expect(JSON.stringify({ events, result })).not.toContain("PRIVATE");
  });

  it("wraps managed Kimi streams and rewrites partial and final assistant messages", async () => {
    const partial = toolMessage("ignored until delta is complete", { arguments: {} });
    const message = toolMessage("hostname; date; uptime");
    const provider = makeProvider();
    const wrapper = provider.wrapStreamFn(
      managedKimiCtx(() => ({
        async result() {
          return message;
        },
        async *[Symbol.asyncIterator]() {
          yield {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify({ command: "hostname; date; uptime" }),
            partial,
          };
          yield { type: "done", message };
        },
      })),
    );

    expect(wrapper).toEqual(expect.any(Function));

    const stream = wrapper({}, {}, {});
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events[0].partial.content.map((block: any) => block.arguments.command)).toEqual([
      "hostname",
      "date",
      "uptime",
    ]);
    expect(JSON.parse(events[0].delta).command).toBe("hostname");
    expect(events[1].message.content.map((block: any) => block.arguments.command)).toEqual([
      "hostname",
      "date",
      "uptime",
    ]);
    expect(result.content.map((block: any) => block.arguments.command)).toEqual([
      "hostname",
      "date",
      "uptime",
    ]);
  });
});
