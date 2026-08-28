// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/generate-openclaw-config.mts";

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "nemotron-3-super",
  NEMOCLAW_PROVIDER_KEY: "inference",
  NEMOCLAW_UPSTREAM_PROVIDER: "compatible-endpoint",
  NEMOCLAW_PRIMARY_MODEL_REF: "inference/nemotron-3-super",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
  NEMOCLAW_INFERENCE_API: "openai-completions",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "true",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

let tmpDir: string;

function buildTestEnv(envOverrides: Record<string, string> = {}): Record<string, string> {
  const fakeOpenclaw = path.join(tmpDir, "openclaw");
  fs.writeFileSync(fakeOpenclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
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
  withEnv(buildTestEnv(envOverrides), () => main());
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf-8"));
}

function primaryModel(config: any): any {
  return config.models.providers.inference.models[0];
}

describe("compatible-endpoint reasoning effort in the built OpenClaw config (#7659)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reasoning-effort-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends the selected effort in the openai-completions request body", () => {
    const config = runConfigScript({ NEMOCLAW_REASONING_EFFORT: "high" });

    expect(primaryModel(config).params).toEqual({ extra_body: { reasoning_effort: "high" } });
  });

  it("leaves the model entry unchanged when no effort is selected", () => {
    const config = runConfigScript();

    expect(primaryModel(config).params).toBeUndefined();
    expect(primaryModel(config).reasoning).toBe(true);
  });

  it("omits the request-body override for an API family that does not carry it", () => {
    const config = runConfigScript({
      NEMOCLAW_INFERENCE_API: "anthropic-messages",
      NEMOCLAW_REASONING_EFFORT: "high",
    });

    expect(primaryModel(config).params).toBeUndefined();
  });

  it("omits the request-body override for a provider that cannot record it", () => {
    const config = runConfigScript({
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_REASONING_EFFORT: "high",
    });

    expect(primaryModel(config).params).toBeUndefined();
  });

  it("ignores an invalid stale value for a provider that cannot record it", () => {
    const config = runConfigScript({
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_REASONING_EFFORT: "extreme",
    });

    expect(primaryModel(config).params).toBeUndefined();
  });

  it("accepts default as an explicit request for no request-body override", () => {
    const config = runConfigScript({ NEMOCLAW_REASONING_EFFORT: "default" });

    expect(primaryModel(config).params).toBeUndefined();
  });

  it("applies the effort to secondary agent models as well as the primary", () => {
    const config = runConfigScript({
      NEMOCLAW_REASONING_EFFORT: "low",
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: Buffer.from(
        JSON.stringify([
          {
            id: "helper",
            model: "inference/nemotron-3-nano",
            workspace: "/sandbox/.openclaw/workspace-helper",
            agentDir: "/sandbox/.openclaw/agents/helper",
            tools: { profile: "minimal", allow: ["read"], deny: ["exec"] },
          },
        ]),
      ).toString("base64"),
    });

    const models = config.models.providers.inference.models;
    expect(models.length).toBeGreaterThan(1);
    models.forEach((model: { params: unknown }) => {
      expect(model.params).toEqual({ extra_body: { reasoning_effort: "low" } });
    });
  });

  it("fails the build rather than dropping an unsupported effort", () => {
    expect(() => runConfigScript({ NEMOCLAW_REASONING_EFFORT: "extreme" })).toThrow(
      /NEMOCLAW_REASONING_EFFORT must be one of: low, medium, high, default/,
    );
  });
});
