// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildFullE2eInferenceRequest,
  type FullE2eInferenceAttemptInput,
  fullE2eInferenceProbeEvidence,
  type InferenceCommandResult,
  parseFullE2eInferenceResponse,
  runFullE2eInferenceProbe,
} from "../live/full-e2e-inference-probe.ts";

function commandResult(stdout: string, exitCode = 0, stderr = ""): InferenceCommandResult {
  return { exitCode, stderr, stdout };
}

function completion(content: string, finishReason = "stop"): string {
  return JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
    model: "nvidia/nvidia/nemotron-3-ultra",
    usage: { completion_tokens: 1, prompt_tokens: 20, total_tokens: 21 },
  });
}

describe("full E2E sandbox inference probe", () => {
  it("uses deterministic sampling and the requested reply budget for Nemotron", () => {
    expect(JSON.parse(buildFullE2eInferenceRequest("nvidia/nvidia/nemotron-3-ultra", 512))).toEqual(
      {
        model: "nvidia/nvidia/nemotron-3-ultra",
        messages: [
          {
            role: "user",
            content: "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
          },
        ],
        temperature: 0,
        max_tokens: 512,
        stream: false,
      },
    );
  });

  it("uses the compatible reply-budget field for models that reject max_tokens", () => {
    const request = JSON.parse(buildFullE2eInferenceRequest("gpt-5.4", 512));

    expect(request).toMatchObject({ max_completion_tokens: 512, stream: false });
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("temperature");
  });

  it("preserves response metadata and prefers final content over reasoning", () => {
    const response = parseFullE2eInferenceResponse(
      JSON.stringify({
        choices: [
          {
            finish_reason: "length",
            message: { content: "The", reasoning_content: "6 multiplied by 7 is 42" },
          },
        ],
        model: "nvidia/nvidia/nemotron-3-ultra",
        usage: { completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 511 } },
      }),
    );

    expect(response).toEqual({
      answer: "The",
      content: "The",
      finishReason: "length",
      model: "nvidia/nvidia/nemotron-3-ultra",
      reasoningContent: "6 multiplied by 7 is 42",
      usage: { completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 511 } },
    });
  });

  it("falls back to reasoning content when final content is empty", () => {
    const response = parseFullE2eInferenceResponse(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { reasoning_content: "42" } }],
      }),
    );

    expect(response.answer).toBe("42");
    expect(response.content).toBe("");
    expect(response.reasoningContent).toBe("42");
  });

  it("retries only a successful semantic mismatch with a larger reply budget", async () => {
    const requests: FullE2eInferenceAttemptInput[] = [];
    const probe = await runFullE2eInferenceProbe(
      "nvidia/nvidia/nemotron-3-ultra",
      async (input) => {
        requests.push(input);
        return commandResult(input.attempt === 1 ? completion("The") : completion("42"));
      },
    );

    expect(probe.outcome).toBe("passed");
    expect(requests.map(({ attempt, maxTokens }) => ({ attempt, maxTokens }))).toEqual([
      { attempt: 1, maxTokens: 512 },
      { attempt: 2, maxTokens: 1024 },
    ]);
    expect(requests.map(({ artifactName }) => artifactName)).toEqual([
      "phase-4-sandbox-inference-local-attempt-01",
      "phase-4-sandbox-inference-local-attempt-02",
    ]);
    expect(JSON.parse(requests[1]!.requestBody)).toMatchObject({ max_tokens: 1024 });
    expect(fullE2eInferenceProbeEvidence(probe)).toMatchObject({
      outcome: "passed",
      attempts: [
        { answerMatched: false, response: { content: "The", finish_reason: "stop" } },
        { answerMatched: true, response: { content: "42", finish_reason: "stop" } },
      ],
    });
  });

  it("accepts the existing whitespace-tolerant 42 answer on the first attempt", async () => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return commandResult(completion("4\n2"));
    });

    expect(probe.outcome).toBe("passed");
    expect(calls).toBe(1);
  });

  it("does not retry command, HTTP, or transport failures", async () => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return commandResult("", 22, "curl: (22) HTTP 403");
    });

    expect(probe.outcome).toBe("command-failure");
    expect(calls).toBe(1);
  });

  it.each([
    ["invalid JSON", "not json", "invalid JSON"],
    ["a missing choice", JSON.stringify({}), "choices[0]"],
    [
      "a missing message",
      JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
      "choices[0].message",
    ],
  ])("does not retry %s", async (_case, stdout, expectedError) => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return commandResult(stdout);
    });

    expect(probe.outcome).toBe("response-failure");
    expect(probe.attempts[0]?.parseError).toContain(expectedError);
    expect(calls).toBe(1);
  });

  it("retries a structurally valid length-truncated response with no answer", async () => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return calls === 1
        ? commandResult(
            JSON.stringify({
              choices: [{ finish_reason: "length", message: { content: "" } }],
            }),
          )
        : commandResult(completion("42"));
    });

    expect(probe.outcome).toBe("passed");
    expect(calls).toBe(2);
  });

  it("does not retry a completed response with no answer", async () => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return commandResult(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }),
      );
    });

    expect(probe.outcome).toBe("response-failure");
    expect(probe.attempts[0]?.parseError).toContain("did not contain assistant content");
    expect(calls).toBe(1);
  });

  it("reports a bounded semantic mismatch when neither valid response contains 42", async () => {
    let calls = 0;
    const probe = await runFullE2eInferenceProbe("nvidia/nvidia/nemotron-3-ultra", async () => {
      calls += 1;
      return commandResult(completion("The answer is forty-two."));
    });

    expect(probe.outcome).toBe("semantic-mismatch");
    expect(calls).toBe(2);
  });
});
