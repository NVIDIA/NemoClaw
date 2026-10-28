// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { assertLocalInferenceAgentResponse } from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";

const input = {
  agent: "openclaw" as const,
  image: `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`,
  sandbox: "managed-openclaw",
  localProvider: "ollama" as const,
  model: "fixture-model",
};
const meta = {
  aborted: false,
  agentMeta: { provider: "inference", model: "fixture-model" },
};

function rejectedDiagnostic(result: unknown) {
  let failure: unknown;
  try {
    assertLocalInferenceAgentResponse(input, JSON.stringify({ status: "ok", result }), true);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  const diagnostic = JSON.parse(message.split("; diagnostic=")[1]);
  return { message, diagnostic };
}

it.each([
  { payloads: undefined, payloadCount: null, lengths: [] },
  { payloads: [], payloadCount: 0, lengths: [] },
  { payloads: [{}], payloadCount: 1, lengths: [null] },
  { payloads: [{ text: "" }], payloadCount: 1, lengths: [0] },
])("distinguishes missing and empty OpenClaw answer payloads [%#]", (fixture) => {
  const { message, diagnostic } = rejectedDiagnostic({
    meta: { ...meta, finalAssistantVisibleText: "", finalAssistantRawText: "private reasoning" },
    payloads: fixture.payloads,
  });
  expect(message).toContain("no assistant answer");
  expect(diagnostic).toMatchObject({
    payloadCount: fixture.payloadCount,
    payloadTextLengths: fixture.lengths,
    finalVisibleTextLength: 0,
    finalRawTextLength: 17,
  });
  expect(message).not.toContain("private reasoning");
});

it("reports silent completion flags without retaining agent content", () => {
  const { diagnostic } = rejectedDiagnostic({
    payloads: [],
    meta: {
      ...meta,
      terminalReplyKind: "silent-empty",
      stopReason: "stop",
      livenessState: "blocked",
      yielded: true,
      continuationPending: false,
      completion: { refusal: true },
      pendingToolCalls: [{ arguments: "private arguments" }],
    },
  });
  expect(diagnostic).toMatchObject({
    terminalReplyKind: "silent-empty",
    stopReason: "stop",
    livenessState: "blocked",
    aborted: false,
    yielded: true,
    continuationPending: false,
    refusal: true,
    pendingToolCallCount: 1,
  });
  expect(JSON.stringify(diagnostic)).not.toContain("private arguments");
});

it("bounds OpenClaw diagnostics and excludes unknown metadata and echoed secrets", () => {
  const secret = "fixture-private-value";
  const echo = `Reply with exactly one word: PONG ${secret}`;
  const { message, diagnostic } = rejectedDiagnostic({
    payloads: Array.from({ length: 100 }, () => ({ text: echo, mediaUrl: secret })),
    meta: {
      ...meta,
      stopReason: secret,
      terminalReplyKind: secret,
      livenessState: secret,
      yielded: secret,
      finalAssistantVisibleText: secret,
      finalAssistantRawText: secret.repeat(100),
      finalPromptText: secret,
      systemPromptReport: { prompt: secret },
      toolSummary: secret,
      completion: { refusal: secret, finishReason: secret },
      pendingToolCalls: [{ name: secret, arguments: secret }],
      credentials: { apiKey: secret },
    },
  });
  expect(message).toContain("no assistant answer");
  expect(message).not.toContain(secret);
  expect(message).not.toContain("Reply with exactly one word");
  expect(message.length).toBeLessThan(2048);
  expect(diagnostic).toMatchObject({
    payloadCount: 100,
    sampledPayloadCount: 32,
    stopReason: "other",
    terminalReplyKind: "other",
    livenessState: "other",
    yielded: null,
    refusal: null,
  });
  expect(diagnostic.payloadTextLengths).toEqual(Array(32).fill(echo.length));
});

it.each(["tool_calls", "end_turn"])(
  "retains the pinned OpenClaw %s completion category without accepting an empty answer",
  (stopReason) => {
    const { message, diagnostic } = rejectedDiagnostic({
      payloads: [],
      meta: { ...meta, stopReason, livenessState: "paused" },
    });
    expect(message).toContain("no assistant answer");
    expect(diagnostic).toMatchObject({ stopReason, livenessState: "paused" });
  },
);

it("retains OpenClaw route rejection when diagnostic fields are malformed", () => {
  const { message, diagnostic } = rejectedDiagnostic({
    payloads: [{ text: "PONG" }],
    meta: { ...meta, aborted: true, finalAssistantRawText: { secret: "private" } },
  });
  expect(message).toContain("did not complete through its configured local model");
  expect(diagnostic).toMatchObject({ aborted: true, finalRawTextLength: null });
  expect(message).not.toContain("private");
});
