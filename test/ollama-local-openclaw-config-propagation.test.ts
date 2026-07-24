// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfig,
  buildLocalOllamaSmallContextCompaction,
  buildManagedInferenceSafeguardCompaction,
  main,
} from "../scripts/generate-openclaw-config.mts";
import { patchStagedDockerfile } from "../src/lib/onboard/dockerfile-patch";

const tmpRoots: string[] = [];
const STRUCTURED_TOOL_SEARCH = { mode: "tools", searchDefaultLimit: 8, maxSearchLimit: 20 };

function dockerfileWith(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-config-test-"));
  tmpRoots.push(dir);
  const file = path.join(dir, "Dockerfile");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

function readDockerArgs(dockerfilePath: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of fs.readFileSync(dockerfilePath, "utf-8").split("\n")) {
    const match = line.match(/^ARG ([A-Z0-9_]+)=(.*)$/);
    if (match) {
      args[match[1]] = match[2];
    }
  }
  return args;
}

function decodeCompat(args: Record<string, string>): Record<string, unknown> {
  const compatB64 = args.NEMOCLAW_INFERENCE_COMPAT_B64;
  assert.ok(compatB64, "expected NEMOCLAW_INFERENCE_COMPAT_B64 to be patched");
  return JSON.parse(Buffer.from(compatB64, "base64").toString("utf-8"));
}

function runConfigScript(envOverrides: Record<string, string>): any {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-config-generator-test-"));
  tmpRoots.push(dir);
  const fakeOpenClaw = path.join(dir, "openclaw");
  fs.writeFileSync(fakeOpenClaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: `${dir}:${process.env.PATH || "/usr/bin:/bin"}`,
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
    ...envOverrides,
    HOME: dir,
  };
  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    main();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, ".openclaw", "openclaw.json"), "utf-8"));
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ollama-local OpenClaw config propagation", () => {
  it("propagates streaming usage compat through the managed inference route", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:0.5b",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    expect(dockerArgs).toMatchObject({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(decodeCompat(dockerArgs)).toEqual({ supportsUsageInStreaming: true });

    const config = buildConfig({
      ...dockerArgs,
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_AGENT_TIMEOUT: "600",
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3128",
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "qwen2.5:0.5b",
      name: "inference/qwen2.5:0.5b",
      compat: { supportsUsageInStreaming: true },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/qwen2.5:0.5b");
  });

  it("carries the ollama-local upstream provider through the staged Dockerfile (#5468)", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_UPSTREAM_PROVIDER=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen2.5:0.5b",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    // The managed-route key collapses to "inference", but the upstream provider
    // the user actually selected is preserved for config-time decisions.
    expect(dockerArgs.NEMOCLAW_PROVIDER_KEY).toBe("inference");
    expect(dockerArgs.NEMOCLAW_UPSTREAM_PROVIDER).toBe("ollama-local");
  });

  it("uses the resolved Qwen disclosure state for propagated compaction settings", () => {
    const dockerfilePath = dockerfileWith(
      [
        "ARG NEMOCLAW_MODEL=old",
        "ARG NEMOCLAW_PROVIDER_KEY=old",
        "ARG NEMOCLAW_UPSTREAM_PROVIDER=old",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=old",
        "ARG CHAT_UI_URL=old",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=old",
        "ARG NEMOCLAW_INFERENCE_API=old",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=old",
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
        "ARG NEMOCLAW_BUILD_ID=old",
        "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      ].join("\n"),
    );

    patchStagedDockerfile(
      dockerfilePath,
      "qwen35-9b-q6:latest",
      "http://127.0.0.1:18789",
      "build-ollama-local",
      "ollama-local",
    );

    const dockerArgs = readDockerArgs(dockerfilePath);
    expect(dockerArgs.NEMOCLAW_TOOL_DISCLOSURE).toBe("progressive");

    const config = buildConfig({
      ...dockerArgs,
      NEMOCLAW_CONTEXT_WINDOW: "32768",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });

    expect(config.tools.toolSearch).toBe(false);
    expect(config.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
  });

  it("uses the direct-tool reserve when the Qwen profile disables Tool Search", () => {
    const qwenEnv = {
      NEMOCLAW_MODEL: "qwen35-9b-q6:latest",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen35-9b-q6:latest",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "32768",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_REASONING: "false",
    };
    const config = runConfigScript(qwenEnv);
    const explicitDirectConfig = runConfigScript({
      ...qwenEnv,
      NEMOCLAW_TOOL_DISCLOSURE: "direct",
    });

    expect(config.tools.toolSearch).toBe(false);
    expect(config.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(config.agents.defaults.compaction).toEqual(
      explicitDirectConfig.agents.defaults.compaction,
    );
  });

  it("enables reasoning and direct tools for Qwen 3.5 Local Ollama profiles", () => {
    for (const model of ["qwen3.5:9b", "qwen35-9b-q6:latest"]) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: model,
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
        NEMOCLAW_PRIMARY_MODEL_REF: `inference/${model}`,
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        NEMOCLAW_CONTEXT_WINDOW: "32768",
        NEMOCLAW_REASONING: "false",
        NEMOCLAW_TOOL_DISCLOSURE: "direct",
      });

      expect(config.models.providers.inference.models[0].reasoning, model).toBe(true);
      expect(config.models.providers.inference.models[0].compat, model).toMatchObject({
        thinkingFormat: "openrouter",
      });
      expect(config.agents.defaults.thinkingDefault, model).toBe("off");
      expect(config.tools.toolSearch, model).toBe(false);
      expect(config.agents.defaults.compaction, model).toEqual({
        reserveTokens: 4096,
        reserveTokensFloor: 4096,
      });
    }
  });

  it("keeps Qwen 3.5 thinking compatibility scoped to its managed route", () => {
    const cases = [
      { NEMOCLAW_MODEL: "qwen3.6:35b" },
      { NEMOCLAW_PROVIDER_KEY: "ollama-local" },
      { NEMOCLAW_INFERENCE_API: "openai-responses" },
      { NEMOCLAW_INFERENCE_BASE_URL: "http://host.docker.internal:11434/v1" },
    ];

    for (const envCase of cases) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "qwen3.5:9b",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen3.5:9b",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        NEMOCLAW_REASONING: "false",
        ...envCase,
      });

      const provider = Object.values(config.models.providers)[0] as any;
      expect(provider.models[0].reasoning).toBe(false);
      expect(provider.models[0].compat?.thinkingFormat).toBeUndefined();
      expect(config.agents.defaults.thinkingDefault).toBe("off");
      expect(config.tools.toolSearch).toEqual(STRUCTURED_TOOL_SEARCH);
    }
  }, 20_000);
});

describe("OpenClaw managed-route compaction policy (#5468, #4781)", () => {
  it("emits a lowered compaction reserve for a small Local Ollama window", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:0.5b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:0.5b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    // Reserve exactly the reply budget so the first-turn prompt budget grows
    // from ~8k (OpenClaw default) to contextWindow - maxTokens = 12288.
    expect(config.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
  });

  it("uses safeguard compaction for remote managed inference (#4781)", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-prod",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "16384",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      maxHistoryShare: 0.35,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
      truncateAfterCompaction: true,
    });
  });

  it("treats a missing legacy upstream provider as remote managed inference (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        undefined,
        "https://inference.local/v1",
      ),
    ).toEqual({
      mode: "safeguard",
      timeoutSeconds: 120,
      maxHistoryShare: 0.35,
      recentTurnsPreserve: 1,
      qualityGuard: { enabled: true, maxRetries: 0 },
      notifyUser: true,
      truncateAfterCompaction: true,
    });
  });

  it("leaves OpenClaw's default reserve intact for large Local Ollama windows", () => {
    const config = buildConfig({
      NEMOCLAW_MODEL: "qwen2.5:7b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "ollama-local",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen2.5:7b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_CONTEXT_WINDOW: "131072",
      NEMOCLAW_MAX_TOKENS: "4096",
      NEMOCLAW_AGENT_TIMEOUT: "600",
    });
    expect(config.agents.defaults.compaction).toBeUndefined();
  });

  it("does not enable managed-inference safeguards outside inference.local (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "inference",
        "nvidia-prod",
        "https://integrate.api.nvidia.com/v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    "https://inference.local.evil/v1",
    "https://inference.local@evil.example/v1",
  ])("rejects a confusing managed-inference hostname %s (#4781)", (baseUrl) => {
    expect(
      buildManagedInferenceSafeguardCompaction("inference", "nvidia-prod", baseUrl),
    ).toBeUndefined();
  });

  it("does not enable managed-inference safeguards for another provider key (#4781)", () => {
    expect(
      buildManagedInferenceSafeguardCompaction(
        "nvidia-prod",
        "nvidia-prod",
        "https://inference.local/v1",
      ),
    ).toBeUndefined();
  });

  it("clamps the reserve so the prompt budget never drops below OpenClaw's 8k minimum", () => {
    // A pathological maxTokens must not make the window worse than the default.
    const compaction = buildLocalOllamaSmallContextCompaction("ollama-local", 16384, 99999);
    expect(compaction).toEqual({ reserveTokens: 8384, reserveTokensFloor: 8384 });
    expect(16384 - 8384).toBe(8000);
  });

  it("applies at the 28k threshold boundary and not just above it", () => {
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 28000, 4096)).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 28001, 4096)).toBeUndefined();
  });

  it("lowers the reserve for a 32k Local Ollama window with direct tools", () => {
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 32768, 4096, "direct")).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(
      buildLocalOllamaSmallContextCompaction("ollama-local", 32768, 4096, "progressive"),
    ).toBeUndefined();
  });

  it("keeps the direct-tool reserve override bounded to a 44k Local Ollama window", () => {
    expect(buildLocalOllamaSmallContextCompaction("ollama-local", 44000, 4096, "direct")).toEqual({
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
    expect(
      buildLocalOllamaSmallContextCompaction("ollama-local", 44001, 4096, "direct"),
    ).toBeUndefined();
  });
});
