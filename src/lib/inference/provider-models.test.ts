// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  expectTrustedConfig,
  readAuthConfigContents,
} from "../adapters/http/auth-config-test-helpers";
import {
  BUILD_ENDPOINT_URL,
  GEMINI_MODEL_CATALOG_MAX_PAGES,
  GEMINI_NATIVE_MODELS_ENDPOINT_URL,
  fetchGeminiModels,
  fetchAnthropicModels,
  fetchNvidiaEndpointModels,
  fetchOpenAiLikeModels,
  validateAnthropicModel,
  validateNvidiaEndpointModel,
  validateOpenAiLikeModel,
} from "./provider-models";

describe("provider model helpers", () => {
  it("fetches NVIDIA endpoint model ids through a 0600 curl config tmpfile so no API key reaches argv", () => {
    const result = fetchNvidiaEndpointModels("nvapi-x", {
      runCurlProbeImpl: (argv, opts) => {
        expect(argv.at(-1)).toBe(`${BUILD_ENDPOINT_URL}/models`);
        expect(argv.join(" ")).not.toContain("nvapi-x");
        expect(argv.join(" ")).not.toContain("Authorization:");
        const contents = readAuthConfigContents(argv);
        expect(contents).toContain('header = "Authorization: Bearer nvapi-x"');
        expectTrustedConfig(argv, opts);
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

  it("fetches Gemini model ids through the native catalog without leaking the API key into argv (#6975)", () => {
    const result = fetchGeminiModels("AIzaFakeKey123", {
      runCurlProbeImpl: (argv, opts) => {
        expect(argv.at(-1)).toBe(GEMINI_NATIVE_MODELS_ENDPOINT_URL);
        expect(argv.join(" ")).not.toContain("AIzaFakeKey123");
        expect(argv.join(" ")).not.toContain("x-goog-api-key:");
        const contents = readAuthConfigContents(argv);
        expect(contents).toContain('header = "x-goog-api-key: AIzaFakeKey123"');
        expectTrustedConfig(argv, opts);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({
            models: [
              {
                name: "models/gemini-2.5-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            ],
          }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({
      ok: true,
      ids: [
        "models/gemini-2.5-flash",
        "gemini-2.5-flash",
        "models/gemini-2.5-pro",
        "gemini-2.5-pro",
      ],
    });
  });

  it("validates Gemini endpoint model ids with or without Google's models/ catalog prefix (#6975)", () => {
    const response = {
      ok: true,
      httpStatus: 200,
      curlStatus: 0,
      body: JSON.stringify({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      }),
      stderr: "",
      message: "",
    };

    expect(
      validateOpenAiLikeModel(
        "Google Gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "gemini-2.5-flash",
        "AIzaFakeKey123",
        {
          runCurlProbeImpl: () => response,
        },
      ),
    ).toEqual({ ok: true, validated: true });

    expect(
      validateOpenAiLikeModel(
        "Google Gemini",
        "https://generativelanguage.googleapis.com/v1beta/openai/",
        "models/gemini-2.5-flash",
        "AIzaFakeKey123",
        {
          runCurlProbeImpl: () => response,
        },
      ),
    ).toEqual({ ok: true, validated: true });
  });

  it("validates Gemini endpoint model ids from later native catalog pages (#6975)", () => {
    const requestedUrls: string[] = [];
    const responses = [
      {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          models: [null, { name: "models/gemini-2.5-flash" }],
          nextPageToken: "page-2",
        }),
        stderr: "",
        message: "",
      },
      {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          models: [
            null,
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          ],
        }),
        stderr: "",
        message: "",
      },
    ];

    const result = validateOpenAiLikeModel(
      "Google Gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "gemini-2.5-pro",
      "AIzaFakeKey123",
      {
        runCurlProbeImpl: (argv) => {
          const url = argv.at(-1) ?? "";
          requestedUrls.push(url);
          return responses[requestedUrls.length - 1] ?? responses[responses.length - 1];
        },
      },
    );

    expect(result).toEqual({ ok: true, validated: true });
    expect(requestedUrls).toEqual([
      GEMINI_NATIVE_MODELS_ENDPOINT_URL,
      `${GEMINI_NATIVE_MODELS_ENDPOINT_URL}?pageToken=page-2`,
    ]);
  });

  it("fails Gemini native catalog pagination when page tokens repeat (#6975)", () => {
    const responses = [
      {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ models: [], nextPageToken: "same-page" }),
        stderr: "",
        message: "",
      },
      {
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({ models: [], nextPageToken: "same-page" }),
        stderr: "",
        message: "",
      },
    ];
    let callIndex = 0;

    const result = fetchGeminiModels("AIzaFakeKey123", {
      runCurlProbeImpl: () => responses[callIndex++] ?? responses[responses.length - 1],
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      message: "Gemini model catalog pagination repeated page token 'same-page'",
    });
  });

  it("omits Gemini native catalog entries that cannot generate content (#6975)", () => {
    const result = fetchGeminiModels("AIzaFakeKey123", {
      runCurlProbeImpl: () => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: JSON.stringify({
          models: [
            { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
            {
              name: "models/gemini-2.5-flash",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
        stderr: "",
        message: "",
      }),
    });

    expect(result).toEqual({
      ok: true,
      ids: ["models/gemini-2.5-flash", "gemini-2.5-flash"],
    });
  });

  it("fails Gemini native catalog pagination after the bounded page budget (#6975)", () => {
    const requestedUrls: string[] = [];

    const result = fetchGeminiModels("AIzaFakeKey123", {
      runCurlProbeImpl: (argv) => {
        requestedUrls.push(argv.at(-1) ?? "");
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ models: [], nextPageToken: `page-${requestedUrls.length}` }),
          stderr: "",
          message: "",
        };
      },
    });

    expect(result).toEqual({
      ok: false,
      httpStatus: 200,
      curlStatus: 0,
      message: `Gemini model catalog pagination exceeded ${GEMINI_MODEL_CATALOG_MAX_PAGES} pages`,
    });
    expect(requestedUrls).toHaveLength(GEMINI_MODEL_CATALOG_MAX_PAGES);
  });

  it("preserves Gemini endpoint native catalog validation failures (#6975)", () => {
    const result = validateOpenAiLikeModel(
      "Google Gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "gemini-2.5-flash",
      "AIzaFakeKey123",
      {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 429,
          curlStatus: 7,
          body: "",
          stderr: "rate limited",
          message: "rate limited",
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      httpStatus: 429,
      curlStatus: 7,
      message: `Could not validate model against ${GEMINI_NATIVE_MODELS_ENDPOINT_URL}: rate limited`,
    });
  });

  it("does not route unparsable endpoint strings through Gemini native validation (#6975)", () => {
    const result = validateOpenAiLikeModel(
      "Example",
      "not a url with generativelanguage.googleapis.com",
      "example-model",
      "sk-test",
      {
        runCurlProbeImpl: (argv) => {
          expect(argv.at(-1)).toBe("not a url with generativelanguage.googleapis.com/models");
          return {
            ok: true,
            httpStatus: 200,
            curlStatus: 0,
            body: JSON.stringify({ data: [{ id: "example-model" }] }),
            stderr: "",
            message: "",
          };
        },
      },
    );

    expect(result).toEqual({ ok: true, validated: true });
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
    const result = validateOpenAiLikeModel(
      "Example",
      "https://example.test/v1",
      "gpt-4.1",
      "sk-x",
      {
        runCurlProbeImpl: () => ({
          ok: false,
          httpStatus: 429,
          curlStatus: 0,
          body: "",
          stderr: "",
          message: "rate limited",
        }),
      },
    );

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

  it("routes a query-param API key through curl --config instead of the URL", () => {
    const result = fetchOpenAiLikeModels(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "AIzaFakeKey123",
      {
        authMode: "query-param",
        runCurlProbeImpl: (argv, opts) => {
          const url = argv.at(-1);
          expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
          expect(argv.join(" ")).not.toContain("AIzaFakeKey123");
          expect(argv.join(" ")).not.toContain("Authorization:");
          const contents = readAuthConfigContents(argv);
          expect(contents).toContain('url-query = "key=AIzaFakeKey123"');
          expectTrustedConfig(argv, opts);
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

  it("routes the Bearer API key through curl --config instead of the argv header", () => {
    fetchOpenAiLikeModels("https://api.openai.com/v1", "sk-test", {
      runCurlProbeImpl: (argv, opts) => {
        const url = argv.at(-1);
        expect(url).toBe("https://api.openai.com/v1/models");
        expect(url).not.toContain("?key=");
        expect(argv.join(" ")).not.toContain("sk-test");
        expect(argv.join(" ")).not.toContain("Authorization:");
        const contents = readAuthConfigContents(argv);
        expect(contents).toContain('header = "Authorization: Bearer sk-test"');
        expectTrustedConfig(argv, opts);
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

  it("routes OpenAI-compatible extra headers through curl --config instead of argv (#5826)", () => {
    fetchOpenAiLikeModels("https://openrouter.ai/api/v1", "sk-or-test", {
      extraHeaders: [
        "HTTP-Referer: https://www.nvidia.com/nemoclaw/",
        "X-OpenRouter-Title: NVIDIA NemoClaw",
      ],
      runCurlProbeImpl: (argv, opts) => {
        expect(argv.at(-1)).toBe("https://openrouter.ai/api/v1/models");
        expect(argv.join(" ")).not.toContain("sk-or-test");
        expect(argv.join(" ")).not.toContain("HTTP-Referer:");
        expect(argv.join(" ")).not.toContain("X-OpenRouter-Title:");
        const contents = readAuthConfigContents(argv);
        expect(contents).toContain('header = "Authorization: Bearer sk-or-test"');
        expect(contents).toContain('header = "HTTP-Referer: https://www.nvidia.com/nemoclaw/"');
        expect(contents).toContain('header = "X-OpenRouter-Title: NVIDIA NemoClaw"');
        expectTrustedConfig(argv, opts);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ data: [{ id: "moonshotai/kimi-k2.6" }] }),
          stderr: "",
          message: "",
        };
      },
    });
  });

  it("validates query-param OpenAI-like models without leaking the API key into argv (#6975)", () => {
    const result = validateOpenAiLikeModel(
      "Query Param Provider",
      "https://query-param.example.test/v1/",
      "gemini-2.5-flash",
      "AIzaFakeKey123",
      {
        authMode: "query-param",
        runCurlProbeImpl: (argv, opts) => {
          const url = argv.at(-1);
          expect(url).not.toContain("?key=");
          expect(url).not.toContain("AIzaFakeKey123");
          expect(argv.join(" ")).not.toContain("AIzaFakeKey123");
          expect(argv.join(" ")).not.toContain("Authorization:");
          const contents = readAuthConfigContents(argv);
          expect(contents).toContain('url-query = "key=AIzaFakeKey123"');
          expectTrustedConfig(argv, opts);
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

  it("routes the Anthropic x-api-key header through curl --config instead of argv", () => {
    fetchAnthropicModels("https://api.anthropic.com", "sk-ant-secret", {
      runCurlProbeImpl: (argv, opts) => {
        expect(argv.at(-1)).toBe("https://api.anthropic.com/v1/models");
        expect(argv.join(" ")).not.toContain("sk-ant-secret");
        expect(argv.join(" ")).not.toContain("x-api-key:");
        const contents = readAuthConfigContents(argv);
        expect(contents).toContain('header = "x-api-key: sk-ant-secret"');
        expectTrustedConfig(argv, opts);
        return {
          ok: true,
          httpStatus: 200,
          curlStatus: 0,
          body: JSON.stringify({ data: [{ id: "claude-sonnet" }] }),
          stderr: "",
          message: "",
        };
      },
    });
  });

  it("returns a structured failure shape when temp-file auth config creation throws", () => {
    const restoreMkdtemp = stubFsMkdtempToThrow();
    try {
      const result = fetchNvidiaEndpointModels("nvapi-x");
      expect(result).toMatchObject({
        ok: false,
        httpStatus: 0,
        curlStatus: 0,
        message: expect.stringMatching(/mkdtemp/i),
      });
    } finally {
      restoreMkdtemp();
    }
  });

  it("returns a structured failure shape when auth config creation fails for fetchOpenAiLikeModels", () => {
    const restoreMkdtemp = stubFsMkdtempToThrow();
    try {
      const result = fetchOpenAiLikeModels("https://example.test/v1", "sk-x");
      expect(result).toMatchObject({
        ok: false,
        httpStatus: 0,
        curlStatus: 0,
        message: expect.stringMatching(/mkdtemp/i),
      });
    } finally {
      restoreMkdtemp();
    }
  });
});

function stubFsMkdtempToThrow(): () => void {
  // Force mkdtempSync to fail so the auth-config setup boundary in
  // provider-models.ts has to convert the error into a structured probe
  // failure (PR #5975 review note PRA-2).
  const fs = require("node:fs") as typeof import("node:fs");
  const original = fs.mkdtempSync;
  fs.mkdtempSync = ((_prefix: string) => {
    throw new Error("simulated mkdtemp failure");
  }) as typeof fs.mkdtempSync;
  return () => {
    fs.mkdtempSync = original;
  };
}
