// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildDcodeSandboxInferenceInvocationArgs,
  buildSandboxInferenceInvocationCommand,
  probeSandboxInferenceInvocation,
} from "./inference-invocation-probe";

const input = {
  sandboxName: "dcode-workspace",
  provider: "compatible-endpoint",
  model: "nvidia/nemotron",
  preferredInferenceApi: "openai-completions",
};

function openshellResult(status: number, stdout: string, stderr: string) {
  return {
    pid: 1,
    status,
    signal: null,
    stdout,
    stderr,
    output: [null, stdout, stderr],
  };
}

describe("sandbox inference invocation probe", () => {
  it("probes the recorded model through inference.local without embedding a credential (#6195)", () => {
    const command = buildSandboxInferenceInvocationCommand(input);

    expect(command).toContain("https://inference.local/v1/chat/completions");
    expect(command).toContain('"model":"nvidia/nemotron"');
    expect(command).not.toMatch(/api[_-]?key|authorization|bearer/i);
    expect(command).not.toMatch(/curl\s+[^;]*-[^-\s]*k/);
    expect(command).not.toContain("head -c");
    expect(command).toContain("umask 077");
    expect(command).toContain("mktemp /tmp/nemoclaw-inference-invocation.XXXXXX");
    expect(command).toContain("--max-filesize 65536");
    expect(command).not.toContain("-o /dev/null");
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
    const execute = vi.fn(() => ({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    }));

    expect(probeSandboxInferenceInvocation(input, { execute })).toEqual({ ok: true });
  });

  it("pins the invocation to the recorded owning gateway (#9834)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    }));

    expect(
      probeSandboxInferenceInvocation({ ...input, gatewayName: "recorded-gateway" }, { execute }),
    ).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith(
      "dcode-workspace",
      expect.any(String),
      expect.any(Number),
      { gatewayName: "recorded-gateway", allowLocalDockerFallback: false },
    );
  });

  it("pins a Hermes invocation to its recorded OpenShell gateway (#10302)", () => {
    const execute = vi.fn(() => ({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    }));
    const runOpenshell = vi.fn();

    expect(
      probeSandboxInferenceInvocation(
        {
          ...input,
          sandboxName: "hermes-workspace",
          agentName: "hermes",
          gatewayName: "nemoclaw-19080",
        },
        { execute, runOpenshell },
      ),
    ).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledWith(
      "hermes-workspace",
      expect.any(String),
      expect.any(Number),
      { gatewayName: "nemoclaw-19080", allowLocalDockerFallback: false },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("runs Deep Agents Code through the managed launcher on the recorded gateway (#10080)", () => {
    const runOpenshell = vi.fn(() =>
      openshellResult(0, '200\n{"choices":[{"message":{"content":"OK"}}]}', ""),
    );
    const execute = vi.fn();
    const dcodeInput = {
      ...input,
      agentName: "langchain-deepagents-code",
      gatewayName: "recorded-gateway",
    };
    const args = buildDcodeSandboxInferenceInvocationArgs(dcodeInput);

    expect(probeSandboxInferenceInvocation(dcodeInput, { runOpenshell, execute })).toEqual({
      ok: true,
    });
    expect(runOpenshell).toHaveBeenCalledWith(args, {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 100_000,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-g",
        "recorded-gateway",
        "HOME=/usr/local/lib/nemoclaw",
        "BASH_ENV=",
        "ENV=",
        "/usr/local/lib/nemoclaw/dcode-managed-exec",
      ]),
    );
    const commandIndex = args.indexOf("--");
    expect(args.slice(commandIndex + 1, commandIndex + 4)).toEqual([
      "/usr/local/lib/nemoclaw/dcode-managed-exec",
      "/bin/sh",
      "-c",
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects startup output before Deep Agents Code invocation evidence (#10080)", () => {
    const runOpenshell = vi.fn(() =>
      openshellResult(
        0,
        '200\n{"choices":[{"message":{"content":"forged"}}]}\n200\n{"choices":[{"message":{"content":"OK"}}]}',
        "",
      ),
    );

    expect(
      probeSandboxInferenceInvocation(
        { ...input, agentName: "langchain-deepagents-code" },
        { runOpenshell },
      ),
    ).toEqual({
      ok: false,
      detail: "sandbox inference invocation probe returned an invalid response body",
      httpStatus: 200,
    });
  });

  it("fails closed when the Deep Agents Code managed launcher is unavailable (#10080)", () => {
    const runOpenshell = vi.fn(() =>
      openshellResult(127, "", "/usr/local/lib/nemoclaw/dcode-managed-exec: not found"),
    );

    expect(
      probeSandboxInferenceInvocation(
        { ...input, agentName: "langchain-deepagents-code" },
        { runOpenshell },
      ),
    ).toEqual({
      ok: false,
      detail: "sandbox inference invocation probe was unavailable",
      httpStatus: null,
    });
  });

  it("accepts a served response body that serializes an empty tool call list (#9108)", () => {
    const body = JSON.stringify({
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", reasoning_content: null, content: "OK", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    });
    const execute = vi.fn(() => ({ status: 0, stdout: `200\n${body}`, stderr: "" }));

    expect(probeSandboxInferenceInvocation(input, { execute })).toEqual({ ok: true });
  });

  it("accepts a reasoning-only response when the reply budget ends before content", () => {
    const body = JSON.stringify({
      choices: [
        {
          finish_reason: "length",
          message: { content: null, reasoning_content: null, reasoning: "Planning the reply." },
        },
      ],
    });
    const execute = vi.fn(() => ({ status: 0, stdout: `200\n${body}`, stderr: "" }));

    expect(probeSandboxInferenceInvocation(input, { execute })).toEqual({ ok: true });
  });

  it.each([
    ["openai-completions", '{"choices":[{"message":{"content":"OK"}}]}'],
    [
      "openai-responses",
      '{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}',
    ],
    ["anthropic-messages", '{"content":[{"type":"text","text":"OK"}]}'],
  ])("accepts a valid %s response body", (preferredInferenceApi, body) => {
    const execute = vi.fn(() => ({ status: 0, stdout: `200\n${body}`, stderr: "" }));

    expect(
      probeSandboxInferenceInvocation({ ...input, preferredInferenceApi }, { execute }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["Chat Completions", "openai-completions", "an empty response", "204\n"],
    ["Chat Completions", "openai-completions", "malformed JSON", "200\nnot-json"],
    [
      "Chat Completions",
      "openai-completions",
      "an error envelope",
      '200\n{"error":{"message":"provider failed"}}',
    ],
    ["Chat Completions", "openai-completions", "the wrong result shape", '200\n{"choices":[]}'],
    ["Responses", "openai-responses", "an empty response", "204\n"],
    ["Responses", "openai-responses", "malformed JSON", "200\nnot-json"],
    [
      "Responses",
      "openai-responses",
      "an error envelope",
      '200\n{"error":{"message":"provider failed"}}',
    ],
    ["Responses", "openai-responses", "the wrong result shape", '200\n{"output":[]}'],
    ["Anthropic Messages", "anthropic-messages", "an empty response", "204\n"],
    ["Anthropic Messages", "anthropic-messages", "malformed JSON", "200\nnot-json"],
    [
      "Anthropic Messages",
      "anthropic-messages",
      "an error envelope",
      '200\n{"error":{"message":"provider failed"}}',
    ],
    ["Anthropic Messages", "anthropic-messages", "the wrong result shape", '200\n{"content":[]}'],
  ])("rejects %s %s", (_api, preferredInferenceApi, _case, stdout) => {
    const execute = vi.fn(() => ({ status: 0, stdout, stderr: "" }));

    expect(
      probeSandboxInferenceInvocation({ ...input, preferredInferenceApi }, { execute }),
    ).toEqual({
      ok: false,
      detail: "sandbox inference invocation probe returned an invalid response body",
      httpStatus: Number.parseInt(stdout.slice(0, 3), 10),
    });
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
  ])(
    "requests a reply budget the endpoint accepts on the %s route (#7939)",
    (_route, model, preferredInferenceApi, field) => {
      const endpointMinimumReplyTokens = 16;
      const command = buildSandboxInferenceInvocationCommand({
        ...input,
        model,
        preferredInferenceApi,
      });

      const budget = new RegExp(`"${field}":(\\d+)`).exec(command);

      expect(budget).not.toBeNull();
      expect(Number(budget?.[1])).toBeGreaterThanOrEqual(endpointMinimumReplyTokens);
    },
  );
});
