// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../scripts/generate-openclaw-config.mts";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

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

const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };

let tmpDir: string;

function buildTestEnv(envOverrides: Record<string, string> = {}): Record<string, string> {
  fs.writeFileSync(path.join(tmpDir, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: `${tmpDir}:${process.env.PATH || "/usr/bin:/bin"}`,
    ...BASE_ENV,
    ...envOverrides,
    HOME: tmpDir,
  };
  return withLegacyMessagingPlanEnv(env, "openclaw");
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const original = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
  }
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  withEnv(env, () => main());
  return JSON.parse(fs.readFileSync(path.join(tmpDir, ".openclaw", "openclaw.json"), "utf-8"));
}

function extraAgentsB64(extras: unknown): string {
  return Buffer.from(JSON.stringify(extras)).toString("base64");
}

describe("generate-openclaw-config.mts: extra-agents path defaulting", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-path-defaults-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("auto-fills workspace and agentDir from id when omitted (full or partial)", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        { id: "alpha", tools: TOOLS_OK },
        { id: "beta", workspace: "/sandbox/.openclaw/workspace-beta", tools: TOOLS_OK },
      ]),
    });
    expect(config.agents.list[1]).toMatchObject({
      id: "alpha",
      workspace: "/sandbox/.openclaw/workspace-alpha",
      agentDir: "/sandbox/.openclaw/agents/alpha",
    });
    expect(config.agents.list[2]).toMatchObject({
      id: "beta",
      workspace: "/sandbox/.openclaw/workspace-beta",
      agentDir: "/sandbox/.openclaw/agents/beta",
    });
  });

  it("accepts the legacy allow-only array payload with defaulted workspace and agentDir", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        { id: "legacy-worker", tools: { allow: ["read"] } },
      ]),
    });
    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[1]).toMatchObject({
      id: "legacy-worker",
      workspace: "/sandbox/.openclaw/workspace-legacy-worker",
      agentDir: "/sandbox/.openclaw/agents/legacy-worker",
      tools: { allow: ["read"] },
    });
  });

  it("auto-fills workspace and agentDir for the object-shaped {agents} payload", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [{ id: "legacy-worker", tools: { allow: ["read"] } }],
      }),
    });
    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[1]).toMatchObject({
      id: "legacy-worker",
      workspace: "/sandbox/.openclaw/workspace-legacy-worker",
      agentDir: "/sandbox/.openclaw/agents/legacy-worker",
      tools: { allow: ["read"] },
    });
  });
});
