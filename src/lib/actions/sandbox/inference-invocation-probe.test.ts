// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildSandboxInferenceInvocationCommand,
  probeSandboxInferenceInvocation,
} from "./inference-invocation-probe";

const input = {
  sandboxName: "dcode-workspace",
  provider: "compatible-endpoint",
  model: "nvidia/nemotron",
  preferredInferenceApi: "openai-completions",
};

describe("sandbox inference invocation probe", () => {
  it("probes the recorded model through inference.local without embedding a credential (#6195)", () => {
    const command = buildSandboxInferenceInvocationCommand(input);

    expect(command).toContain("https://inference.local/v1/chat/completions");
    expect(command).toContain('"model":"nvidia/nemotron"');
    expect(command).not.toMatch(/api[_-]?key|authorization|bearer/i);
    expect(command).not.toMatch(/curl\s+[^;]*-[^-\s]*k/);
    expect(command).not.toContain("head -c");
  });

  it("fails closed and redacts diagnostics when the stored gateway credential is rejected (#6195)", () => {
    const execute = vi.fn(() => ({
      status: 1,
      stdout: "401",
      stderr: "upstream authentication failed for sk-secret-value-that-is-long-enough",
    }));

    const result = probeSandboxInferenceInvocation(input, { execute });

    expect(result).toEqual({
      ok: false,
      detail: "sandbox inference invocation probe returned HTTP 401",
      httpStatus: 401,
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret-value-that-is-long-enough");
  });

  it("never reports an arbitrary response body from the failed route (#6195)", () => {
    const execute = vi.fn(() => ({
      status: 1,
      stdout: '500\n{"echoed_value":"canary-replay-marker"}',
      stderr: "upstream echoed canary-replay-marker",
    }));

    const result = probeSandboxInferenceInvocation(input, { execute });

    expect(result).toEqual({
      ok: false,
      detail: "sandbox inference invocation probe returned HTTP 500",
      httpStatus: 500,
    });
    expect(JSON.stringify(result)).not.toContain("canary-replay-marker");
  });

  it("accepts a successful completion through the stored gateway route (#6195)", () => {
    const execute = vi.fn(() => ({ status: 0, stdout: "200\n{}", stderr: "" }));

    expect(probeSandboxInferenceInvocation(input, { execute })).toEqual({ ok: true });
  });

  it("sends max_completion_tokens for a GPT-5 model on the chat completions route", () => {
    const command = buildSandboxInferenceInvocationCommand({ ...input, model: "gpt-5.4" });

    expect(command).toContain("https://inference.local/v1/chat/completions");
    expect(command).toContain('"max_completion_tokens":16');
    expect(command).not.toContain('"max_tokens"');
  });

  it("sends max_completion_tokens for an o-series model on the chat completions route", () => {
    const command = buildSandboxInferenceInvocationCommand({ ...input, model: "o3-mini" });

    expect(command).toContain('"max_completion_tokens":16');
    expect(command).not.toContain('"max_tokens"');
  });

  it("keeps max_tokens for a model that supports the legacy chat completions field", () => {
    const command = buildSandboxInferenceInvocationCommand({ ...input, model: "nvidia/nemotron" });

    expect(command).toContain('"max_tokens":16');
    expect(command).not.toContain('"max_completion_tokens"');
  });

  it("sends max_output_tokens on the responses route", () => {
    const command = buildSandboxInferenceInvocationCommand({
      ...input,
      preferredInferenceApi: "openai-responses",
    });

    expect(command).toContain("https://inference.local/v1/responses");
    expect(command).toContain('"max_output_tokens":16');
  });

  // A hosted endpoint validates the reply budget it is sent, so a budget below
  // its floor fails a route that normal inference serves. Every preflight route
  // must clear the floor, not just the one the reporter exercised (#7939).
  it.each([
    ["chat completions", "nvidia/nemotron", "openai-completions", "max_tokens"],
    ["chat completions reasoning", "gpt-5.4", "openai-completions", "max_completion_tokens"],
    ["responses", "nvidia/nemotron", "openai-responses", "max_output_tokens"],
    ["anthropic messages", "claude-sonnet-4-6", "anthropic-messages", "max_tokens"],
  ])("requests a reply budget the endpoint accepts on the %s route (#7939)", (_route, model, preferredInferenceApi, field) => {
    const endpointMinimumReplyTokens = 16;
    const command = buildSandboxInferenceInvocationCommand({
      ...input,
      model,
      preferredInferenceApi,
    });

    const budget = new RegExp(`"${field}":(\\d+)`).exec(command);

    expect(budget).not.toBeNull();
    expect(Number(budget?.[1])).toBeGreaterThanOrEqual(endpointMinimumReplyTokens);
  });
});
