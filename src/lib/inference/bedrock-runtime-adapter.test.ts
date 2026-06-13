// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __test,
  buildBedrockConverseRequest,
  createBedrockRuntimeAdapterServer,
  createOpenAiChatCompletion,
  streamOpenAiChatCompletion,
} from "../../../dist/lib/inference/bedrock-runtime-adapter";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

function listen(server: http.Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("Bedrock Runtime OpenAI adapter", () => {
  it("converts text chat completions to Converse and back", async () => {
    const send = vi.fn(async (command: any) => {
      expect(command.constructor.name).toBe("ConverseCommand");
      expect(command.input).toMatchObject({
        modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: [{ text: "hello" }] }],
        inferenceConfig: { temperature: 0.2, maxTokens: 128 },
      });
      return {
        output: { message: { content: [{ text: "OK" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    });

    const response = await createOpenAiChatCompletion(
      {
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
        max_tokens: 128,
      },
      { send },
    );

    expect(response.choices[0].message.content).toBe("OK");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it("streams text deltas as OpenAI chat completion chunks", async () => {
    async function* stream() {
      yield { messageStart: { role: "assistant" } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hel" } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } };
      yield { messageStop: { stopReason: "end_turn" } };
    }
    const send = vi.fn(async (command: any) => {
      expect(command.constructor.name).toBe("ConverseStreamCommand");
      return { stream: stream() };
    });

    const chunks: any[] = [];
    for await (const chunk of await streamOpenAiChatCompletion(
      {
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      { send },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk: any) => chunk.choices[0].delta.content).filter(Boolean)).toEqual([
      "hel",
      "lo",
    ]);
    expect(new Set(chunks.map((chunk: any) => chunk.id)).size).toBe(1);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
  });

  it("marks streamed tool calls with the tool_calls finish reason", async () => {
    async function* stream() {
      yield {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "toolu_stream", name: "get_weather" } },
        },
      };
      yield {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { toolUse: { input: '{"city":"Seattle"}' } },
        },
      };
      yield { messageStop: { stopReason: "end_turn" } };
    }
    const send = vi.fn(async () => ({ stream: stream() }));

    const chunks: any[] = [];
    for await (const chunk of await streamOpenAiChatCompletion(
      {
        model: "anthropic.claude-3-haiku-20240307-v1:0",
        stream: true,
        messages: [{ role: "user", content: "weather" }],
      },
      { send },
    )) {
      chunks.push(chunk);
    }

    expect(
      chunks.find((chunk) => chunk.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls,
    ).toEqual([
      {
        index: 0,
        id: "toolu_stream",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("tool_calls");
  });

  it("round-trips tool calls and tool results", async () => {
    const input = buildBedrockConverseRequest({
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      messages: [
        { role: "user", content: "weather" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Seattle"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_1", content: '{"temperature":55}' },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    });

    expect(input.messages?.[1]?.content?.[0]).toEqual({
      toolUse: { toolUseId: "toolu_1", name: "get_weather", input: { city: "Seattle" } },
    });
    expect(input.messages?.[2]?.content?.[0]).toEqual({
      toolResult: { toolUseId: "toolu_1", content: [{ json: { temperature: 55 } }] },
    });
    expect(input.toolConfig?.tools?.[0]).toMatchObject({
      toolSpec: { name: "get_weather" },
    });

    const response = await createOpenAiChatCompletion(
      { model: "anthropic.claude", messages: [{ role: "user", content: "weather" }] },
      {
        send: vi.fn(async () => ({
          output: {
            message: {
              content: [
                {
                  toolUse: {
                    toolUseId: "toolu_2",
                    name: "get_weather",
                    input: { city: "Portland" },
                  },
                },
              ],
            },
          },
          stopReason: "tool_use",
        })),
      },
    );
    expect(response.choices[0].message.tool_calls).toEqual([
      {
        id: "toolu_2",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Portland"}' },
      },
    ]);
    expect(response.choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns a clear 400 for unsupported OpenAI request fields", async () => {
    const server = createBedrockRuntimeAdapterServer({
      token: "local-token",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      client: { send: vi.fn() },
    });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic.claude",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "json_object" },
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error.message).toContain("Unsupported OpenAI chat field");
  });

  it("tolerates OpenAI stream_options metadata from compatible clients", async () => {
    const response = await createOpenAiChatCompletion(
      {
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        messages: [{ role: "user", content: "hello" }],
        stream_options: { include_usage: true },
      },
      {
        send: vi.fn(async () => ({
          output: { message: { content: [{ text: "OK" }] } },
          stopReason: "end_turn",
        })),
      },
    );

    expect(response.choices[0].message.content).toBe("OK");
  });

  it("exposes loopback health without leaking or requiring the adapter bearer token", async () => {
    const server = createBedrockRuntimeAdapterServer({
      token: "local-token",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      client: { send: vi.fn() },
    });
    const baseUrl = await listen(server);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain("local-token");

    const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic.claude",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(chat.status).toBe(401);
  });

  it("emits safe request breadcrumbs without tokens or upstream hostnames", async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const server = createBedrockRuntimeAdapterServer({
      token: "local-token",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      logger: (event, fields) => events.push({ event, fields }),
      client: {
        send: vi.fn(async () => ({
          output: { message: { content: [{ text: "OK" }] } },
          stopReason: "end_turn",
        })),
      },
    });
    const baseUrl = await listen(server);

    const unauthorized = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic.claude",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic.claude",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "request_rejected",
          fields: expect.objectContaining({ status: 401, reason: "unauthorized" }),
        }),
        expect.objectContaining({
          event: "request_completed",
          fields: expect.objectContaining({
            operation: "converse",
            model: "anthropic.claude",
            status: 200,
          }),
        }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("local-token");
    expect(serialized).not.toContain("bedrock-runtime.us-east-1.amazonaws.com");
    expect(serialized).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("maps Bedrock auth and region failures to adapter errors", async () => {
    const server = createBedrockRuntimeAdapterServer({
      token: "local-token",
      endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      client: {
        send: vi.fn(async () => {
          throw new Error("Could not load credentials from any providers");
        }),
      },
    });
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "anthropic.claude",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as any;
    expect(body.error.message).toContain("Could not load credentials");
  });

  it("includes forwarded AWS environment in the adapter reuse hash", () => {
    const savedContainerCredentials = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const savedSharedCredentials = process.env.AWS_SHARED_CREDENTIALS_FILE;
    try {
      delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      const base = __test.adapterCredentialHash({
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        region: "us-east-1",
        compatibleCredential: null,
      });

      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "/v2/credentials/old";
      const withContainerCredentials = __test.adapterCredentialHash({
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        region: "us-east-1",
        compatibleCredential: null,
      });

      process.env.AWS_SHARED_CREDENTIALS_FILE = "/tmp/bedrock-credentials";
      const withSharedCredentialsFile = __test.adapterCredentialHash({
        endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        region: "us-east-1",
        compatibleCredential: null,
      });

      expect(withContainerCredentials).not.toBe(base);
      expect(withSharedCredentialsFile).not.toBe(withContainerCredentials);
    } finally {
      if (savedContainerCredentials === undefined) {
        delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
      } else {
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = savedContainerCredentials;
      }
      if (savedSharedCredentials === undefined) {
        delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      } else {
        process.env.AWS_SHARED_CREDENTIALS_FILE = savedSharedCredentials;
      }
    }
  });
});
