// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for Gemini 3 managed-route compatibility in
// scripts/generate-openclaw-config.mts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/generate-openclaw-config.mts";

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

function ensureFakeOpenClaw(): void {
  const fakeOpenclaw = path.join(tmpDir, "openclaw");
  fs.writeFileSync(fakeOpenclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function buildTestEnv(envOverrides: Record<string, string> = {}): Record<string, string> {
  ensureFakeOpenClaw();
  return {
    PATH: `${tmpDir}:${process.env.PATH || "/usr/bin:/bin"}`,
    ...BASE_ENV,
    ...envOverrides,
    HOME: tmpDir,
  };
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  withEnv(env, () => main());
  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

describe("generate-openclaw-config.mts: Gemini 3 managed-route compat", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gemini-compat-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(["gemini-3.6-flash", "google/gemini-3.1-pro-preview"])(
    "loads Gemini compatibility for %s managed inference (#8474)",
    (model) => {
      const config = runConfigScript({
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: `inference/${model}`,
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
      });

      expect(config.models.providers.inference).toMatchObject({
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
      });
      expect(config.plugins.entries["nemoclaw-gemini-inference-compat"]).toEqual({
        enabled: true,
      });
      expect(config.plugins.allow).toEqual(["nemoclaw", "nemoclaw-gemini-inference-compat"]);
      expect(config.plugins.load.paths).toEqual([
        "/usr/local/share/nemoclaw/openclaw-plugins/gemini-inference-compat",
      ]);
    },
  );

  it.each([
    { NEMOCLAW_MODEL: "gemini-2.5-flash" },
    { NEMOCLAW_PROVIDER_KEY: "openai" },
    { NEMOCLAW_INFERENCE_API: "openai-responses" },
    { NEMOCLAW_INFERENCE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta" },
  ])(
    "does not load Gemini compatibility for non-Gemini-3 models or non-managed routes [case %#] (#8474)",
    (envCase) => {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "gemini-3.6-flash",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/gemini-3.6-flash",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        ...envCase,
      });

      expect(config.plugins.entries["nemoclaw-gemini-inference-compat"]).toBeUndefined();
      expect(config.plugins.load).toBeUndefined();
    },
  );
});
