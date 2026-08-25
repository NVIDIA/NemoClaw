// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv, buildOpenClawTestEnv } from "../helpers/openclaw-env-fixture";
import { withLegacyMessagingPlanEnv } from "../messaging-plan-test-helper";

const BASE_ENV = baseOpenClawGenerationEnv();

const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };

let tmpDir: string;

const buildTestEnv = (envOverrides: Record<string, string> = {}): Record<string, string> =>
  withLegacyMessagingPlanEnv(buildOpenClawTestEnv(tmpDir, BASE_ENV, envOverrides), "openclaw");

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
