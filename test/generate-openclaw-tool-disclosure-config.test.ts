// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-tool-disclosure-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate-openclaw-config.mts: tool disclosure", () => {
  it("uses only OpenClaw's camel-case structured Tool Search key by default", () => {
    const config = buildConfig(BASE_ENV);

    expect(config.tools?.toolSearch).toEqual({
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    });
    expect(config.tools?.tool_search).toBeUndefined();
  });

  it("restores direct tool exposure through the agent-neutral override", () => {
    const config = buildConfig({ ...BASE_ENV, NEMOCLAW_TOOL_DISCLOSURE: "direct" });

    expect(config.tools?.toolSearch).toBe(false);
  });

  it("rejects unknown tool-disclosure modes", () => {
    expect(() => buildConfig({ ...BASE_ENV, NEMOCLAW_TOOL_DISCLOSURE: "sometimes" })).toThrow(
      "NEMOCLAW_TOOL_DISCLOSURE must be progressive or direct",
    );
  });

  it("does not let a model setup re-enable Tool Search over a direct request", () => {
    const registryDir = path.join(tmpDir, "model-specific-setup");
    const manifestPath = path.join(registryDir, "openclaw", "tool-search-on.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "tool-search-on",
        agent: "openclaw",
        description: "Legacy code-mode override",
        match: { modelIds: ["test-model"] },
        effects: { openclawTools: { toolSearch: true } },
      }),
    );

    const config = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
    });

    expect(config.tools?.toolSearch).toBe(false);
  });
});
