// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BUILD_ENDPOINT_URL,
  fetchAnthropicModels,
  fetchNvidiaEndpointModels,
  fetchOpenAiLikeModels,
  validateAnthropicModel,
  validateNvidiaEndpointModel,
  validateOpenAiLikeModel,
} from "../../dist/lib/provider-models";

describe("provider model helpers", () => {
  it("fetches NVIDIA endpoint model ids", () => {
    const result = fetchNvidiaEndpointModels("nvapi-x", {
      runCurlProbeImpl: (argv) => {
        expect(argv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/models`);
        expect(argv).toContain("Authorization: Bearer nvapi-x");
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ data: [{ id: "nemotron" }, { id: "llama" }] }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({ ok: true, ids: ["nemotron", "llama"] });
  });

  it("returns explicit validated=true for NVIDIA model matches", () => {
    const result = validateNvidiaEndpointModel("nemotron", "nvapi-x", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ data: [{ id: "nemotron" }] }),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({ ok: true, validated: true });
  });

  it("reports NVIDIA validation failures with the checked endpoint", () => {
    const result = validateNvidiaEndpointModel("missing", "nvapi-x", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ data: [{ id: "nemotron" }] }),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      message: `Model 'missing' is not available from NVIDIA Endpoints. Checked ${BUILD_ENDPOINT_URL}/models.`,
    });
  });

  it("fetches OpenAI-compatible model ids without an auth header when no key is provided", () => {
    const result = fetchOpenAiLikeModels("https://example.test/v1/", "", {
      runCurlProbeImpl: (argv) => {
        expect(argv.at(-1)).toBe("https://example.test/v1/models");
        expect(argv.join(" ")).not.toContain("Authorization: Bearer");
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ data: [{ id: "gpt-4.1" }] }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({ ok: true, ids: ["gpt-4.1"] });
  });

  it("treats unsupported /models endpoints as non-blocking validation gaps", () => {
    expect(
      validateOpenAiLikeModel("Example", "https://example.test/v1", "gpt-4.1", "sk-x", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 404,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "HTTP 404",
        }),
      }),
    ).toEqual({ ok: true, validated: false });

    expect(
      validateAnthropicModel("https://example.test", "claude-sonnet", "sk-ant-x", {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 405,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "HTTP 405",
        }),
      }),
    ).toEqual({ ok: true, validated: false });
  });

  it("preserves structured status fields through validation failures", () => {
    const result = validateOpenAiLikeModel("Example", "https://example.test/v1", "gpt-4.1", "sk-x", {
      runCurlProbeImpl: () => ({
        ok: false,
        httpStatus: 429,
        curlStatus: 0,
        body: "",
        stderr: "",
        message: "rate limited",
      }),
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 429,
      curlStatus: 0,
      message: "Could not validate model against https://example.test/v1/models: rate limited",
    });
  });

  it("accepts Anthropic model ids from either id or name fields", () => {
    const result = fetchAnthropicModels("https://example.test", "sk-ant-x", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ data: [{ name: "claude-sonnet-4-6" }, { id: "claude-haiku-4-5" }] }),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({ ok: true, ids: ["claude-sonnet-4-6", "claude-haiku-4-5"] });
  });

  it("preserves probe status when model catalog JSON parsing fails", () => {
    const result = fetchOpenAiLikeModels("https://example.test/v1", "sk-x", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 502,
        curlStatus: 7,
        body: "not-json",
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 502,
      curlStatus: 7,
      message: expect.stringMatching(/JSON|Unexpected token|not-json/i),
    });
  });

  it("fails fast when the model catalog payload omits the top-level data array", () => {
    const result = fetchOpenAiLikeModels("https://example.test/v1", "sk-x", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ error: { message: "bad payload" } }),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      message: "Unexpected model catalog response: expected a top-level data array",
    });
  });

  it("sends API key as ?key= query param when authMode is query-param (Gemini)", () => {
    const result = fetchOpenAiLikeModels(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "AIzaFakeKey123",
      {
        authMode: "query-param",
        runCurlProbeImpl: (argv) => {
          const url = argv.at(-1);
          expect(url).toBe(
            "https://generativelanguage.googleapis.com/v1beta/openai/models?key=AIzaFakeKey123",
          );
          expect(argv.join(" ")).not.toContain("Authorization: Bearer");
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }),
            stderr: "",
            message: "",
          };
        },
      },
    );

    expect(result).toEqual({ ok: true, ids: ["gemini-2.5-flash"] });
  });

  it("uses Bearer header by default even when an API key is provided", () => {
    fetchOpenAiLikeModels("https://api.openai.com/v1", "sk-test", {
      runCurlProbeImpl: (argv) => {
        const url = argv.at(-1);
        expect(url).toBe("https://api.openai.com/v1/models");
        expect(url).not.toContain("?key=");
        expect(argv).toContain("Authorization: Bearer sk-test");
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ data: [{ id: "gpt-4.1" }] }),
          stderr: "",
          message: "",
        };
      },
    });
  });

  it("validates Gemini models with query-param auth when authMode is passed through", () => {
    const result = validateOpenAiLikeModel(
      "Google Gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "gemini-2.5-flash",
      "AIzaFakeKey123",
      {
        authMode: "query-param",
        runCurlProbeImpl: (argv) => {
          const url = argv.at(-1);
          expect(url).toContain("?key=AIzaFakeKey123");
          expect(argv.join(" ")).not.toContain("Authorization: Bearer");
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }),
            stderr: "",
            message: "",
          };
        },
      },
    );

    expect(result).toEqual({ ok: true, validated: true });
  });
});
