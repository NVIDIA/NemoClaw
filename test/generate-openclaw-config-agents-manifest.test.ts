// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Agents-manifest extensions for scripts/generate-openclaw-config.mts.
// Exercises the v1 `{agents,defaults?,main?}` payload shape that the YAML
// loader emits: per-agent model + subagents OpenClaw-native fields,
// agents.defaults bake, main-agent augmentation, and providers.models
// expansion for unique secondary model refs. Split out of
// generate-openclaw-config.test.ts to keep that file under the legacy
// test-file-size budget.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildConfig, main } from "../scripts/generate-openclaw-config.mts";
import {
  applyMessagingAgentRenderToObject,
  readMessagingBuildPlanFromEnv,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

const APPLIER_PATH = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);

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

function runMessagingPostInstall(env: Record<string, string>): void {
  const result = spawnSync(
    "node",
    [
      "--experimental-strip-types",
      APPLIER_PATH,
      "--agent",
      "openclaw",
      "--phase",
      "post-agent-install",
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 10_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Messaging applier failed (exit ${result.status}):
stdout: ${result.stdout}
stderr: ${result.stderr}`,
    );
  }
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  withEnv(env, () => main());
  runMessagingPostInstall(env);
  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function buildConfigDirect(envOverrides: Record<string, string> = {}): any {
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

function expectBuildConfigError(envOverrides: Record<string, string>, message: string | RegExp) {
  expect(() => buildConfigDirect(envOverrides)).toThrow(message);
}

const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };

function makeExtra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "research",
    workspace: "/sandbox/.openclaw/workspace-research",
    agentDir: "/sandbox/.openclaw/agents/research",
    tools: TOOLS_OK,
    ...overrides,
  };
}

function extraAgentsB64(extras: unknown): string {
  return Buffer.from(JSON.stringify(extras)).toString("base64");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-generate-config-agents-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generate-openclaw-config :: agents manifest", () => {
  it("accepts the new payload object shape {agents, defaults?, main?}", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [makeExtra({ id: "research" })],
      }),
    });
    expect(config.agents.list[1]).toMatchObject({ id: "research" });
  });

  it("rejects unknown top-level keys in the object payload", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [],
          rogue: "x",
        }),
      },
      /NEMOCLAW_EXTRA_AGENTS_JSON contains unsupported field\(s\): rogue/,
    );
  });

  it("accepts a same-provider per-agent model and adds it to providers.models[]", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [makeExtra({ model: "test-provider/secondary-1" })],
      }),
    });
    expect(config.agents.list[1].model).toBe("test-provider/secondary-1");
    const refs = config.models.providers["test-provider"].models.map(
      (entry: { name: string }) => entry.name,
    );
    expect(refs).toEqual(["test-ref", "test-provider/secondary-1"]);
    const secondary = config.models.providers["test-provider"].models[1];
    expect(secondary.id).toBe("secondary-1");
  });

  it("dedups model refs across multiple agents and the main override", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          makeExtra({ id: "research", model: "test-provider/shared-model" }),
          makeExtra({
            id: "writing",
            workspace: "/sandbox/.openclaw/workspace-writing",
            agentDir: "/sandbox/.openclaw/agents/writing",
            model: "test-provider/shared-model",
            subagents: { model: "test-provider/shared-model" },
          }),
        ],
        main: {
          subagents: {
            allowAgents: ["research", "writing"],
            model: "test-provider/shared-model",
          },
        },
      }),
    });
    const refs = config.models.providers["test-provider"].models.map(
      (entry: { name: string }) => entry.name,
    );
    expect(refs).toEqual(["test-ref", "test-provider/shared-model"]);
  });

  it("rejects a per-agent model whose provider does not match the onboard provider", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [makeExtra({ model: "other-provider/model-x" })],
        }),
      },
      /model provider "other-provider" must match the onboard provider "test-provider"/,
    );
  });

  it("rejects per-agent model strings without a provider/model split", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [makeExtra({ model: "bare-name" })],
        }),
      },
      /must be of the form "provider\/model"/,
    );
  });

  it("rejects per-agent model strings whose model portion is whitespace-only", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [makeExtra({ model: "test-provider/ " })],
        }),
      },
      /model portion must be non-empty and contain no surrounding whitespace/,
    );
  });

  it("accepts subagents.allowAgents and bakes it verbatim under the agent entry", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [
          makeExtra({
            subagents: {
              allowAgents: ["analyst", "writer"],
              delegationMode: "prefer",
              requireAgentId: true,
            },
          }),
        ],
      }),
    });
    expect(config.agents.list[1].subagents).toEqual({
      allowAgents: ["analyst", "writer"],
      delegationMode: "prefer",
      requireAgentId: true,
    });
  });

  it("rejects subagents.delegationMode values outside the OpenClaw enum", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [makeExtra({ subagents: { delegationMode: "force" } })],
        }),
      },
      /delegationMode must be one of: prefer, suggest/,
    );
  });

  it("rejects subagents.allowAgents that is not an array of non-empty strings", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [makeExtra({ subagents: { allowAgents: ["", "ok"] } })],
        }),
      },
      /allowAgents must be an array of non-empty strings/,
    );
  });

  it("bakes defaults.subagents.maxSpawnDepth into agents.defaults.subagents", () => {
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [],
        defaults: { subagents: { maxSpawnDepth: 3 } },
      }),
    });
    expect(config.agents.defaults.subagents).toEqual({ maxSpawnDepth: 3 });
  });

  it("rejects defaults.subagents.maxSpawnDepth outside OpenClaw's 1..5 range", () => {
    for (const depth of [0, 6, -1, 1.5]) {
      expectBuildConfigError(
        {
          NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
            agents: [],
            defaults: { subagents: { maxSpawnDepth: depth } },
          }),
        },
        /maxSpawnDepth must be an integer between 1 and 5/,
      );
    }
  });

  it("merges main.subagents and main.tools onto the canonical main entry", () => {
    const mainTools = { profile: "minimal", allow: ["read", "write"] };
    const mainSubagents = {
      allowAgents: ["research"],
      delegationMode: "prefer",
      requireAgentId: true,
    };
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
        agents: [makeExtra({ id: "research" })],
        main: { tools: mainTools, subagents: mainSubagents },
      }),
    });
    expect(config.agents.list[0]).toEqual({
      id: "main",
      default: true,
      tools: mainTools,
      subagents: mainSubagents,
    });
  });

  it("rejects main overrides that target fields outside the allowlist", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({
          agents: [],
          main: { workspace: "/sandbox/.openclaw/workspace-main" },
        }),
      },
      /NEMOCLAW_EXTRA_AGENTS_JSON\.main contains unsupported field\(s\): workspace/,
    );
  });
});
