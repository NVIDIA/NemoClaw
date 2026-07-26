// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional test for GPT-5-family reply-budget compat in
// scripts/generate-openclaw-config.mts.
//
// Kept in its own focused file (rather than growing the already
// budget-capped generate-openclaw-config.test.ts) so the gpt-5.4
// max_completion_tokens routing behavior is easy to find and extend.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../scripts/generate-openclaw-config.mts";
import { resolveMaxTokensField } from "../src/lib/inference/max-tokens-field";

/** Minimal env vars required for a valid config generation run. */
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

function writePrefixManifest(match: Record<string, unknown>): string {
  const registryDir = path.join(tmpDir, "model-specific-setup");
  const manifestDir = path.join(registryDir, "openclaw");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "prefix.json"),
    JSON.stringify({
      id: "prefix-fixture",
      agent: "openclaw",
      description: "Model prefix validation fixture",
      match,
      effects: { openclawCompat: { maxTokensField: "max_completion_tokens" } },
    }),
  );
  return registryDir;
}

describe("generate-openclaw-config.mts: GPT-5-family reply-budget compat", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpt5-compat-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    "gpt-5",
    "gpt-5.4",
    "gpt-5.4-turbo",
    "azure/gpt-5.4",
    "o1",
    "o1-mini",
    "openai/o3-mini",
    "o4-mini",
    "gpt-4.1",
    "o2-mini",
    "o10-preview",
  ])("keeps generated config aligned with the shared resolver for %s (#6642)", (model) => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: model,
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: `inference/${model}`,
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("null").toString("base64"),
    });

    const generatedField =
      config.models.providers.inference.models[0].compat?.maxTokensField ?? "max_tokens";
    expect(generatedField).toBe(resolveMaxTokensField(model));
    expect(config.agents.defaults.model.primary).toBe(`inference/${model}`);
  });

  it.each([
    [[], "match.modelIdPrefixes must be a non-empty string array"],
    [["azure/gpt-5"], "match.modelIdPrefixes must contain bare model ids without namespaces"],
  ])("rejects invalid model-family prefixes %# (#6642)", (modelIdPrefixes, message) => {
    const registryDir = writePrefixManifest({ modelIdPrefixes });
    expect(() => runConfigScript({ NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir })).toThrow(
      message,
    );
  });

  it("rejects simultaneous exact and prefix model selectors (#6642)", () => {
    const registryDir = writePrefixManifest({
      modelIds: ["gpt-5.4"],
      modelIdPrefixes: ["gpt-5"],
    });
    expect(() => runConfigScript({ NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir })).toThrow(
      "match.modelIds and match.modelIdPrefixes are mutually exclusive",
    );
  });
});
