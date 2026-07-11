// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it } from "vitest";
import { probeOpenAiLikeEndpointWithValidationSession } from "./openai-validation-session";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";

const listen = useOpenAiValidationTestServers();

describe("OpenAI validation authentication and headers", () => {
  it("keeps query-parameter authentication out of request headers", async () => {
    let observedUrl = "";
    let observedAuthorization: string | undefined;
    const server = http.createServer((request, response) => {
      observedUrl = request.url ?? "";
      observedAuthorization = request.headers.authorization;
      request.resume();
      response.end('{"choices":[{"message":{"content":"OK"}}]}');
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "query-secret",
      { authMode: "query-param", skipResponsesProbe: true },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedAuthorization).toBeUndefined();
    expect(new URL(observedUrl, "http://provider.example.test").searchParams.get("key")).toBe(
      "query-secret",
    );
  });

  it("preserves provider extra headers on the native validation request", async () => {
    let observedReferer: string | undefined;
    let observedTitle: string | undefined;
    const server = http.createServer((request, response) => {
      observedReferer = request.headers["http-referer"] as string | undefined;
      observedTitle = request.headers["x-openrouter-title"] as string | undefined;
      request.resume();
      response.end('{"choices":[{"message":{"content":"OK"}}]}');
    });
    const port = await listen(server);
    const harness = createOpenAiValidationTestDeps();

    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "test-key",
      {
        skipResponsesProbe: true,
        extraHeaders: [
          "HTTP-Referer: https://github.com/NVIDIA/NemoClaw",
          "X-OpenRouter-Title: NemoClaw",
        ],
      },
      harness,
    );

    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(observedReferer).toBe("https://github.com/NVIDIA/NemoClaw");
    expect(observedTitle).toBe("NemoClaw");
    expect(harness.legacyProbe).not.toHaveBeenCalled();
  });
});
