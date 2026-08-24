// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  derivePiImageSourcePaths,
  parsePiJsonEvents,
  parsePiInferenceEvidence,
  parsePiRuntimePackageEvidence,
  qualifyPiReadTask,
} from "../live/pi-agent-qualification-events.ts";

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

function events(...values: Record<string, unknown>[]): string {
  return values.map((event) => JSON.stringify(event)).join("\n");
}

describe("Pi qualification event oracle", () => {
  it("derives source parity paths from Dockerfile inputs", () => {
    expect(
      derivePiImageSourcePaths([
        "COPY agents/pi/start.sh /usr/local/bin/start\nCOPY extra/runtime.txt /runtime.txt",
        "COPY --from=builder /built/runtime /runtime",
      ]),
    ).toEqual([".dockerignore", "agents/pi", "extra/runtime.txt"]);
  });

  it("rejects ambiguous Dockerfile copy inputs", () => {
    expect(() => derivePiImageSourcePaths(['COPY ["source", "/destination"]'])).toThrow(
      "must use plain path operands",
    );
  });

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

  it("rejects missing, extra, or mismatched read events", () => {
    const valid = parsePiJsonEvents(eventStream());
    expect(() =>
      qualifyPiReadTask(
        valid.filter((event) => event.type !== "tool_execution_end"),
        PATH,
        TOKEN,
      ),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask([...valid, { ...valid[1], toolCallId: "second-read" }], PATH, TOKEN),
    ).toThrow("must start exactly one tool");
    expect(() =>
      qualifyPiReadTask(
        parsePiJsonEvents(eventStream({ args: { path: "/sandbox/other" } })),
        PATH,
        TOKEN,
      ),
    ).toThrow("exact read tool call");
  });

  it("rejects an early or duplicate completion for the read call", () => {
    const start = {
      type: "tool_execution_start",
      toolCallId: "call-read",
      toolName: "read",
      args: { path: PATH },
    };
    const success = {
      type: "tool_execution_end",
      toolCallId: "call-read",
      toolName: "read",
      result: { content: TOKEN },
      isError: false,
    };
    const failure = { ...success, isError: true };
    const reply = {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: TOKEN }] },
    };

    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(success, start, failure, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
    expect(() =>
      qualifyPiReadTask(parsePiJsonEvents(events(start, success, success, reply)), PATH, TOKEN),
    ).toThrow("did not complete successfully");
  });

  it("accepts the managed Pi inference route and runtime package evidence", () => {
    expect(
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "https://inference.local/v1",
              models: [{ id: "nvidia/test-model" }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toEqual({
      api: "openai-completions",
      model: "nvidia/test-model",
      route: "https://inference.local/v1",
    });
    expect(
      parsePiRuntimePackageEvidence(
        JSON.stringify({
          packages: {
            "node_modules/@earendil-works/pi-coding-agent": {
              integrity: "sha512-reviewed",
              version: "0.84.1",
            },
          },
        }),
      ),
    ).toEqual({ integrity: "sha512-reviewed", version: "0.84.1" });
  });

  it("rejects missing or inconsistent Pi qualification evidence", () => {
    expect(() => parsePiInferenceEvidence("{}", "nvidia/test-model")).toThrow(
      "Pi managed inference providers must be an object",
    );
    expect(() =>
      parsePiInferenceEvidence(
        JSON.stringify({
          providers: {
            openshell: {
              api: "openai-completions",
              baseUrl: "https://inference.local/v1",
              models: [{ id: "nvidia/other-model" }],
            },
          },
        }),
        "nvidia/test-model",
      ),
    ).toThrow("does not match the qualified route");
    expect(() => parsePiRuntimePackageEvidence('{"packages":{}}')).toThrow(
      "Pi runtime package lock entry must be an object",
    );
  });
});
