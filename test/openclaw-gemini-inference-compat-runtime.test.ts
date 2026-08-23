// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "../scripts/generate-openclaw-config.mts";
import { dockerSpawnSync } from "../src/lib/adapters/docker/exec";
import {
  ensureOpenClawGeminiRuntimeImage,
  OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS,
  OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS,
} from "./helpers/openclaw-gemini-runtime-image";

const OPENCLAW_RUNTIME_IMAGE =
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:f3f0184b96c208c7d50e5a46171a59a6e371f726b06d41972412c36b427a78d4";
const PLUGIN_INSTALL_PATH = "/usr/local/share/nemoclaw/openclaw-plugins/gemini-inference-compat";
const PLUGIN_SOURCE_PATH = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "openclaw-plugins",
  "gemini-inference-compat",
);
const CONFIG_INSTALL_PATH = "/fixture/openclaw.json";
const ROUTING_PROBE = String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw/dist";
const config = JSON.parse(fs.readFileSync("/fixture/openclaw.json", "utf8"));
const registryFile = fs.readdirSync(distDir).find(
  (entry) =>
    entry.startsWith("plugin-registry-") &&
    entry.endsWith(".js") &&
    fs.readFileSync(path.join(distDir, entry), "utf8").includes("function refreshPluginRegistry("),
);
if (!registryFile) {
  throw new Error("OpenClaw plugin registry module was not found");
}
const registryModule = await import(pathToFileURL(path.join(distDir, registryFile)).href);
const refreshPluginRegistry = Object.values(registryModule).find(
  (value) => typeof value === "function" && value.name === "refreshPluginRegistry",
);
if (typeof refreshPluginRegistry !== "function") {
  throw new Error("OpenClaw plugin registry refresh function was not found");
}
await refreshPluginRegistry({ config, reason: "manual" });

const loader = await import(pathToFileURL(path.join(distDir, "plugins", "loader.js")).href);
if (typeof loader.loadOpenClawPlugins !== "function") {
  throw new Error("OpenClaw plugin loader was not found");
}
const pluginRegistry = loader.loadOpenClawPlugins({
  config,
  cache: false,
  onlyPluginIds: ["nemoclaw-gemini-inference-compat"],
  throwOnLoadError: true,
});
const inspected = pluginRegistry.plugins.find(
  (plugin) => plugin.id === "nemoclaw-gemini-inference-compat",
);
if (!inspected) {
  throw new Error("OpenClaw did not load the Gemini inference compatibility plugin");
}

const resolverFile = fs
  .readdirSync(distDir)
  .find((entry) => entry.startsWith("provider-attribution-") && entry.endsWith(".js"));
if (!resolverFile) {
  throw new Error("OpenClaw provider attribution module was not found");
}
const resolver = await import(pathToFileURL(path.join(distDir, resolverFile)).href);
const describeRouting = Object.values(resolver).find(
  (value) =>
    typeof value === "function" && value.name === "describeProviderRequestRoutingSummary",
);
if (typeof describeRouting !== "function") {
  throw new Error("OpenClaw routing summary function was not found");
}

const transportFile = fs
  .readdirSync(distDir)
  .find((entry) => entry.startsWith("openai-transport-stream-") && entry.endsWith(".js"));
if (!transportFile) {
  throw new Error("OpenClaw Chat Completions transport module was not found");
}
const transport = await import(pathToFileURL(path.join(distDir, transportFile)).href);
const buildCompletionsParams = Object.values(transport).find(
  (value) => typeof value === "function" && value.name === "buildOpenAICompletionsParams",
);
if (typeof buildCompletionsParams !== "function") {
  throw new Error("OpenClaw Chat Completions request builder was not found");
}

const provider = config.models.providers.inference;
const model = {
  ...provider.models[0],
  provider: "inference",
  api: provider.api,
  baseUrl: provider.baseUrl,
};
const toolCallId = "call_managed_gemini_weather";
const request = buildCompletionsParams(
  model,
  {
    systemPrompt: "Use the weather tool.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "What is the weather?" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        api: provider.api,
        provider: "inference",
        model: model.id,
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "weather",
            arguments: { city: "Santa Clara" },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "weather",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
        timestamp: 3,
      },
    ],
  },
  {},
);
const assistantRequest = request.messages.find((message) => message.role === "assistant");
const toolResultRequest = request.messages.find((message) => message.role === "tool");
if (!assistantRequest?.tool_calls?.[0] || !toolResultRequest) {
  throw new Error("OpenClaw did not preserve the tool-call result round");
}

process.stdout.write(
  JSON.stringify({
    pluginStatus: inspected.status,
    routingSummary: describeRouting({
      provider: "inference",
      api: "openai-completions",
      baseUrl: "https://inference.local/v1",
    }),
    toolRoundTrip: {
      thoughtSignature:
        assistantRequest.tool_calls[0].extra_content?.google?.thought_signature,
      toolCallId: assistantRequest.tool_calls[0].id,
      toolResultId: toolResultRequest.tool_call_id,
      toolResultContent: toolResultRequest.content,
    },
  }),
);
`;

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "gemini-3.6-flash",
  NEMOCLAW_PROVIDER_KEY: "inference",
  NEMOCLAW_PRIMARY_MODEL_REF: "inference/gemini-3.6-flash",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
  NEMOCLAW_INFERENCE_API: "openai-completions",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

const dockerProbe = dockerSpawnSync(["info"], { stdio: "ignore", timeout: 15_000 });
const suite = dockerProbe.status === 0 ? describe : describe.skip;

let contextDir: string;
let generatedConfigPath: string;
let stagedPluginPath: string;
let containerUser: string;

function generateConfig(): string {
  const homeDir = path.join(contextDir, "home");
  fs.mkdirSync(homeDir);
  const fakeBinDir = path.join(contextDir, "bin");
  fs.mkdirSync(fakeBinDir);
  fs.writeFileSync(path.join(fakeBinDir, "openclaw"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, BASE_ENV, {
      HOME: homeDir,
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
    });
    main();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }

  return path.join(homeDir, ".openclaw", "openclaw.json");
}

function runPinnedRuntime(entrypoint: string, args: readonly string[]) {
  return dockerSpawnSync(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,source=${stagedPluginPath},target=${PLUGIN_INSTALL_PATH},readonly`,
      "--user",
      containerUser,
      "--mount",
      `type=bind,source=${generatedConfigPath},target=${CONFIG_INSTALL_PATH},readonly`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
      "--env",
      "HOME=/tmp/home",
      "--env",
      `OPENCLAW_CONFIG_PATH=${CONFIG_INSTALL_PATH}`,
      "--entrypoint",
      entrypoint,
      OPENCLAW_RUNTIME_IMAGE,
      ...args,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
}

function parseJsonOutput(output: string): unknown {
  const jsonStart = output.indexOf("{");
  expect(jsonStart, `OpenClaw did not emit JSON: ${output}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(jsonStart));
}

suite("OpenClaw Gemini managed-route runtime compatibility", () => {
  beforeAll(() => {
    contextDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gemini-runtime-"));
    ensureOpenClawGeminiRuntimeImage(OPENCLAW_RUNTIME_IMAGE);
    stagedPluginPath = path.join(contextDir, "plugin");
    fs.cpSync(PLUGIN_SOURCE_PATH, stagedPluginPath, { recursive: true });
    fs.chmodSync(stagedPluginPath, 0o755);
    fs.chmodSync(path.join(stagedPluginPath, "index.ts"), 0o644);
    fs.chmodSync(path.join(stagedPluginPath, "openclaw.plugin.json"), 0o644);
    const pluginStat = fs.statSync(stagedPluginPath);
    containerUser = `${pluginStat.uid}:${pluginStat.gid}`;
    generatedConfigPath = generateConfig();
    fs.chmodSync(generatedConfigPath, 0o444);
  }, OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS + OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS + 10_000);

  afterAll(() => {
    fs.rmSync(contextDir, { recursive: true, force: true });
  });

  it("loads the generated plugin through OpenClaw runtime inspection (#8474)", () => {
    const result = runPinnedRuntime("openclaw", [
      "plugins",
      "inspect",
      "nemoclaw-gemini-inference-compat",
      "--json",
      "--runtime",
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseJsonOutput(String(result.stdout))).toMatchObject({
      plugin: { status: "loaded" },
    });
  }, 70_000);

  it("applies the generated plugin to managed Google routing and tool results (#8474)", () => {
    const result = runPinnedRuntime("node", ["--input-type=module", "-e", ROUTING_PROBE]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({
      pluginStatus: "loaded",
      routingSummary:
        "provider=inference api=openai-completions endpoint=google-generative-ai route=native policy=documented",
      toolRoundTrip: {
        thoughtSignature: "skip_thought_signature_validator",
        toolCallId: "call_managed_gemini_weather",
        toolResultId: "call_managed_gemini_weather",
        toolResultContent: "sunny",
      },
    });
  }, 70_000);
});
