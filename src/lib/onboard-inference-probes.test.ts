// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  getChatCompletionsProbeCurlArgs,
  getChatCompletionsProbePayload,
  getDeepSeekV4ProValidationProbeCurlArgs,
  probeOpenAiLikeEndpoint,
} = require("../../dist/lib/onboard-inference-probes");

describe("OpenAI-compatible inference probes", () => {
  it("uses the NVIDIA Build request shape for DeepSeek V4 Pro", () => {
    expect(getChatCompletionsProbePayload("deepseek-ai/deepseek-v4-pro")).toEqual({
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      temperature: 1,
      top_p: 0.95,
      max_tokens: 8192,
      chat_template_kwargs: { thinking: false },
      stream: true,
    });
  });

  it("keeps the default chat-completions probe minimal for other models", () => {
    expect(getChatCompletionsProbePayload("nvidia/nemotron-3-super-120b-a12b")).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
  });

  it("uses an extended streaming validation budget for DeepSeek V4 Pro", () => {
    expect(getDeepSeekV4ProValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "20",
      "--max-time",
      "120",
    ]);
    expect(getDeepSeekV4ProValidationProbeCurlArgs({ isWsl: true })).toEqual([
      "--connect-timeout",
      "30",
      "--max-time",
      "150",
    ]);

    const args = getChatCompletionsProbeCurlArgs({
      authHeader: ["-H", "Authorization: Bearer nvapi-test"],
      model: "deepseek-ai/deepseek-v4-pro",
      url: "https://integrate.api.nvidia.com/v1/chat/completions",
      isWsl: false,
    });

    expect(args).toContain("--max-time");
    expect(args[args.indexOf("--max-time") + 1]).toBe("120");
    expect(args).toContain("Authorization: Bearer nvapi-test");
  });

  it("continues with openai-completions when DeepSeek V4 Pro stream validation times out", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deepseek-probe-"));
    const fakeBin = path.join(tmpDir, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(fakeBin, "curl"),
      `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$outfile" ]; then
  : > "$outfile"
fi
printf '000'
exit 28
`,
      { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    const originalLog = console.log;
    const lines: string[] = [];
    process.env.PATH = `${fakeBin}:${originalPath || ""}`;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const result = probeOpenAiLikeEndpoint(
        "https://integrate.api.nvidia.com/v1",
        "deepseek-ai/deepseek-v4-pro",
        "nvapi-test",
        { skipResponsesProbe: true },
      );

      expect(result).toMatchObject({
        ok: true,
        api: "openai-completions",
        label: "Chat Completions API",
        validated: false,
      });
      expect(lines.join("\n")).toContain("DeepSeek V4 Pro validation timed out");
    } finally {
      console.log = originalLog;
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
