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

function runConfigScript(envOverrides: Record<string, string> = {}): any {
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
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
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
  });

  it("includes only loopback origin for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("parses messaging channels from base64", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
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

  it("sets gateway auth token to empty string", () => {
    const config = runConfigScript();
    expect(config.gateway.auth.token).toBe("");
  });

  it("configures acpx codex to use the preinstalled binary", () => {
    const config = runConfigScript();
    expect(config.plugins.entries.acpx.config.agents.codex.command).toBe(
      "/usr/local/bin/nemoclaw-codex-acp",
    );
  });

  it("disables unused bundled provider plugins with staged runtime deps", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "inference" });
    expect(config.plugins.entries["amazon-bedrock"].enabled).toBe(false);
    expect(config.plugins.entries["amazon-bedrock-mantle"].enabled).toBe(false);
    expect(config.plugins.entries.anthropic.enabled).toBe(false);
    expect(config.plugins.entries["anthropic-vertex"].enabled).toBe(false);
    expect(config.plugins.entries.google.enabled).toBe(false);
  });

  it("keeps the selected bundled provider plugin available", () => {
    const config = runConfigScript({ NEMOCLAW_PROVIDER_KEY: "anthropic" });
    expect(config.plugins.entries.anthropic).toBeUndefined();
    expect(config.plugins.entries.google.enabled).toBe(false);
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
});
