// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assertLocalInferenceAgentResponse,
  localInferenceAgentCommand,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";

const IMAGE = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"a".repeat(64)}`;
const VALID_SANDBOX = "managed-openclaw";

describe("protected local inference agent response", () => {
  it.each([
    { response: "", expected: 'response=""' },
    {
      response: "Reply with exactly one word: PONG",
      expected: 'response="Reply with exactly one word: PONG"',
    },
    {
      response: "Reply with exactly one word: PONG fixture-private-value",
      expected: 'response="Reply with exactly one word: PONG <REDACTED>"',
    },
    {
      response: `Reply with exactly one word: PONG ${"x".repeat(600)}`,
      expected: `response="Reply with exactly one word: PONG ${"x".repeat(478)}"`,
    },
  ])("reports bounded, redacted rejected output [%#]", ({ response, expected }) => {
    expect(() =>
      assertLocalInferenceAgentResponse(
        {
          agent: "hermes",
          image: IMAGE,
          sandbox: VALID_SANDBOX,
          localProvider: "ollama",
          model: "fixture-model",
        },
        response,
        true,
        { NVIDIA_API_KEY: "fixture-private-value" },
      ),
    ).toThrow(expected);
  });
  const openclaw = {
    status: "ok",
    result: {
      meta: { aborted: false, agentMeta: { provider: "inference", model: "fixture-model" } },
      payloads: [{ text: "PONG" }],
    },
  };
  const dcode = { data: { status: "success", exit_code: 0, response: "PONG" } };
  const input = (agent: "openclaw" | "hermes" | "langchain-deepagents-code") => ({
    agent,
    image: IMAGE,
    sandbox: VALID_SANDBOX,
    localProvider: "ollama" as const,
    model: "fixture-model",
  });

  it.each([
    ["openclaw", JSON.stringify(openclaw), "openclaw"],
    ["hermes", "PONG\n", "hermes"],
    ["langchain-deepagents-code", JSON.stringify(dcode), "dcode"],
  ] as const)(
    "uses %s's configured route and accepts its assistant response",
    (agent, stdout, binary) => {
      const command = localInferenceAgentCommand(input(agent));
      expect(command[0]).toBe(binary);
      expect(command).not.toContain("--model");
      expect(command).not.toContain("--provider");
      expect(() => assertLocalInferenceAgentResponse(input(agent), stdout, true)).not.toThrow();
    },
  );

  it.each([
    [
      "openclaw",
      JSON.stringify({ ...openclaw, result: { ...openclaw.result, payloads: [{ text: "LONG" }] } }),
    ],
    ["hermes", "PING localhost completed successfully.\n"],
    ["langchain-deepagents-code", JSON.stringify({ data: { ...dcode.data, response: "LONG" } })],
  ] as const)("accepts a completed %s turn when its answer differs from PONG", (agent, stdout) => {
    expect(() => assertLocalInferenceAgentResponse(input(agent), stdout, true)).not.toThrow();
  });

  it.each(["hermes", "langchain-deepagents-code"] as const)(
    "rejects a nonempty %s diagnostic without a completed local-model request",
    (agent) => {
      const diagnostic =
        agent === "hermes"
          ? "PING localhost completed successfully.\n"
          : JSON.stringify({
              data: { ...dcode.data, response: "PING localhost completed successfully." },
            });
      expect(() => assertLocalInferenceAgentResponse(input(agent), diagnostic, false)).toThrow(
        "did not complete a request through its configured local model",
      );
    },
  );

  it.each([
    [
      "openclaw",
      JSON.stringify({ ...openclaw, result: { ...openclaw.result, payloads: [], prompt: "PONG" } }),
    ],
    ["hermes", "request failed; prompt was Reply with exactly one word: PONG"],
    [
      "langchain-deepagents-code",
      JSON.stringify({ data: { ...dcode.data, response: "", prompt: "PONG" } }),
    ],
    [
      "langchain-deepagents-code",
      JSON.stringify({ data: { ...dcode.data, status: "turn_limit" } }),
    ],
    ["langchain-deepagents-code", JSON.stringify({ data: { ...dcode.data, exit_code: 1 } })],
    ["openclaw", "not JSON"],
    ["langchain-deepagents-code", "null"],
  ] as const)("rejects %s diagnostics or an incomplete turn", (agent, stdout) => {
    expect(() => assertLocalInferenceAgentResponse(input(agent), stdout, true)).toThrow();
  });

  it.each([
    ["aborted", { ...openclaw.result.meta, aborted: true }],
    [
      "wrong provider",
      { ...openclaw.result.meta, agentMeta: { provider: "nvidia", model: "fixture-model" } },
    ],
    [
      "wrong model",
      { ...openclaw.result.meta, agentMeta: { provider: "inference", model: "other-model" } },
    ],
  ])("rejects an OpenClaw %s result even when its text is PONG", (_reason, meta) => {
    expect(() =>
      assertLocalInferenceAgentResponse(
        input("openclaw"),
        JSON.stringify({
          ...openclaw,
          result: { ...openclaw.result, meta },
        }),
        true,
      ),
    ).toThrow("configured local model");
  });

  const meta = openclaw.result.meta;

  function rejectedDiagnostic(result: unknown) {
    let failure: unknown;
    try {
      assertLocalInferenceAgentResponse(
        input("openclaw"),
        JSON.stringify({ status: "ok", result }),
        true,
      );
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

  it("reports known silent completion and pending tools without retaining agent content", () => {
    const { diagnostic } = rejectedDiagnostic({
      payloads: [],
      meta: {
        ...meta,
        terminalReplyKind: "silent-empty",
        stopReason: "stop",
        livenessState: "blocked",
        yielded: true,
        continuationPending: true,
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
      continuationPending: true,
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

  it.each([
    ["tool_calls", "abandoned"],
    ["end_turn", "paused"],
  ])(
    "retains nested OpenClaw %s completion and %s liveness without accepting an empty answer",
    (stopReason, livenessState) => {
      const { message, diagnostic } = rejectedDiagnostic({
        payloads: [],
        meta: { ...meta, completion: { stopReason }, livenessState },
      });
      expect(message).toContain("no assistant answer");
      expect(diagnostic).toMatchObject({ stopReason, livenessState });
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
});
