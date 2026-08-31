// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { HARNESS_TMPDIR, withFakeCurlProbe } from "./onboard-probes-curl-harness";

const { probeOpenAiLikeEndpoint, verifyOnboardInferenceSmoke } = require("./onboard-probes");

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

  it("passes the Gemini reply budget into optimized onboarding smoke validation", async () => {
    const provider = "gemini-api";
    const model = "gemini-2.5-flash";
    const replyBudget = 256;
    const optimizedProbe = vi.fn().mockResolvedValue({ ok: true });
    vi.stubEnv("VITEST", "false");

    try {
      await verifyOnboardInferenceSmoke(
        { endpointUrl: "https://inference.example.com/v1", forceOpenAiLike: true, model, provider },
        { probeOpenAiLikeEndpointOptimized: optimizedProbe },
      );

      expect(optimizedProbe).toHaveBeenCalledWith(
        "https://inference.example.com/v1",
        model,
        "",
        expect.objectContaining({ provider, replyBudget }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
