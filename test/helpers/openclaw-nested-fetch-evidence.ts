// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// OpenClaw 2026.9.2 records nested tool results as openclaw.nested-tool.v1.
// Its model.completed snapshot contains the wrapper, without a projected target.
export function nestedFetchEvidence(variant: string) {
  const url = "https://www.wikidata.org/w/api.php?entity=Q30&secret=must-not-remain";
  const input = { url, maxChars: 8000 };
  const payload = { url, finalUrl: url, status: 200, text: "United States" };
  const wrapper = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "wrapper-1",
        name: "tool_call",
        arguments: { id: "openclaw:core:web_fetch", args: input },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolCallId: "wrapper-1",
    toolName: "tool_call",
    content: [{ type: "text", text: "{}" }],
    isError: false,
  };
  const details: Record<string, unknown> = {
    runId: "run-1",
    scopeId: "scope-1",
    afterEntryId: "entry-1",
    startOrder: 0,
    parentToolCallId: "wrapper-1",
    toolCallId: "tool_search_code:wrapper-1:web_fetch:1",
    toolName: "web_fetch",
    input,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload },
    isError: false,
    startedAt: 1,
    timestamp: 2,
  };
  const nested = {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    display: true,
    excludeFromContext: true,
    content: "",
    details,
    timestamp: 1,
  };
  switch (variant) {
    case "wrong run":
      details.runId = "another-run";
      break;
    case "wrong parent":
      details.parentToolCallId = "another-wrapper";
      break;
    case "wrong generated ID":
      details.toolCallId = "tool_search_code:another-wrapper:web_fetch:1";
      break;
    case "wrong wrapper target":
      wrapper.content[0]!.arguments.id = "openclaw:core:exec";
      break;
    case "tool failure":
      details.isError = true;
      break;
    case "missing error flag":
      delete details.isError;
      break;
    case "missing result":
      delete details.result;
      break;
    case "omitted result":
      details.result = {
        content: [{ type: "text", text: "[Nested tool output omitted: exceeds display limit]" }],
      };
      break;
    case "oversized request":
      input.maxChars = 8001;
      break;
    case "wrong URL":
      input.url = "https://example.com/";
      break;
    case "wrong role":
      nested.role = "assistant";
      break;
    case "context-visible record":
      nested.excludeFromContext = false;
      break;
  }
  const messages: unknown[] = [wrapper, result, nested];
  if (variant === "duplicate record") messages.push(nested);
  if (variant === "hidden forbidden tool")
    messages.push({
      ...nested,
      details: { ...details, toolCallId: "tool_search_code:wrapper-1:exec:2", toolName: "exec" },
    });
  const trajectory = [
    { type: "model.completed", runId: "run-1", data: { messagesSnapshot: [wrapper, result] } },
    {
      type: "trace.artifacts",
      runId: "run-1",
      data: {
        finalStatus: "success",
        toolMetas: [
          { toolName: "web_fetch", meta: url },
          { toolName: "tool_call", meta: {} },
        ],
      },
    },
  ];
  if (variant === "parent outside snapshot") {
    const snapshot = structuredClone([wrapper, result]);
    (snapshot[0] as typeof wrapper).content[0]!.id = "current-wrapper";
    (snapshot[1] as typeof result).toolCallId = "current-wrapper";
    trajectory[0]!.data.messagesSnapshot = snapshot;
  }
  return {
    session: messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"),
    trajectory: trajectory.map((event) => JSON.stringify(event)).join("\n"),
    expectation: { url, content: "United States" },
  };
}
