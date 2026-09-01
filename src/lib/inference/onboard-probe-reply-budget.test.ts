// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { useOpenAiValidationTestServers } from "./openai-validation-session.test-helpers";
import { HARNESS_TMPDIR, withFakeCurlProbe } from "./onboard-probes-curl-harness";

const {
  probeOpenAiLikeEndpoint,
  probeOpenAiLikeEndpointOptimized,
  verifyOnboardInferenceSmoke,
} = require("./onboard-probes");

const listen = useOpenAiValidationTestServers();

const optimizedProbeSessionOptions = {
  validationTiming: { connectTimeoutSeconds: 1, maxTimeSeconds: 1, source: "standard" },
  validationSessionOptions: {
    env: {},
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    allowPrivateAddressesForTesting: true,
  },
};

describe("onboarding inference probe reply budgets", () => {
  it("keeps DeepSeek V4 Pro's model-specific budget on the onboarding probe path", () => {
    const script = `#!/usr/bin/env bash
outfile=""
payload=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    -d) payload="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s' "$payload" > "${HARNESS_TMPDIR}/deepseek-request.json"
printf '%s' '{"choices":[{"message":{"content":"OK"}}]}' > "$outfile"
printf '200'
`;
    withFakeCurlProbe({ script, dirPrefix: "nemoclaw-deepseek-budget-" }, ({ tmpDir }) => {
      const result = probeOpenAiLikeEndpoint(
        "https://example.com/v1",
        "deepseek-ai/deepseek-v4-pro",
        "",
        { skipResponsesProbe: true, provider: "nvidia-prod" },
      );

      expect(result).toMatchObject({ ok: false });
      expect(
        JSON.parse(fs.readFileSync(path.join(tmpDir, "deepseek-request.json"), "utf8")),
      ).toMatchObject({
        max_tokens: 8192,
      });
    });
  });

  it("derives the Gemini reply budget at the optimized probe boundary", async () => {
    let payload: Record<string, unknown> | null = null;
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        payload = JSON.parse(body) as Record<string, unknown>;
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);

    const result = await probeOpenAiLikeEndpointOptimized(
      `http://provider.example.com:${port}/v1`,
      "gemini-2.5-flash",
      "test-key",
      {
        skipResponsesProbe: true,
        provider: "gemini-api",
        ...optimizedProbeSessionOptions,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(payload).toMatchObject({ max_tokens: 256 });
  });

  it("keeps the ordinary reply budget when no Gemini provider is supplied", async () => {
    let payload: Record<string, unknown> | null = null;
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        payload = JSON.parse(body) as Record<string, unknown>;
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);

    const result = await probeOpenAiLikeEndpointOptimized(
      `http://provider.example.com:${port}/v1`,
      "gpt-4o",
      "test-key",
      {
        skipResponsesProbe: true,
        provider: "openai",
        ...optimizedProbeSessionOptions,
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(payload).toMatchObject({ max_tokens: 16 });
  });

  it("applies the Gemini reply budget through optimized onboarding smoke validation", async () => {
    let payload: Record<string, unknown> | null = null;
    const server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        payload = JSON.parse(body) as Record<string, unknown>;
        response.end('{"choices":[{"message":{"content":"OK"}}]}');
      });
    });
    const port = await listen(server);
    vi.stubEnv("VITEST", "false");

    try {
      await verifyOnboardInferenceSmoke(
        {
          endpointUrl: `http://provider.example.com:${port}/v1`,
          forceOpenAiLike: true,
          model: "gemini-2.5-flash",
          provider: "gemini-api",
        },
        {
          probeOpenAiLikeEndpointOptimized: (
            endpointUrl: string,
            model: string,
            apiKey: string,
            options: Record<string, unknown>,
          ) =>
            probeOpenAiLikeEndpointOptimized(endpointUrl, model, apiKey, {
              ...options,
              ...optimizedProbeSessionOptions,
            }),
        },
      );

      expect(payload).toMatchObject({ model: "gemini-2.5-flash", max_tokens: 256 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
