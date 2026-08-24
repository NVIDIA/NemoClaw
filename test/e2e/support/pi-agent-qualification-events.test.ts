// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parsePiJsonEvents, qualifyPiReadTask } from "../live/pi-agent-qualification-events.ts";

const PATH = "/sandbox/pi-qualification.txt";
const TOKEN = "NEMOCLAW_PI_TASK_V1_0123456789ABCDEF";

function eventStream(overrides: Record<string, unknown> = {}): string {
  return [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
      ...overrides,
    },
    {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    },
    { type: "agent_end", messages: [], willRetry: false },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

describe("Pi qualification event oracle", () => {
  it("accepts one successful read and an exact final response", () => {
    const events = parsePiJsonEvents(eventStream());

    expect(qualifyPiReadTask(events, PATH, TOKEN)).toEqual({
      assistantText: TOKEN,
      eventCount: 5,
      toolCallId: "call-read",
    });
  });

  it("rejects malformed JSON, another tool, a failed read, and altered output", () => {
    expect(() => parsePiJsonEvents("not-json\n")).toThrow();
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(eventStream({ toolName: "bash" })), PATH, TOKEN),
    ).toThrow("exact read tool call");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream().replace('"isError":false', '"isError":true')),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() => qualifyPiReadTask(parsePiJsonEvents(eventStream()), PATH, `${TOKEN}X`)).toThrow(
      "instead of exact file contents",
    );
  });
});
