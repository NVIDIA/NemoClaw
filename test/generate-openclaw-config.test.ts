// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for scripts/generate-openclaw-config.py.
// Runs the actual Python script with controlled env vars and asserts on
// the generated openclaw.json output.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.py");

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

function runConfigScriptRaw(envOverrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    ...BASE_ENV,
    ...envOverrides,
    HOME: tmpDir,
  };
  const result = spawnSync("python3", [SCRIPT_PATH], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
  return result;
}

function runConfigScript(envOverrides: Record<string, string> = {}): any {
  const result = runConfigScriptRaw(envOverrides);
  if (result.status !== 0) {
    throw new Error(
      `Script failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeRegistryManifest(
  blueprintDir: string,
  relativeManifestPath: string,
  manifest: Record<string, unknown>,
): string {
  const manifestPath = path.join(blueprintDir, "model-specific-setup", relativeManifestPath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return path.join(blueprintDir, "model-specific-setup");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Extraction — behavior-preserving tests
// ═══════════════════════════════════════════════════════════════════
describe("generate-openclaw-config.py: config generation", () => {
  it("generates valid JSON with minimal env vars", () => {
    const config = runConfigScript();
    expect(config).toBeDefined();
    expect(config.gateway).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.agents).toBeDefined();
  });

  it("sets dangerouslyDisableDeviceAuth to false for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("sets dangerouslyDisableDeviceAuth to true when env var is '1'", () => {
    const config = runConfigScript({ NEMOCLAW_DISABLE_DEVICE_AUTH: "1" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("sets allowInsecureAuth to true for http scheme", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);
  });

  it("sets allowInsecureAuth to false for https scheme", () => {
    const config = runConfigScript({ CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789" });
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(false);
  });

  it("includes non-loopback origin in allowedOrigins", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
    });
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://127.0.0.1:18789");
    expect(config.gateway.controlUi.allowedOrigins).toContain(
      "https://nemoclaw0-xxx.brevlab.com:18789",
    );
    expect(config.gateway.controlUi.allowedOrigins).toContain(
      "https://nemoclaw0-xxx.brevlab.com",
    );
  });

  it("includes only loopback origin for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("includes portless origin for reverse-proxy access (Fixes #3000)", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-abc123.brevlab.com:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("https://nemoclaw0-abc123.brevlab.com:18789");
    expect(origins).toContain("https://nemoclaw0-abc123.brevlab.com");
  });

  it("preserves brackets in portless origin for public IPv6 addresses", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://[2606:4700::1]:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("https://[2606:4700::1]:18789");
    expect(origins).toContain("https://[2606:4700::1]");
  });

  it("does not add portless origin for IPv6 loopback", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://[::1]:18789",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("http://[::1]:18789");
    expect(origins).not.toContain("http://[::1]");
  });

  it("does not crash on malformed port in CHAT_UI_URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://example.com:abc",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("http://127.0.0.1:18789");
    expect(origins).not.toContain("https://example.com");
  });

  it("parses messaging channels from base64", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
  });

  it("emits groups with requireMention when TELEGRAM_REQUIRE_MENTION is true (#3022)", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const telegramConfig = Buffer.from(JSON.stringify({ requireMention: true })).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_TELEGRAM_CONFIG_B64: telegramConfig,
    });
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toEqual({ "*": { requireMention: true } });
  });

  it("keeps groupPolicy open with no groups stanza when requireMention is false (#3022)", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const telegramConfig = Buffer.from(JSON.stringify({ requireMention: false })).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_TELEGRAM_CONFIG_B64: telegramConfig,
    });
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toBeUndefined();
  });

  it("defaults Telegram groupPolicy to 'open' with no groups stanza when telegramConfig is empty (#3022)", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
    });
    expect(config.channels.telegram.accounts.default.groupPolicy).toBe("open");
    expect(config.channels.telegram.groups).toBeUndefined();
  });

  it("emits canonical openshell:resolve:env: placeholders for non-Slack channels", () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(config.channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
  });

  it("emits Bolt-shape placeholders for Slack so the SDK's prefix regex passes", () => {
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    const slack = config.channels.slack.accounts.default;
    // Bolt validates ^xoxb-[A-Za-z0-9_-]+$ / ^xapp-…$ at App construction.
    // The slack-token-rewriter preload translates these to canonical form
    // before egress, where OpenShell's L7 proxy substitutes the real token.
    expect(slack.botToken).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    expect(slack.appToken).toBe("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");
    expect(slack.botToken).toMatch(/^xoxb-[A-Za-z0-9_-]+$/);
    expect(slack.appToken).toMatch(/^xapp-[A-Za-z0-9_-]+$/);
  });

  it("enables web search when env is '1'", () => {
    const config = runConfigScript({ NEMOCLAW_WEB_SEARCH_ENABLED: "1" });
    expect(config.tools?.web?.search?.enabled).toBe(true);
  });

  it("omits web search when env is not set", () => {
    const config = runConfigScript();
    expect(config.tools?.web).toBeUndefined();
  });

  it("propagates agent timeout", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_TIMEOUT: "300" });
    expect(config.agents.defaults.timeoutSeconds).toBe(300);
  });

  it("disables OpenClaw first-run workspace bootstrap", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.skipBootstrap).toBe(true);
  });

  it("disables inferred thinking for first-turn sandbox replies", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.thinkingDefault).toBe("off");
  });

  it("keeps compatible endpoints on the managed inference.local OpenClaw provider", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "deepseek-ai/DeepSeek-V4-Flash",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/deepseek-ai/DeepSeek-V4-Flash",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(JSON.stringify({ supportsStore: false })).toString(
        "base64",
      ),
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.baseUrl).toBe("https://inference.local/v1");
    expect(config.models.providers.inference.apiKey).toBe("unused");
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "deepseek-ai/DeepSeek-V4-Flash",
      name: "inference/deepseek-ai/DeepSeek-V4-Flash",
      compat: { supportsStore: false },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/deepseek-ai/DeepSeek-V4-Flash");
    expect(config.models.providers.deepinfra).toBeUndefined();
  });

  it("adds Kimi K2.6 compat for managed inference.local chat completions", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(JSON.stringify({ supportsStore: false })).toString(
        "base64",
      ),
    });

    expect(config.models.providers.inference.models[0].compat).toEqual({
      supportsStore: false,
      requiresStringContent: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    });
    expect(config.plugins.entries["nemoclaw-kimi-inference-compat"]).toEqual({
      enabled: true,
    });
    expect(config.plugins.load.paths).toEqual([
      "/usr/local/share/nemoclaw/openclaw-plugins/kimi-inference-compat",
    ]);
  });

  it("adds registry compat when the incoming compat blob is null", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("null").toString("base64"),
    });

    expect(config.models.providers.inference.models[0].compat).toEqual({
      requiresStringContent: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: true,
    });
  });

  it("does not activate the OpenClaw Kimi setup for non-matching routes", () => {
    const cases = [
      { NEMOCLAW_MODEL: "deepseek-ai/DeepSeek-V4-Flash" },
      { NEMOCLAW_PROVIDER_KEY: "openai" },
      { NEMOCLAW_INFERENCE_API: "responses" },
      { NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1" },
    ];

    for (const envCase of cases) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "moonshotai/kimi-k2.6",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/moonshotai/kimi-k2.6",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
          JSON.stringify({ supportsStore: false }),
        ).toString("base64"),
        ...envCase,
      });

      const providerConfig = Object.values(config.models.providers)[0] as any;
      expect(providerConfig.models[0].compat).toEqual({ supportsStore: false });
      expect(config.plugins.entries["nemoclaw-kimi-inference-compat"]).toBeUndefined();
      expect(config.plugins.load).toBeUndefined();
    }
  });

  it("rejects model-specific setup manifests without a known agent", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/missing-agent.json",
      {
        id: "missing-agent",
        description: "Invalid manifest",
        match: { modelIds: ["test-model"] },
        effects: { openclawCompat: {} },
      },
    );

    const result = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("field 'agent' is required");

    const unknownRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/unknown-agent.json",
      {
        id: "unknown-agent",
        agent: "sidecar",
        description: "Invalid manifest",
        match: { modelIds: ["test-model"] },
        effects: { openclawCompat: {} },
      },
    );
    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-agent.json"));

    const unknownResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: unknownRegistryDir,
    });

    expect(unknownResult.status).not.toBe(0);
    expect(unknownResult.stderr).toContain("unknown agent 'sidecar'");
  });

  it("rejects empty match objects and invalid explicit registry overrides", () => {
    const missingRegistry = path.join(tmpDir, "missing-registry");
    const missingRegistryResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingRegistry,
    });

    expect(missingRegistryResult.status).not.toBe(0);
    expect(missingRegistryResult.stderr).toContain(
      "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory",
    );

    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/empty-match.json",
      {
        id: "empty-match",
        agent: "openclaw",
        description: "Invalid match",
        match: {},
        effects: { openclawCompat: {} },
      },
    );

    const emptyMatchResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(emptyMatchResult.status).not.toBe(0);
    expect(emptyMatchResult.stderr).toContain("field 'match' must be a non-empty object");
  });

  it("rejects unknown OpenClaw effect keys and missing plugin source paths", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/bad-effect.json",
      {
        id: "bad-effect",
        agent: "openclaw",
        description: "Invalid OpenClaw effect",
        match: { modelIds: ["test-model"] },
        effects: { hermesCompat: {} },
      },
    );

    const result = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown effects for agent 'openclaw': hermesCompat");

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "bad-effect.json"));
    const missingPluginRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/missing-plugin.json",
      {
        id: "missing-plugin",
        agent: "openclaw",
        description: "Invalid plugin path",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawPlugins: [
            {
              id: "missing-openclaw-plugin",
              path: "openclaw-plugins/missing",
              loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/missing",
            },
          ],
        },
      },
    );

    const missingPluginResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingPluginRegistryDir,
    });

    expect(missingPluginResult.status).not.toBe(0);
    expect(missingPluginResult.stderr).toContain("path does not exist");

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-plugin.json"));
    fs.mkdirSync(path.join(blueprintDir, "openclaw-plugins", "fixture"), { recursive: true });
    const badLoadPathRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/bad-load-path.json",
      {
        id: "bad-load-path",
        agent: "openclaw",
        description: "Invalid plugin load path",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawPlugins: [
            {
              id: "fixture-plugin",
              path: "openclaw-plugins/fixture",
              loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/wrong",
            },
          ],
        },
      },
    );

    const badLoadPathResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: badLoadPathRegistryDir,
    });

    expect(badLoadPathResult.status).not.toBe(0);
    expect(badLoadPathResult.stderr).toContain(
      "effects.openclawPlugins[0].loadPath must be " +
        "'/usr/local/share/nemoclaw/openclaw-plugins/fixture'",
    );
  });

  it("rejects conflicting OpenClaw compat effects and duplicate plugin ids", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    fs.mkdirSync(path.join(blueprintDir, "openclaw-plugins", "fixture"), { recursive: true });
    const registryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/conflicting-compat.json",
      {
        id: "conflicting-compat",
        agent: "openclaw",
        description: "Conflicting compat",
        match: { modelIds: ["test-model"] },
        effects: {
          openclawCompat: {
            supportsStore: true,
          },
        },
      },
    );

    const conflictResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
        JSON.stringify({ supportsStore: false }),
      ).toString("base64"),
    });

    expect(conflictResult.status).not.toBe(0);
    expect(conflictResult.stderr).toContain(
      "model-specific setup 'conflicting-compat' conflicts with inference compat key 'supportsStore'",
    );

    fs.rmSync(
      path.join(blueprintDir, "model-specific-setup", "openclaw", "conflicting-compat.json"),
    );
    writeRegistryManifest(blueprintDir, "openclaw/plugin-a.json", {
      id: "plugin-a",
      agent: "openclaw",
      description: "First plugin",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawPlugins: [
          {
            id: "fixture-plugin",
            path: "openclaw-plugins/fixture",
            loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
          },
        ],
      },
    });
    writeRegistryManifest(blueprintDir, "openclaw/plugin-b.json", {
      id: "plugin-b",
      agent: "openclaw",
      description: "Duplicate plugin",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawPlugins: [
          {
            id: "fixture-plugin",
            path: "openclaw-plugins/fixture",
            loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
          },
        ],
      },
    });

    const duplicateResult = runConfigScriptRaw({
      NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
    });

    expect(duplicateResult.status).not.toBe(0);
    expect(duplicateResult.stderr).toContain(
      "model-specific setup 'plugin-b' declares duplicate OpenClaw plugin 'fixture-plugin'",
    );
  });

  it("sets gateway auth token to empty string", () => {
    const config = runConfigScript();
    expect(config.gateway.auth.token).toBe("");
  });

  it("disables bundled acpx runtime staging by default", () => {
    const config = runConfigScript();
    expect(config.plugins.entries.acpx.enabled).toBe(false);
    expect(config.plugins.entries.acpx.config).toBeUndefined();
  });

  it("disables unused bundled provider plugins with staged runtime deps", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "inference" });
    expect(config.plugins.entries["amazon-bedrock"].enabled).toBe(false);
    expect(config.plugins.entries["amazon-bedrock-mantle"].enabled).toBe(false);
    expect(config.plugins.entries.anthropic.enabled).toBe(false);
    expect(config.plugins.entries["anthropic-vertex"].enabled).toBe(false);
    expect(config.plugins.entries.fireworks.enabled).toBe(false);
    expect(config.plugins.entries.google.enabled).toBe(false);
    expect(config.plugins.entries.kimi.enabled).toBe(false);
    expect(config.plugins.entries.lmstudio.enabled).toBe(false);
    expect(config.plugins.entries.ollama.enabled).toBe(false);
    expect(config.plugins.entries.openai.enabled).toBe(false);
    expect(config.plugins.entries.xai.enabled).toBe(false);
  });

  it("keeps the selected bundled provider plugin available", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "anthropic" });
    expect(config.plugins.entries.anthropic).toBeUndefined();
    expect(config.plugins.entries.google.enabled).toBe(false);
  });

  it("keeps the selected OpenAI bundled provider plugin available", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "openai" });
    expect(config.plugins.entries.openai).toBeUndefined();
    expect(config.plugins.entries.xai.enabled).toBe(false);
  });

  it("creates file with 0600 permissions", () => {
    runConfigScript();
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const stats = fs.statSync(configPath);
    // 0o600 = owner read/write only (octal 600 = decimal 384)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Auto-disable device auth for non-loopback URLs
// ═══════════════════════════════════════════════════════════════════
describe("generate-openclaw-config.py: non-loopback auto-disable device auth", () => {
  it("auto-disables device auth for Brev Launchable URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("auto-disables device auth for any non-loopback URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://my-server.local:18789",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("keeps device auth enabled for 127.0.0.1", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("keeps device auth enabled for localhost", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://localhost:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("keeps device auth enabled for IPv6 loopback", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://[::1]:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("honors explicit env var override on loopback URL", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "http://127.0.0.1:18789",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "1",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });

  it("URL trumps env var — cannot re-enable device auth for non-loopback", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
      NEMOCLAW_DISABLE_DEVICE_AUTH: "0",
    });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
  });
});

describe("generate-openclaw-config.py: empty-string env vars fall back to defaults", () => {
  it("treats empty CHAT_UI_URL as unset and uses the loopback default", () => {
    const config = runConfigScript({ CHAT_UI_URL: "" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("treats empty NEMOCLAW_PROXY_HOST as unset and uses the documented default", () => {
    const channelB64 = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const cfg = runConfigScript({
      NEMOCLAW_PROXY_HOST: "",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelB64,
    });
    expect(cfg.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("treats empty NEMOCLAW_PROXY_PORT as unset and uses the documented default", () => {
    const channelB64 = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const cfg = runConfigScript({
      NEMOCLAW_PROXY_PORT: "",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelB64,
    });
    expect(cfg.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("treats empty NEMOCLAW_CONTEXT_WINDOW as unset and uses the documented default", () => {
    const cfg = runConfigScript({ NEMOCLAW_CONTEXT_WINDOW: "" });
    expect(cfg.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
  });

  it("treats empty NEMOCLAW_MAX_TOKENS as unset and uses the documented default", () => {
    const cfg = runConfigScript({ NEMOCLAW_MAX_TOKENS: "" });
    expect(cfg.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
  });
});

describe("generate-openclaw-config.py: numeric env var validation", () => {
  function runCapturingStderr(envOverrides: Record<string, string>): {
    config: any;
    stderr: string;
  } {
    const env: Record<string, string> = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...BASE_ENV,
      ...envOverrides,
      HOME: tmpDir,
    };
    const result = spawnSync("python3", [SCRIPT_PATH], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 10_000,
    });
    if (result.status !== 0) {
      throw new Error(
        `Script failed (exit ${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    return {
      config: JSON.parse(fs.readFileSync(configPath, "utf-8")),
      stderr: result.stderr,
    };
  }

  it("skips non-numeric NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "notanumber" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_CONTEXT_WINDOW must be a positive integer, got "notanumber"/,
    );
  });

  it("skips non-numeric NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "notanumber" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_MAX_TOKENS must be a positive integer, got "notanumber"/,
    );
  });

  it("skips zero NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "0" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips zero NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "0" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });

  it("skips negative NEMOCLAW_CONTEXT_WINDOW and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "-1" });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips negative NEMOCLAW_MAX_TOKENS and falls back to the default", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "-1" });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });

  it("skips NEMOCLAW_CONTEXT_WINDOW that exceeds Python's int-string digit limit", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips NEMOCLAW_MAX_TOKENS that exceeds Python's int-string digit limit", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });
});
