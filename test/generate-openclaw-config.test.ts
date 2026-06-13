// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for scripts/generate-openclaw-config.mts.
// Runs the actual TypeScript script with controlled env vars and asserts on
// the generated openclaw.json output.

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

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "generate-openclaw-config.mts");
const SCRIPT_ARGS = ["--experimental-strip-types", SCRIPT_PATH];
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

function runConfigScriptRaw(envOverrides: Record<string, string> = {}) {
  const env = buildTestEnv(envOverrides);
  const result = spawnSync("node", SCRIPT_ARGS, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
  return result;
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

function withConfigEnv<T>(envOverrides: Record<string, string>, fn: () => T): T {
  return withEnv(buildTestEnv(envOverrides), fn);
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

function runConfigSubprocess(envOverrides: Record<string, string> = {}): any {
  const env = buildTestEnv(envOverrides);
  const result = spawnSync("node", SCRIPT_ARGS, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Script failed (exit ${result.status}):
stdout: ${result.stdout}
stderr: ${result.stderr}`,
    );
  }
  runMessagingPostInstall(env);

  const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function buildBaseConfigDirect(envOverrides: Record<string, string> = {}): any {
  return withConfigEnv(envOverrides, () => buildConfig());
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

function runCapturingConsoleError<T>(fn: () => T): { result: T; stderr: string } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), stderr: messages.join("\n") };
  } finally {
    console.error = original;
  }
}

function writeWeChatPluginMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(tmpDir, ".openclaw", "extensions", "openclaw-weixin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeWeChatNpmPackageMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(
    tmpDir,
    ".openclaw",
    "npm",
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify(manifest, null, 2));
}

function writeWeChatNpmPluginMetadata(manifest: Record<string, unknown>) {
  const pluginDir = path.join(
    tmpDir,
    ".openclaw",
    "npm",
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2));
}

function wechatExtensionPath(stateDir = path.join(tmpDir, ".openclaw")) {
  return path.join(fs.realpathSync(stateDir), "extensions", "openclaw-weixin");
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

describe("generate-openclaw-config.mts: config generation", () => {
  it("generates valid JSON with minimal env vars", () => {
    const config = runConfigScript();
    expect(config).toBeDefined();
    expect(config.gateway).toBeDefined();
    expect(config.models).toBeDefined();
    expect(config.agents).toBeDefined();
  });

  it("runs as a node --experimental-strip-types executable", () => {
    const config = runConfigSubprocess();
    expect(config.gateway).toBeDefined();
    expect(config.models).toBeDefined();
  });

  it("keeps OpenClaw OTEL diagnostics disabled by default", () => {
    const config = runConfigScript();
    expect(config.diagnostics).toBeUndefined();
    expect(config.plugins.entries["diagnostics-otel"]).toBeUndefined();
  });

  it("enables traces-only OpenClaw OTEL diagnostics when requested", () => {
    const config = buildConfigDirect({
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
      NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "nemoclaw-local",
      NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
    });

    expect(config.plugins.entries["diagnostics-otel"]).toEqual({ enabled: true });
    expect(config.diagnostics).toEqual({
      enabled: true,
      otel: {
        enabled: true,
        endpoint: "http://host.openshell.internal:4318",
        protocol: "http/protobuf",
        serviceName: "nemoclaw-local",
        traces: true,
        metrics: false,
        logs: false,
        sampleRate: 0.5,
      },
    });
    expect(config.diagnostics.otel.captureContent).toBeUndefined();
  });

  it("rejects OTEL endpoints with embedded credentials", () => {
    const result = runConfigScriptRaw({
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://token@example.com:4318",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT must not include credentials");
  });

  it("sets dangerouslyDisableDeviceAuth to false for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(false);
  });

  it("treats loopback-looking URL userinfo before a remote host as remote", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://127.0.0.1:18789@evil.example" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://evil.example");
    expect(config.gateway.controlUi.allowedOrigins).not.toContain(
      "http://127.0.0.1:18789@evil.example",
    );
  });

  it("treats localhost userinfo before a remote host as remote", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://localhost@evil.example" });
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://evil.example");
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

  it("falls back to text input when NEMOCLAW_INFERENCE_INPUTS is empty", () => {
    const config = runConfigScript({ NEMOCLAW_INFERENCE_INPUTS: "" });
    expect(config.models.providers["test-provider"].models[0].input).toEqual(["text"]);
  });

  it("includes non-loopback origin in allowedOrigins", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "https://nemoclaw0-xxx.brevlab.com:18789",
    });
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://127.0.0.1:18789");
    expect(config.gateway.controlUi.allowedOrigins).toContain(
      "https://nemoclaw0-xxx.brevlab.com:18789",
    );
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://nemoclaw0-xxx.brevlab.com");
  });

  it("includes only loopback origin for loopback URL", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18789" });
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });

  it("#3256: emits gateway.port from a non-default CHAT_UI_URL port", () => {
    const config = runConfigScript({ CHAT_UI_URL: "http://127.0.0.1:18790" });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18790"]);
  });

  it("#3256: lets NEMOCLAW_DASHBOARD_PORT drive gateway.port when set", () => {
    const config = runConfigScript({
      CHAT_UI_URL: "",
      NEMOCLAW_DASHBOARD_PORT: "18790",
    });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18790"]);
  });

  it("rejects an invalid NEMOCLAW_DASHBOARD_PORT", () => {
    expectBuildConfigError(
      { NEMOCLAW_DASHBOARD_PORT: "18790x" },
      /NEMOCLAW_DASHBOARD_PORT.*1024 and 65535/,
    );
  });

  it("rejects an out-of-range NEMOCLAW_DASHBOARD_PORT", () => {
    expectBuildConfigError(
      { NEMOCLAW_DASHBOARD_PORT: "80" },
      /NEMOCLAW_DASHBOARD_PORT.*1024 and 65535/,
    );
  });

  it("falls back to the default gateway port when CHAT_UI_URL uses a reserved port", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "http://127.0.0.1:81" });
    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      "http://127.0.0.1:18789",
      "http://127.0.0.1:81",
    ]);
  });

  it("normalizes schemeless CHAT_UI_URL values before parsing", () => {
    const config = buildConfigDirect({ CHAT_UI_URL: "remote.example:18790" });
    expect(config.gateway.port).toBe(18790);
    expect(config.gateway.controlUi.dangerouslyDisableDeviceAuth).toBe(true);
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://remote.example:18790");
    expect(config.gateway.controlUi.allowedOrigins).toContain("http://remote.example");
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
      CHAT_UI_URL: "https://ilinkai.wechat.com.com:abc",
    });
    const origins = config.gateway.controlUi.allowedOrigins;
    expect(origins).toContain("http://127.0.0.1:18789");
    expect(origins).not.toContain("https://ilinkai.wechat.com.com");
  });

  it("leaves messaging render to the messaging build applier", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = buildBaseConfigDirect({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.telegram).toBeUndefined();
  });

  it("parses messaging channels from base64", () => {
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels).toBeDefined();
    expect(config.channels.telegram).toBeDefined();
  });

  it("emits a tokenless WhatsApp config block for QR-paired channels", () => {
    const channels = Buffer.from(JSON.stringify(["whatsapp"])).toString("base64");
    const config = buildConfigDirect({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.whatsapp).toBeDefined();
    expect(config.channels.whatsapp.enabled).toBe(true);
    expect(config.plugins.entries.whatsapp).toEqual({ enabled: true });
    const account = config.channels.whatsapp.accounts.default;
    expect(account.enabled).toBe(true);
    expect(account.healthMonitor).toEqual({ enabled: false });
    expect(account.token).toBeUndefined();
    expect(account.botToken).toBeUndefined();
    expect(account.appToken).toBeUndefined();
  });

  it("keeps WhatsApp config alongside token-based channels in the same run", () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "whatsapp"])).toString("base64");
    const config = buildConfigDirect({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.plugins.entries.telegram).toEqual({ enabled: true });
    expect(config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(config.channels.whatsapp.enabled).toBe(true);
    expect(config.plugins.entries.whatsapp).toEqual({ enabled: true });
    expect(config.channels.whatsapp.accounts.default.enabled).toBe(true);
    expect(config.channels.whatsapp.accounts.default.botToken).toBeUndefined();
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
    const telegramConfig = Buffer.from(JSON.stringify({ requireMention: false })).toString(
      "base64",
    );
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

  it("emits OpenClaw-valid Discord guild allowlist config when guilds are provided", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const legacyGuilds = { "1234567890": { enabled: true, requireMention: true } };
    const config = buildConfigDirect({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_DISCORD_GUILDS_B64: Buffer.from(JSON.stringify(legacyGuilds)).toString("base64"),
    });

    expect(config.channels.discord.groupPolicy).toBe("allowlist");
    expect(config.channels.discord.guilds).toEqual({
      "1234567890": { requireMention: true },
    });
    expect(config.channels.discord.guilds["1234567890"].enabled).toBeUndefined();
  });

  it("applies WeChat post-agent-install build-file outputs through the messaging applier", () => {
    const channels = Buffer.from(JSON.stringify(["wechat"])).toString("base64");
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
    });

    expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual({
      source: "npm",
      spec: "@tencent-weixin/openclaw-weixin@2.4.3",
      installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
    });
    expect(config.plugins?.load?.paths ?? []).not.toContain(
      "/sandbox/.openclaw/extensions/openclaw-weixin",
    );
    expect(config.plugins?.entries?.["openclaw-weixin"]?.enabled).toBe(true);
    expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
    expect(config.channels?.wechat).toBeUndefined();
  });

  it("omits channels.openclaw-weixin when no accountId was captured", () => {
    // No QR-login result → seed step bails on the empty accountId and
    // leaves openclaw.json untouched, so the bridge stays dormant.
    const channels = Buffer.from(JSON.stringify(["wechat"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels?.["openclaw-weixin"]).toBeUndefined();
    expect(config.channels?.wechat).toBeUndefined();
  });

  it("omits the openclaw-weixin plugin entry until WeChat is active", () => {
    const config = runConfigScript({});
    expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
  });

  it("preserves existing plugin install registry entries without enabling WeChat", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const installEntry = {
      source: "npm",
      spec: "@tencent-weixin/openclaw-weixin@2.4.3",
    };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: { installs: { "openclaw-weixin": installEntry } } }),
    );

    const config = runConfigScript({});

    expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual(installEntry);
    expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
  });

  it("ignores malformed existing plugin install registries while regenerating config", () => {
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    for (const existing of [null, { plugins: null }, { plugins: { installs: {} } }]) {
      fs.writeFileSync(configPath, JSON.stringify(existing));
      const config = runConfigScript();
      expect(config.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
      expect(config.plugins?.installs).toBeUndefined();
    }
  });

  it("emits canonical placeholders and proxy routing for non-Slack channels", () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.proxy).toMatchObject({
      enabled: true,
      proxyUrl: "http://10.200.0.1:3128",
      loopbackMode: "gateway-only",
    });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.plugins.entries.telegram).toEqual({ enabled: true });
    expect(config.channels.discord.enabled).toBe(true);
    expect(config.plugins.entries.discord).toEqual({ enabled: true });
    expect(config.channels.telegram.accounts.default.botToken).toBe(
      "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    );
    expect(config.channels.discord.accounts.default.token).toBe(
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
    );
    expect(config.channels.telegram.accounts.default.proxy).toBe("http://10.200.0.1:3128");
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("#3894: routes Discord gateway traffic through the per-account proxy", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_PROXY_HOST: "10.201.0.9",
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy).toEqual({
      enabled: true,
      proxyUrl: "http://10.201.0.9:43128",
      loopbackMode: "gateway-only",
    });
    expect(config.channels.discord.accounts.default).toMatchObject({
      token: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      enabled: true,
    });
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.201.0.9:43128");
  });

  it("writes the Discord account proxy alongside the managed proxy", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.200.0.1:43128");
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.200.0.1:43128");
  });

  it("can defer OpenClaw managed proxy config for build-time doctor", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
    });

    expect(config.proxy).toBeUndefined();
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("ignores the OpenShell loopback proxy env var when using OpenClaw managed proxy", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      OPENSHELL_LOOPBACK_PROXY_URL: "http://127.0.0.1:45211",
      NEMOCLAW_DISCORD_PROXY_PORT: "43129",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.200.0.1:3128");
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.200.0.1:3128");
  });

  it("routes both Telegram and Discord through the per-account proxy", () => {
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_PROXY_HOST: "10.201.0.9",
      NEMOCLAW_PROXY_PORT: "43128",
    });

    expect(config.proxy.proxyUrl).toBe("http://10.201.0.9:43128");
    expect(config.channels.telegram.accounts.default.proxy).toBe("http://10.201.0.9:43128");
    expect(config.channels.discord.accounts.default.proxy).toBe("http://10.201.0.9:43128");
  });

  it("emits Bolt-shape placeholders for Slack so the SDK's prefix regex passes", () => {
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.plugins.entries.slack).toEqual({ enabled: true });
    const slack = config.channels.slack.accounts.default;
    // Bolt validates ^xoxb-[A-Za-z0-9_-]+$ / ^xapp-…$ at App construction.
    // OpenShell resolves these provider-shaped aliases at the egress boundary.
    expect(slack.botToken).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    expect(slack.appToken).toBe("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");
    expect(slack.botToken).toMatch(/^xoxb-[A-Za-z0-9_-]+$/);
    expect(slack.appToken).toMatch(/^xapp-[A-Za-z0-9_-]+$/);
  });

  it("marks Telegram and Discord channels enabled so OpenClaw loads the bridges (#4314, #4390)", () => {
    // Regression: OpenClaw 2026.5.22 no longer auto-starts a channel bridge
    // from the account-level enabled flag alone. The Slack mitigation in
    // PR #4222 added `channels.slack.enabled: true`; #4314 / #4390 reported
    // the same silent failure for Telegram, and the symptom matches Discord
    // too. Bake the top-level enabled marker for every credential-backed
    // messaging channel.
    const channels = Buffer.from(JSON.stringify(["telegram", "discord"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.discord.enabled).toBe(true);
    expect(config.channels.telegram.accounts.default.enabled).toBe(true);
    expect(config.channels.discord.accounts.default.enabled).toBe(true);
  });

  it("uses Telegram allowed IDs for direct-message allowlisting (#4553)", () => {
    const allowedUsers = ["8388960805", "8388960806"];
    const channels = Buffer.from(JSON.stringify(["telegram"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ telegram: allowedUsers })).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
    });
    const telegram = config.channels.telegram.accounts.default;

    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.plugins.entries.telegram).toEqual({ enabled: true });
    expect(telegram.dmPolicy).toBe("allowlist");
    expect(telegram.allowFrom).toEqual(allowedUsers);
  });

  it("uses Slack allowed IDs for DMs and channel mention allowlisting (#3729)", () => {
    const allowedUsers = ["U01ABC2DEF3", "U04GHI5JKL6"];
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ slack: allowedUsers })).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
    });
    const slack = config.channels.slack.accounts.default;

    expect(config.channels.slack.enabled).toBe(true);
    expect(config.plugins.entries.slack).toEqual({ enabled: true });
    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(allowedUsers);
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.channels).toEqual({
      "*": {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
    });
  });

  it("uses Slack allowed channels to scope channel @mentions", () => {
    const allowedUsers = ["U01ABC2DEF3", "U04GHI5JKL6"];
    const allowedChannels = ["C012AB3CD", "C987ZY6XW"];
    const channels = Buffer.from(JSON.stringify(["slack"])).toString("base64");
    const allowedIds = Buffer.from(JSON.stringify({ slack: allowedUsers })).toString("base64");
    const slackConfig = Buffer.from(JSON.stringify({ allowedChannels })).toString("base64");
    const config = runConfigScript({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
      NEMOCLAW_MESSAGING_ALLOWED_IDS_B64: allowedIds,
      NEMOCLAW_SLACK_CONFIG_B64: slackConfig,
    });
    const slack = config.channels.slack.accounts.default;

    expect(slack.dmPolicy).toBe("allowlist");
    expect(slack.allowFrom).toEqual(allowedUsers);
    expect(slack.groupPolicy).toBe("allowlist");
    expect(slack.channels).toEqual({
      C012AB3CD: {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
      C987ZY6XW: {
        enabled: true,
        requireMention: true,
        users: allowedUsers,
      },
    });
  });

  it("enables native OpenClaw Tool Search by default", () => {
    const config = runConfigScript();
    expect(config.tools?.toolSearch).toBe(true);
  });

  it("enables keyless web_fetch through the trusted env proxy by default", () => {
    const config = runConfigScript();
    expect(config.tools?.web?.fetch).toEqual({
      enabled: true,
      useTrustedEnvProxy: true,
    });
    expect(config.tools?.web?.search).toBeUndefined();
  });

  it("enables web search when env is '1' using the current plugin schema", () => {
    const config = runConfigScript({ NEMOCLAW_WEB_SEARCH_ENABLED: "1" });
    expect(config.tools?.toolSearch).toBe(true);
    // #5266: apiKey lives under plugins.entries.brave.config (not inline on
    // tools.web.search) so build-time `openclaw plugins install` validates.
    expect(config.tools?.web?.search).toEqual({ enabled: true, provider: "brave" });
    expect(config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:BRAVE_API_KEY" } },
    });
    expect(config.tools?.web?.fetch).toEqual({ enabled: true, useTrustedEnvProxy: true });
  });

  it("omits web search when env is not set", () => {
    const config = runConfigScript();
    expect(config.tools?.toolSearch).toBe(true);
    expect(config.tools?.web?.search).toBeUndefined();
  });

  it("propagates agent timeout", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_TIMEOUT: "300" });
    expect(config.agents.defaults.timeoutSeconds).toBe(300);
  });

  it("rejects invalid agent timeout values", () => {
    expectBuildConfigError(
      { NEMOCLAW_AGENT_TIMEOUT: "forever" },
      "NEMOCLAW_AGENT_TIMEOUT must be a positive integer",
    );
  });

  it("omits heartbeat when NEMOCLAW_AGENT_HEARTBEAT_EVERY is unset", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("omits heartbeat when NEMOCLAW_AGENT_HEARTBEAT_EVERY is the empty string", () => {
    // Docker promotes the unset ARG to an empty ENV value rather than dropping
    // the variable, so the build path almost always sees "" rather than undefined.
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "" });
    expect(config.agents.defaults.heartbeat).toBeUndefined();
  });

  it("propagates heartbeat cadence into agents.defaults.heartbeat.every", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m" });
    expect(config.agents.defaults.heartbeat).toEqual({ every: "30m" });
  });

  it("disables heartbeat when set to 0m (NemoClaw#2880)", () => {
    const config = runConfigScript({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "0m" });
    expect(config.agents.defaults.heartbeat).toEqual({ every: "0m" });
  });

  it("rejects malformed heartbeat values, preserves OpenClaw default, and warns on stderr", () => {
    const { result: config, stderr } = runCapturingConsoleError(() =>
      buildConfigDirect({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "5 minutes" }),
    );
    expect(config.agents.defaults.heartbeat).toBeUndefined();
    expect(stderr).toMatch(
      /\[SECURITY\] NEMOCLAW_AGENT_HEARTBEAT_EVERY must match \^\\d\+\(s\|m\|h\)\$, got "5 minutes"/,
    );
  });

  it("disables OpenClaw first-run workspace bootstrap", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.skipBootstrap).toBe(true);
  });

  it("disables inferred thinking for first-turn sandbox replies", () => {
    const config = runConfigScript();
    expect(config.agents.defaults.thinkingDefault).toBe("off");
  });

  // ─── agents.list bake ─────────────────────────────────────────────────────
  // Even with no NEMOCLAW_EXTRA_AGENTS_JSON_B64 set, agents.list must exist
  // with the canonical main entry pinned as default. Otherwise a wholesale
  // list overwrite could leave OpenClaw resolving default to agents[0]
  // without "main" present.

  const TOOLS_OK = { profile: "minimal", allow: ["read"], deny: ["exec"] };
  const SUBAGENTS_OK = { maxSpawnDepth: 0 };

  function makeExtra(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "research",
      workspace: "/sandbox/.openclaw/workspace-research",
      agentDir: "/sandbox/.openclaw/agents/research",
      tools: TOOLS_OK,
      subagents: SUBAGENTS_OK,
      ...overrides,
    };
  }

  function extraAgentsB64(extras: unknown): string {
    return Buffer.from(JSON.stringify(extras)).toString("base64");
  }

  it("always writes agents.list with a default 'main' entry first", () => {
    const config = runConfigScript();
    expect(Array.isArray(config.agents.list)).toBe(true);
    expect(config.agents.list).toHaveLength(1);
    expect(config.agents.list[0]).toEqual({ id: "main", default: true });
  });

  it("appends NEMOCLAW_EXTRA_AGENTS_JSON_B64 entries after main", () => {
    const extras = [
      makeExtra({ id: "research" }),
      makeExtra({
        id: "writing",
        workspace: "/sandbox/.openclaw/workspace-writing",
        agentDir: "/sandbox/.openclaw/agents/writing",
      }),
    ];
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64(extras),
    });
    expect(config.agents.list).toHaveLength(3);
    expect(config.agents.list[0]).toEqual({ id: "main", default: true });
    expect(config.agents.list[1]).toMatchObject({ id: "research" });
    expect(config.agents.list[2]).toMatchObject({ id: "writing" });
  });

  it("keeps 'main' as the default even when extras are present", () => {
    // Wholesale list replacement would leave agents[0] = first extra, so
    // resolveDefaultAgentId would silently re-elect the first extra as
    // default. The bake must always emit { id: "main", default: true } first.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra()]),
    });
    const defaultEntries = config.agents.list.filter(
      (entry: { default?: boolean }) => entry.default === true,
    );
    expect(defaultEntries).toHaveLength(1);
    expect(defaultEntries[0].id).toBe("main");
    expect(config.agents.list[0].id).toBe("main");
  });

  it("rejects extras that claim id 'main'", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ id: "main" })]) },
      /reserved for the primary agent/,
    );
  });

  it("rejects extras that set default: true", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ default: true })]) },
      /default cannot be true/,
    );
  });

  it("rejects extras with duplicate ids", () => {
    const extras = [
      makeExtra(),
      makeExtra({
        workspace: "/sandbox/.openclaw/workspace-research-2",
        agentDir: "/sandbox/.openclaw/agents/research-2",
      }),
    ];
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64(extras) },
      /is duplicated/,
    );
  });

  it("rejects extras whose ids violate the regex", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ id: "Research" })]) },
      /\.id must match/,
    );
  });

  it("rejects extras with relative paths", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "workspace-research" }),
        ]),
      },
      /must be an absolute path/,
    );
  });

  it("rejects extras whose paths escape the sandbox state root", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "/etc/openclaw/workspace-research" }),
        ]),
      },
      /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
    );
  });

  it("rejects extras that smuggle dot-segments past the sandbox state root prefix", () => {
    // /sandbox/.openclaw/../../tmp/research resolves to /tmp/research; a raw
    // startsWith() check on the prefix would accept it. The validator must
    // normalise before containment.
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ workspace: "/sandbox/.openclaw/../../tmp/research" }),
        ]),
      },
      /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
    );
  });

  it("rejects extras whose workspace points anywhere but the canonical workspace-<id> slot", () => {
    // The runtime startup script provisions /sandbox/.openclaw/workspace-<id>
    // as the per-agent workspace. Pointing at sibling paths (gateway state,
    // openclaw.json, credentials/) blurs that isolation boundary.
    for (const workspace of [
      "/sandbox/.openclaw",
      "/sandbox/.openclaw/openclaw.json",
      "/sandbox/.openclaw/credentials",
      "/sandbox/.openclaw/workspace",
      "/sandbox/.openclaw/workspace-other",
    ]) {
      expectBuildConfigError(
        { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ workspace })]) },
        /workspace must equal "\/sandbox\/\.openclaw\/workspace-research"/,
      );
    }
  });

  it("rejects extras whose agentDir points anywhere but the canonical agents/<id> slot", () => {
    for (const agentDir of [
      "/sandbox/.openclaw",
      "/sandbox/.openclaw/agents",
      "/sandbox/.openclaw/agents/other",
      "/sandbox/.openclaw/openclaw.json",
    ]) {
      expectBuildConfigError(
        { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ agentDir })]) },
        /agentDir must equal "\/sandbox\/\.openclaw\/agents\/research"/,
      );
    }
  });

  it("rejects extras that lack a tools policy", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ tools: undefined })]),
      },
      /\.tools must be an object/,
    );
  });

  it("rejects extras whose tools policy lacks allow[] and deny[]", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ tools: { profile: "minimal" } }),
        ]),
      },
      /must declare a non-empty allow\[\] or deny\[\]/,
    );
  });

  it("rejects extras whose subagents.maxSpawnDepth is missing or invalid", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([makeExtra({ subagents: undefined })]),
      },
      /\.subagents must be an object/,
    );
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ subagents: { maxSpawnDepth: -1 } }),
        ]),
      },
      /maxSpawnDepth must be a non-negative integer/,
    );
  });

  it("rejects extras when the payload is not an array", () => {
    expectBuildConfigError(
      { NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64({ id: "research" }) },
      /must decode to a JSON array/,
    );
  });

  it("rejects extras that include unsupported top-level fields (no implicit pass-through)", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ apiKey: "leaking-secret-disguised-as-config" }),
        ]),
      },
      /contains unsupported field\(s\): apiKey/,
    );
  });

  it("rejects extras that smuggle credential-like keys inside tools", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ tools: { ...TOOLS_OK, apiKey: "x" } }),
        ]),
      },
      /\.tools contains unsupported field\(s\): apiKey/,
    );
  });

  it("rejects extras that smuggle credential-like keys inside subagents", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ subagents: { ...SUBAGENTS_OK, token: "x" } }),
        ]),
      },
      /\.subagents contains unsupported field\(s\): token/,
    );
  });

  it("rejects extras with an operator-supplied model override (currently unsupported)", () => {
    expectBuildConfigError(
      {
        NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
          makeExtra({ model: { primary: "evil/model" } }),
        ]),
      },
      /contains unsupported field\(s\): model/,
    );
  });

  it("emits canonical paths for workspace/agentDir even when operator input contains dot segments", () => {
    // Resolves to the canonical /sandbox/.openclaw/workspace-research path,
    // but the operator-supplied string is the dot-segment form. The bake
    // must write the canonical string so the runtime
    // `provision_agent_workspaces` parser (which only matches direct
    // `/sandbox/.openclaw/workspace-*`) still recognises it.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        makeExtra({
          workspace: "/sandbox/.openclaw/foo/../workspace-research",
          agentDir: "/sandbox/.openclaw/bar/../agents/research",
        }),
      ]),
    });
    expect(config.agents.list[1].workspace).toBe("/sandbox/.openclaw/workspace-research");
    expect(config.agents.list[1].agentDir).toBe("/sandbox/.openclaw/agents/research");
  });

  it("strips operator entries to the allowlist when writing agents.list", () => {
    // Even if the operator includes an unrecognised but harmless-looking
    // field, the validator must drop it before it reaches the baked image.
    // (The previous test confirms unknown fields fail; this test guards
    // against an allowlist drift where an unknown field is accepted but a
    // known one is dropped.)
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        {
          id: "research",
          workspace: "/sandbox/.openclaw/workspace-research",
          agentDir: "/sandbox/.openclaw/agents/research",
          tools: TOOLS_OK,
          subagents: SUBAGENTS_OK,
          description: "Researches things",
        },
      ]),
    });
    expect(config.agents.list[1]).toEqual({
      id: "research",
      workspace: "/sandbox/.openclaw/workspace-research",
      agentDir: "/sandbox/.openclaw/agents/research",
      tools: TOOLS_OK,
      subagents: SUBAGENTS_OK,
      description: "Researches things",
    });
  });

  it("matches OpenClaw's resolveDefaultAgentId fallback shape for the baked list", () => {
    // OpenClaw's resolver: pick the first entry with default === true; if
    // none, fall back to agents[0]. Simulate that locally over the baked
    // list to prove the bake satisfies the upstream contract today. The
    // authoritative resolver still lives in the openclaw npm package; see
    // agents/openclaw/manifest.yaml -> expected_version for the pinned tag.
    const config = runConfigScript({
      NEMOCLAW_EXTRA_AGENTS_JSON_B64: extraAgentsB64([
        makeExtra({ id: "research" }),
        makeExtra({
          id: "writing",
          workspace: "/sandbox/.openclaw/workspace-writing",
          agentDir: "/sandbox/.openclaw/agents/writing",
        }),
      ]),
    });
    const list: Array<{ id: string; default?: boolean }> = config.agents.list;
    const resolved = list.find((entry) => entry.default === true)?.id ?? list[0]?.id;
    expect(resolved).toBe("main");
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

  it("propagates ollama-local streaming usage compat through the managed inference route (#3947)", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "qwen3.6:35b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/qwen3.6:35b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
        JSON.stringify({ supportsUsageInStreaming: true }),
      ).toString("base64"),
    });

    expect(Object.keys(config.models.providers)).toEqual(["inference"]);
    expect(config.models.providers.inference.models[0]).toMatchObject({
      id: "qwen3.6:35b",
      name: "inference/qwen3.6:35b",
      compat: { supportsUsageInStreaming: true },
    });
    expect(config.agents.defaults.model.primary).toBe("inference/qwen3.6:35b");
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
    expect(config.tools?.toolSearch).toBe(false);
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

  it("rejects inference compat blobs that decode to non-object JSON", () => {
    expectBuildConfigError(
      { NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from('"not-an-object"').toString("base64") },
      "NEMOCLAW_INFERENCE_COMPAT_B64 must decode to a JSON object or null",
    );
  });

  // #2747: Ollama's OpenAI-compatible streaming API omits the usage chunk
  // unless `stream_options.include_usage` is set on the request. OpenClaw
  // gates that on `model.compat.supportsUsageInStreaming`. NemoClaw routes
  // ollama-local through the standardised `inference.local` URL, which
  // OpenClaw's own Ollama detector does not recognise — so we force the
  // flag here. Cloud providers and other local backends must not be
  // affected.
  it("enables supportsUsageInStreaming for Ollama provider keys (#2747)", () => {
    for (const providerKey of ["ollama", "ollama-local"]) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "qwen3.5:9b",
        NEMOCLAW_PROVIDER_KEY: providerKey,
        NEMOCLAW_PRIMARY_MODEL_REF: "qwen3.5:9b",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
      });
      const model = config.models.providers[providerKey].models[0];
      expect(model.compat?.supportsUsageInStreaming).toBe(true);
    }
  });

  it("does not enable supportsUsageInStreaming for non-Ollama providers (#2747)", () => {
    const cases = [
      { NEMOCLAW_PROVIDER_KEY: "openai", NEMOCLAW_INFERENCE_BASE_URL: "https://api.openai.com/v1" },
      {
        NEMOCLAW_PROVIDER_KEY: "anthropic",
        NEMOCLAW_INFERENCE_BASE_URL: "https://api.anthropic.com",
      },
      { NEMOCLAW_PROVIDER_KEY: "vllm", NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1" },
      {
        NEMOCLAW_PROVIDER_KEY: "nim-local",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      },
    ];

    for (const envCase of cases) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "test-model",
        NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        ...envCase,
      });
      const model = config.models.providers[envCase.NEMOCLAW_PROVIDER_KEY].models[0];
      expect(model.compat?.supportsUsageInStreaming).toBeUndefined();
    }
  });

  // If a future model-specific-setup manifest declares
  // supportsUsageInStreaming explicitly, that decision should win over our
  // ollama-keyed default — including when a manifest opts the flag *off*.
  it("respects existing supportsUsageInStreaming from inference compat (#2747)", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "qwen3.5:9b",
      NEMOCLAW_PROVIDER_KEY: "ollama",
      NEMOCLAW_PRIMARY_MODEL_REF: "qwen3.5:9b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
      NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
        JSON.stringify({ supportsUsageInStreaming: false }),
      ).toString("base64"),
    });
    expect(config.models.providers.ollama.models[0].compat.supportsUsageInStreaming).toBe(false);
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
      expect(config.tools?.toolSearch).toBe(true);
    }
  }, 20_000);

  // #4780: Nemotron generates invalid JS for OpenClaw's native code-based tool
  // search (`tool_search_code`): CommonJS `require`, `openclaw.tools.search`
  // called with an object instead of a string, `tool_describe`/`tool_call`
  // invoked with bad ids. The run still succeeds via fallback, but the logs are
  // flooded with `[tools] tool_search_code failed` errors. Disabling native
  // tool search for this managed-inference route routes the model back to the
  // structured tool-calling surface it handles correctly.
  it("disables native OpenClaw Tool Search for Nemotron managed inference (#4780)", () => {
    const config = runConfigScript({
      NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_PROVIDER_KEY: "inference",
      NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
      NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });

    expect(config.tools?.toolSearch).toBe(false);
  });

  it("does not disable native Tool Search for Nemotron on non-matching routes (#4780)", () => {
    const cases = [
      { NEMOCLAW_MODEL: "nvidia/nemotron-3-nano:30b" },
      { NEMOCLAW_PROVIDER_KEY: "nvidia" },
      { NEMOCLAW_INFERENCE_API: "responses" },
      { NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1" },
    ];

    for (const envCase of cases) {
      const config = runConfigScript({
        NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_PROVIDER_KEY: "inference",
        NEMOCLAW_PRIMARY_MODEL_REF: "inference/nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_INFERENCE_BASE_URL: "https://inference.local/v1",
        NEMOCLAW_INFERENCE_API: "openai-completions",
        ...envCase,
      });

      expect(config.tools?.toolSearch).toBe(true);
    }
  }, 20_000);

  it("rejects model-specific setup manifests without a known agent", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/missing-agent.json", {
      id: "missing-agent",
      description: "Invalid manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "field 'agent' is required",
    );

    const unknownRegistryDir = writeRegistryManifest(blueprintDir, "openclaw/unknown-agent.json", {
      id: "unknown-agent",
      agent: "sidecar",
      description: "Invalid manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    });
    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-agent.json"));

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: unknownRegistryDir },
      "unknown agent 'sidecar'",
    );
  }, 20_000);

  it("rejects empty match objects and invalid explicit registry overrides", () => {
    const missingRegistry = path.join(tmpDir, "missing-registry");
    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingRegistry },
      "NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR must point to an existing directory",
    );

    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/empty-match.json", {
      id: "empty-match",
      agent: "openclaw",
      description: "Invalid match",
      match: {},
      effects: { openclawCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "field 'match' must be a non-empty object",
    );
  });

  it("rejects malformed model-specific setup manifest fields independently", () => {
    const validManifest = {
      id: "fixture",
      agent: "openclaw",
      description: "Fixture manifest",
      match: { modelIds: ["test-model"] },
      effects: { openclawCompat: {} },
    };
    const cases = [
      {
        name: "non-object root",
        manifest: null,
        message: "manifest must be a JSON object",
      },
      {
        name: "missing id",
        manifest: { ...validManifest, id: "" },
        message: "field 'id' must be a non-empty string",
      },
      {
        name: "missing description",
        manifest: { ...validManifest, description: "" },
        message: "field 'description' must be a non-empty string",
      },
      {
        name: "non-object match",
        manifest: { ...validManifest, match: null },
        message: "field 'match' must be an object",
      },
      {
        name: "unknown match key",
        manifest: { ...validManifest, match: { modelIds: ["test-model"], family: "kimi" } },
        message: "unknown match keys: family",
      },
      {
        name: "empty modelIds",
        manifest: { ...validManifest, match: { modelIds: [] } },
        message: "match.modelIds must be a non-empty string array",
      },
      {
        name: "empty providerKey",
        manifest: { ...validManifest, match: { providerKey: "" } },
        message: "match.providerKey must be a non-empty string",
      },
      {
        name: "missing effects",
        manifest: { ...validManifest, effects: null },
        message: "field 'effects' must be a non-empty object",
      },
      {
        name: "non-object openclawCompat",
        manifest: { ...validManifest, effects: { openclawCompat: false } },
        message: "effects.openclawCompat must be an object",
      },
      {
        name: "non-object openclawTools",
        manifest: { ...validManifest, effects: { openclawTools: false } },
        message: "effects.openclawTools must be an object",
      },
      {
        name: "unknown openclawTools key",
        manifest: { ...validManifest, effects: { openclawTools: { webSearch: true } } },
        message: "unknown effects.openclawTools keys: webSearch",
      },
      {
        name: "non-array openclawPlugins",
        manifest: { ...validManifest, effects: { openclawPlugins: {} } },
        message: "effects.openclawPlugins must be an array",
      },
      {
        name: "non-object openclaw plugin",
        manifest: { ...validManifest, effects: { openclawPlugins: ["plugin"] } },
        message: "effects.openclawPlugins[0] must be an object",
      },
      {
        name: "missing openclaw plugin id",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "",
                path: "openclaw-plugins/fixture",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "effects.openclawPlugins[0].id must be a non-empty string",
      },
      {
        name: "absolute openclaw plugin source path",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "fixture-plugin",
                path: "/tmp/plugin",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "must be relative to nemoclaw-blueprint",
      },
      {
        name: "parent-relative openclaw plugin source path",
        manifest: {
          ...validManifest,
          effects: {
            openclawPlugins: [
              {
                id: "fixture-plugin",
                path: "../plugin",
                loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/fixture",
              },
            ],
          },
        },
        message: "must be relative to nemoclaw-blueprint",
      },
    ];

    for (const testCase of cases) {
      const blueprintDir = path.join(
        tmpDir,
        `fixture-blueprint-${testCase.name.replaceAll(" ", "-")}`,
      );
      const registryDir = writeRegistryManifest(
        blueprintDir,
        "openclaw/manifest.json",
        testCase.manifest as any,
      );
      expectBuildConfigError({ NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir }, testCase.message);
    }
  });

  it("rejects unknown OpenClaw effect keys and missing plugin source paths", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/bad-effect.json", {
      id: "bad-effect",
      agent: "openclaw",
      description: "Invalid OpenClaw effect",
      match: { modelIds: ["test-model"] },
      effects: { hermesCompat: {} },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "unknown effects for agent 'openclaw': hermesCompat",
    );

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

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: missingPluginRegistryDir },
      "path does not exist",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "missing-plugin.json"));
    const badToolRegistryDir = writeRegistryManifest(
      blueprintDir,
      "openclaw/bad-tool-effect.json",
      {
        id: "bad-tool-effect",
        agent: "openclaw",
        description: "Invalid tool override",
        match: { modelIds: ["test-model"] },
        effects: { openclawTools: { toolSearch: "false" } },
      },
    );

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: badToolRegistryDir },
      "effects.openclawTools.toolSearch must be a boolean",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "bad-tool-effect.json"));
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

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: badLoadPathRegistryDir },
      "effects.openclawPlugins[0].loadPath must be " +
        "'/usr/local/share/nemoclaw/openclaw-plugins/fixture'",
    );
  });

  it("rejects conflicting OpenClaw compat effects and duplicate plugin ids", () => {
    const blueprintDir = path.join(tmpDir, "fixture-blueprint");
    fs.mkdirSync(path.join(blueprintDir, "openclaw-plugins", "fixture"), { recursive: true });
    const registryDir = writeRegistryManifest(blueprintDir, "openclaw/conflicting-compat.json", {
      id: "conflicting-compat",
      agent: "openclaw",
      description: "Conflicting compat",
      match: { modelIds: ["test-model"] },
      effects: {
        openclawCompat: {
          supportsStore: true,
        },
      },
    });

    expectBuildConfigError(
      {
        NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir,
        NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from(
          JSON.stringify({ supportsStore: false }),
        ).toString("base64"),
      },
      "model-specific setup 'conflicting-compat' conflicts with inference compat key 'supportsStore'",
    );

    fs.rmSync(
      path.join(blueprintDir, "model-specific-setup", "openclaw", "conflicting-compat.json"),
    );
    writeRegistryManifest(blueprintDir, "openclaw/tool-a.json", {
      id: "tool-a",
      agent: "openclaw",
      description: "First tool override",
      match: { modelIds: ["test-model"] },
      effects: { openclawTools: { toolSearch: false } },
    });
    writeRegistryManifest(blueprintDir, "openclaw/tool-b.json", {
      id: "tool-b",
      agent: "openclaw",
      description: "Conflicting tool override",
      match: { modelIds: ["test-model"] },
      effects: { openclawTools: { toolSearch: true } },
    });

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
      "model-specific setup 'tool-b' conflicts with OpenClaw tools key 'toolSearch'",
    );

    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "tool-a.json"));
    fs.rmSync(path.join(blueprintDir, "model-specific-setup", "openclaw", "tool-b.json"));
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

    expectBuildConfigError(
      { NEMOCLAW_MODEL_SPECIFIC_SETUP_DIR: registryDir },
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

  it("#4246: enables the discord plugin entry when Discord channel is configured", () => {
    const channels = Buffer.from(JSON.stringify(["discord"])).toString("base64");
    const config = runConfigScript({ NEMOCLAW_MESSAGING_CHANNELS_B64: channels });
    expect(config.plugins.entries.discord).toEqual({ enabled: true });
  });

  it("#4246: omits the discord plugin entry when Discord channel is not configured", () => {
    const config = runConfigScript();
    expect(config.plugins.entries.discord).toBeUndefined();
  });

  it("creates file with 0600 permissions", () => {
    runConfigScript();
    const configPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    const stats = fs.statSync(configPath);
    // 0o600 = owner read/write only (octal 600 = decimal 384)
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe("generate-openclaw-config.mts: non-loopback auto-disable device auth", () => {
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

describe("generate-openclaw-config.mts: empty-string env vars fall back to defaults", () => {
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

describe("generate-openclaw-config.mts: numeric env var validation", () => {
  function runCapturingStderr(envOverrides: Record<string, string>): {
    config: any;
    stderr: string;
  } {
    const { result, stderr } = runCapturingConsoleError(() => buildConfigDirect(envOverrides));
    return { config: result, stderr };
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

  it("skips NEMOCLAW_CONTEXT_WINDOW that exceeds the safe integer guard", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_CONTEXT_WINDOW: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].contextWindow).toBe(131072);
    expect(stderr).toMatch(/NEMOCLAW_CONTEXT_WINDOW must be a positive integer/);
  });

  it("skips NEMOCLAW_MAX_TOKENS that exceeds the safe integer guard", () => {
    const { config, stderr } = runCapturingStderr({ NEMOCLAW_MAX_TOKENS: "9".repeat(10000) });
    expect(config.models.providers["test-provider"].models[0].maxTokens).toBe(4096);
    expect(stderr).toMatch(/NEMOCLAW_MAX_TOKENS must be a positive integer/);
  });
});
