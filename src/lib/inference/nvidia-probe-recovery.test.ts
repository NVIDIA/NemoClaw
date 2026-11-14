// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeOpenAiLikeEndpointWithValidationSession } from "./openai-validation-session";
import {
  createOpenAiValidationTestDeps,
  useOpenAiValidationTestServers,
} from "./openai-validation-session.test-helpers";
import {
  HARNESS_COUNTER,
  makeFakeCurlScript,
  withFakeCurlProbe,
} from "./onboard-probes-curl-harness";

const { probeOpenAiLikeEndpoint } = require("./onboard-probes");
const listen = useOpenAiValidationTestServers();

beforeEach(() => vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1"));

describe("NVIDIA Endpoints validation recovery", () => {
  it("recovers from HTTP 500 without changing the native request or resolving another address (#12603)", async () => {
    const requests: { authorization: string | undefined; url: string | undefined; body: string }[] =
      [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ authorization: request.headers.authorization, url: request.url, body });
        response.statusCode = requests.length === 1 ? 500 : 200;
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);
    const deps = createOpenAiValidationTestDeps();
    const result = await probeOpenAiLikeEndpointWithValidationSession(
      `http://provider.example.test:${port}/v1`,
      "test-model",
      "fixture-key",
      { provider: "nvidia-prod", skipResponsesProbe: true },
      deps,
    );
    expect(result).toMatchObject({ ok: true, api: "openai-completions" });
    expect(requests).toEqual(
      Array(2).fill({
        authorization: "Bearer fixture-key",
        url: "/v1/chat/completions",
        body: JSON.stringify({ model: "test-model", messages: [] }),
      }),
    );
    expect(deps.sessionOptions?.lookup).toHaveBeenCalledTimes(1);
    expect(deps.legacyProbe).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "nvidia-prod",
      status: 500,
      attempts: 4,
      legacy: 0,
      expected: { ok: false, failures: [{ name: "Chat Completions API", httpStatus: 500 }] },
    },
    { provider: "custom", status: 500, attempts: 4, legacy: 1, expected: { ok: false } },
    { provider: "nvidia-prod", status: 401, attempts: 1, legacy: 1, expected: { ok: false } },
    { provider: "nvidia-prod", status: 403, attempts: 1, legacy: 1, expected: { ok: false } },
  ])(
    "limits native $provider HTTP $status to $attempts requests (#12603)",
    async ({ provider, status, attempts, legacy, expected }) => {
      let calls = 0;
      const server = http.createServer((_request, response) => {
        calls++;
        response.statusCode = status;
        response.end("provider failure");
      });
      const port = await listen(server);
      const deps = createOpenAiValidationTestDeps(
        vi.fn(() => ({ ok: false, message: "rejected" })),
      );
      const result = await probeOpenAiLikeEndpointWithValidationSession(
        `http://provider.example.test:${port}/v1`,
        "test-model",
        "fixture-key",
        { provider, skipResponsesProbe: true },
        deps,
      );
      expect(result).toMatchObject(expected);
      expect(calls).toBe(attempts);
      expect(deps.legacyProbe).toHaveBeenCalledTimes(legacy);
    },
  );

  it.each([
    { provider: "nvidia-prod", status: 500, recoverAt: 2, attempts: 2, ok: true },
    { provider: "nvidia-prod", status: 500, recoverAt: 99, attempts: 4, ok: false },
    { provider: "custom", status: 500, recoverAt: 2, attempts: 2, ok: true },
    { provider: "nvidia-prod", status: 401, recoverAt: 2, attempts: 1, ok: false },
    { provider: "nvidia-prod", status: 403, recoverAt: 2, attempts: 1, ok: false },
  ])(
    "limits curl $provider HTTP $status recovery to $attempts requests (#12603)",
    ({ provider, status, recoverAt, attempts, ok }) => {
      withFakeCurlProbe(
        {
          script: makeFakeCurlScript(`
n=$(cat "${HARNESS_COUNTER}")
n=$((n + 1))
printf '%s' "$n" > "${HARNESS_COUNTER}"
if [ "$n" -ge ${recoverAt} ]; then
  printf '%s' '{"choices":[{"message":{"content":"OK"}}]}' > "$outfile"
  printf '200'
else
  printf '%s' 'provider failure' > "$outfile"
  printf '${status}'
fi
`),
        },
        ({ counter }) => {
          const result = probeOpenAiLikeEndpoint(
            "https://integrate.api.nvidia.com/v1",
            "test-model",
            "fixture-key",
            { provider, skipResponsesProbe: true },
          );
          expect(result.ok).toBe(ok);
          expect(Number(fs.readFileSync(counter, "utf8"))).toBe(attempts);
        },
      );
    },
  );
});
