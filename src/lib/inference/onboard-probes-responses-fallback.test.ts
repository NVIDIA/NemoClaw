// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

import {
  makeResponsesFallbackUrlRecordingFakeCurlScript,
  withFakeCurlProbe,
} from "./onboard-probes-curl-harness";

const { probeOpenAiLikeEndpoint } = require("./onboard-probes");

it("falls back to chat completions for custom OpenAI-compatible endpoints when /responses lacks tool calls", () => {
  withFakeCurlProbe(
    {
      script: makeResponsesFallbackUrlRecordingFakeCurlScript(),
      dirPrefix: "nemoclaw-responses-tool-fallback-",
    },
    ({ counter, tmpDir }) => {
      const result = probeOpenAiLikeEndpoint(
        "https://proxy.example.com/v1",
        "custom-model",
        "proxy-key",
        { requireResponsesToolCalling: true },
      );

      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        label: "Chat Completions API",
      });
      expect(fs.readFileSync(counter, "utf8").trim()).toBe("2");
      expect(fs.readFileSync(path.join(tmpDir, "request-1-url.txt"), "utf8")).toBe(
        "https://proxy.example.com/v1/responses",
      );
      expect(fs.readFileSync(path.join(tmpDir, "request-2-url.txt"), "utf8")).toBe(
        "https://proxy.example.com/v1/chat/completions",
      );
    },
  );
});
