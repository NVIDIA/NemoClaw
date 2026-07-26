// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runSmokeScript,
  writeFakeCurl,
  writeSmokeConfig,
} from "./__test-helpers__/compatible-endpoint-smoke-helpers";

vi.mock("../inference/config", () => ({
  INFERENCE_ROUTE_URL: "https://inference.local/v1",
  MANAGED_PROVIDER_ID: "inference",
}));

import { buildCompatibleEndpointSandboxSmokeScript } from "./compatible-endpoint-smoke";

describe("compatible endpoint GPT-5 reply-budget smoke", () => {
  it.each([
    {
      model: "gpt-5.4",
      expectedField: "max_completion_tokens",
      unexpectedField: "max_tokens",
    },
    {
      model: "nvidia/nemotron-3-super-120b-a12b",
      expectedField: "max_tokens",
      unexpectedField: "max_completion_tokens",
    },
  ])("uses $expectedField for $model (#6642)", ({ model, expectedField, unexpectedField }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-token-field-"));
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, requestFile } = writeFakeCurl(
      tmpDir,
      `printf '%s\\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      configPath,
      retryDelaySeconds: 0,
    });

    expect(runSmokeScript(script, tmpDir, binDir).status).toBe(0);
    const payload = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
    expect(payload[expectedField]).toBe(512);
    expect(payload[unexpectedField]).toBeUndefined();
  });

  it("keeps max_completion_tokens for a GPT-5 reasoning retry (#6642)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-compat-smoke-gpt5-retry-"));
    const model = "gpt-5.4";
    const configPath = writeSmokeConfig(tmpDir, model);
    const { binDir, callFile, requestFile } = writeFakeCurl(
      tmpDir,
      String.raw`
if [ "$count" -eq 1 ]; then
  cat <<'JSON'
{"choices":[{"message":{"content":null,"reasoning_content":"The user asked for PONG."},"finish_reason":"length"}]}
JSON
else
  printf '%s\n' '{"choices":[{"message":{"content":"PONG"},"finish_reason":"stop"}]}'
fi
`,
    );
    const script = buildCompatibleEndpointSandboxSmokeScript(model, {
      attempts: 2,
      configPath,
      initialMaxTokens: 32,
      retryDelaySeconds: 0,
      retryMaxTokens: 512,
    });

    expect(runSmokeScript(script, tmpDir, binDir).status).toBe(0);
    expect(fs.readFileSync(callFile, "utf-8")).toBe("2");
    const retryPayload = JSON.parse(fs.readFileSync(requestFile, "utf-8"));
    expect(retryPayload.max_completion_tokens).toBe(512);
    expect(retryPayload.max_tokens).toBeUndefined();
  });
});
