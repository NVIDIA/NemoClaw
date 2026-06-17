// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy conformance: prove that a manifest-baked openclaw.json produces an
// `agents.list[].subagents.allowAgents` shape that OpenClaw's runtime
// `sessions_spawn` validator honours for configured ids, unknown ids, and
// the `"*"` wildcard. Heavy E2E (rebuild + sandbox boot + spawn) lives in
// the nightly E2E suite; this in-process test mirrors OpenClaw's
// `resolveSubagentTargetPolicy` (openclaw/src/agents/subagent-target-policy.ts)
// so the bake can be checked against the upstream contract during the
// fast CLI test lane.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";
import {
  applyMessagingAgentRenderToObject,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
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

let tmpDir: string;

function ensureFakeOpenClaw(): string {
  const fakeOpenclaw = path.join(tmpDir, "openclaw");
  fs.writeFileSync(fakeOpenclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return fakeOpenclaw;
}

function buildTestEnv(envOverrides: Record<string, string> = {}): Record<string, string> {
  ensureFakeOpenClaw();
  const env = {
    PATH: `${tmpDir}:${process.env.PATH || "/usr/bin:/bin"}`,
    ...BASE_ENV,
    ...envOverrides,
    HOME: tmpDir,
  };
  return withLegacyMessagingPlanEnv(env, "openclaw");
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

function buildBakedConfig(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  return withEnv(env, () => {
    const config = buildConfig();
    applyMessagingAgentRenderToObject(
      config,
      readMessagingBuildPlanFromEnv(env, "openclaw"),
      "openclaw.json",
    );
    return config;
  });
}

function extraAgentsB64(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// ─── OpenClaw policy mirror ──────────────────────────────────────────────
// Local copy of resolveSubagentTargetPolicy from
// openclaw/src/agents/subagent-target-policy.ts. Keep in sync with the
// upstream contract; the test is meaningful only as long as this mirror
// matches OpenClaw's enforcement.

function normalizeAgentId(id: string): string {
  return (id || "").trim().toLowerCase();
}

function normalizeAllowAgents(allowAgents: readonly string[] | undefined): {
  configured: boolean;
  allowAny: boolean;
  allowedIds: string[];
} {
  if (!Array.isArray(allowAgents)) {
    return { configured: false, allowAny: false, allowedIds: [] };
  }
  const allowedIds = allowAgents
    .map((value) => value.trim())
    .filter((value) => value && value !== "*")
    .map((value) => normalizeAgentId(value))
    .filter(Boolean);
  return {
    configured: true,
    allowAny: allowAgents.some((value) => value.trim() === "*"),
    allowedIds: [...new Set(allowedIds)].sort(),
  };
}

function resolveSubagentTargetPolicy(params: {
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  allowAgents?: readonly string[];
  configuredAgentIds: readonly string[];
}): { ok: boolean; reason?: string } {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  const configuredIds = new Set(params.configuredAgentIds.map(normalizeAgentId));
  if (!params.requestedAgentId?.trim() && targetAgentId === requesterAgentId) {
    return { ok: true };
  }
  const policy = normalizeAllowAgents(params.allowAgents);
  if (!policy.configured) {
    if (targetAgentId === requesterAgentId) return { ok: true };
    return { ok: false, reason: "self-only default" };
  }
  if (policy.allowAny) {
    if (!configuredIds.has(targetAgentId) && targetAgentId !== requesterAgentId) {
      return { ok: false, reason: `unknown target ${targetAgentId}` };
    }
    return { ok: true };
  }
  if (!configuredIds.has(targetAgentId)) {
    return { ok: false, reason: `unknown target ${targetAgentId}` };
  }
  if (!policy.allowedIds.includes(targetAgentId)) {
    return { ok: false, reason: `not in allowAgents [${policy.allowedIds.join(", ")}]` };
  }
  return { ok: true };
}

function configuredAgentIds(config: any): string[] {
  return (config.agents.list as Array<{ id: string }>).map((entry) => entry.id);
}

function mainAllowAgents(config: any): string[] | undefined {
  const main = (
    config.agents.list as Array<{ id: string; subagents?: { allowAgents?: string[] } }>
  ).find((entry) => entry.id === "main");
  return main?.subagents?.allowAgents;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-conformance-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("agents manifest :: OpenClaw subagent-target policy conformance", () => {
  it("allows main to target configured ids listed in subagents.allowAgents", () => {
    const config = buildBakedConfig({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          {
            id: "research",
            workspace: "/sandbox/.openclaw/workspace-research",
            agentDir: "/sandbox/.openclaw/agents/research",
            tools: { profile: "minimal", allow: ["read"] },
          },
          {
            id: "writer",
            workspace: "/sandbox/.openclaw/workspace-writer",
            agentDir: "/sandbox/.openclaw/agents/writer",
            tools: { profile: "minimal", allow: ["read"] },
          },
        ],
        main: {
          subagents: {
            allowAgents: ["research", "writer"],
          },
        },
      }),
    });
    const ids = configuredAgentIds(config);
    const allow = mainAllowAgents(config);
    expect(allow).toEqual(["research", "writer"]);
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "research",
        allowAgents: allow,
        configuredAgentIds: ids,
      }).ok,
    ).toBe(true);
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "writer",
        allowAgents: allow,
        configuredAgentIds: ids,
      }).ok,
    ).toBe(true);
  });

  it("rejects main targeting configured ids that are not listed", () => {
    const config = buildBakedConfig({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          {
            id: "research",
            workspace: "/sandbox/.openclaw/workspace-research",
            agentDir: "/sandbox/.openclaw/agents/research",
            tools: { profile: "minimal", allow: ["read"] },
          },
          {
            id: "writer",
            workspace: "/sandbox/.openclaw/workspace-writer",
            agentDir: "/sandbox/.openclaw/agents/writer",
            tools: { profile: "minimal", allow: ["read"] },
          },
        ],
        main: {
          subagents: {
            allowAgents: ["research"],
          },
        },
      }),
    });
    const verdict = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "writer",
      allowAgents: mainAllowAgents(config),
      configuredAgentIds: configuredAgentIds(config),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/not in allowAgents/);
  });

  it("rejects unknown target ids even when wildcard is configured", () => {
    const config = buildBakedConfig({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          {
            id: "research",
            workspace: "/sandbox/.openclaw/workspace-research",
            agentDir: "/sandbox/.openclaw/agents/research",
            tools: { profile: "minimal", allow: ["read"] },
          },
        ],
        main: {
          subagents: {
            allowAgents: ["*"],
          },
        },
      }),
    });
    const allow = mainAllowAgents(config);
    expect(allow).toEqual(["*"]);
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "research",
        allowAgents: allow,
        configuredAgentIds: configuredAgentIds(config),
      }).ok,
    ).toBe(true);
    const denied = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "ghost",
      allowAgents: allow,
      configuredAgentIds: configuredAgentIds(config),
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/unknown target/);
  });

  it("falls back to self-only when allowAgents is omitted", () => {
    const config = buildBakedConfig({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          {
            id: "research",
            workspace: "/sandbox/.openclaw/workspace-research",
            agentDir: "/sandbox/.openclaw/agents/research",
            tools: { profile: "minimal", allow: ["read"] },
          },
        ],
      }),
    });
    expect(mainAllowAgents(config)).toBeUndefined();
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "main",
        allowAgents: undefined,
        configuredAgentIds: configuredAgentIds(config),
      }).ok,
    ).toBe(true);
    const denied = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "research",
      allowAgents: undefined,
      configuredAgentIds: configuredAgentIds(config),
    });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/self-only/);
  });
});
