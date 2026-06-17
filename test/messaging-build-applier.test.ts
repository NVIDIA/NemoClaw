// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for src/lib/messaging/applier/build/messaging-build-applier.mts.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withLegacyMessagingPlanEnv } from "./messaging-plan-test-helper";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const GENERATOR_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "generate-openclaw-config.mts",
);

const BASE_GENERATOR_ENV: Record<string, string> = {
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

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function wechatConfigB64(overrides: Record<string, string> = {}): string {
  return Buffer.from(
    JSON.stringify({
      accountId: "primary",
      baseUrl: "https://ilinkai.wechat.com",
      userId: "u1",
      ...overrides,
    }),
  ).toString("base64");
}

function runDryRun(envOverrides: Record<string, string> = {}) {
  const env = withLegacyMessagingPlanEnv(
    {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...envOverrides,
    },
    "openclaw",
  );
  return spawnSync(
    "node",
    [
      "--experimental-strip-types",
      SCRIPT_PATH,
      "--agent",
      "openclaw",
      "--phase",
      "agent-install",
      "--dry-run",
    ],
    {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout: 10_000,
    },
  );
}

function parseDryRun(envOverrides: Record<string, string> = {}) {
  const result = runDryRun(envOverrides);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("messaging-build-applier.mts: agent-install", () => {
  it("collects selected messaging plugin install specs", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
        "telegram",
        "discord",
        "slack",
        "whatsapp",
        "wechat",
      ]),
      NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
    });

    expect(payload.installSpecs).toEqual([
      "npm:@openclaw/discord@2026.5.22",
      "npm:@tencent-weixin/openclaw-weixin@2.4.3",
      "npm:@openclaw/slack@2026.5.22",
      "npm:@openclaw/whatsapp@2026.5.22",
    ]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      SLACK_APP_TOKEN: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      WECHAT_BOT_TOKEN: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    });
  });

  it("does not inject placeholder token env vars for unselected channels", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["discord", "discord"]),
    });

    expect(payload.channels).toEqual(["discord"]);
    expect(payload.installSpecs).toEqual(["npm:@openclaw/discord@2026.5.22"]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    });
  });

  it("does not require OPENCLAW_VERSION when no external plugin is selected", () => {
    const payload = parseDryRun({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
    });

    expect(payload.installSpecs).toEqual([]);
    expect(payload.doctorEnv).toEqual({
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });
  });

  it("installs the fixed WeChat OpenClaw plugin without OPENCLAW_VERSION", () => {
    const payload = parseDryRun({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["wechat"]),
      NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
    });

    expect(payload.installSpecs).toEqual(["npm:@tencent-weixin/openclaw-weixin@2.4.3"]);
    expect(payload.doctorEnv).toEqual({
      WECHAT_BOT_TOKEN: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    });
  });

  it("forces WhatsApp to the OpenClaw runtime version on 2026.5.18 sandboxes", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.18",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["whatsapp"]),
    });

    expect(payload.installSpecs).toEqual(["npm:@openclaw/whatsapp@2026.5.18"]);
  });

  it("does not include non-messaging OTEL diagnostics in messaging package installs", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_OPENCLAW_OTEL: "1",
    });

    expect(payload.installSpecs).toEqual([]);
  });

  it("preserves the Brave web-search placeholder when doctor runs after messaging render", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["slack"]),
    });

    expect(payload.installSpecs).toEqual(["npm:@openclaw/slack@2026.5.22"]);
    expect(payload.doctorEnv.BRAVE_API_KEY).toBe("openshell:resolve:env:BRAVE_API_KEY");
  });

  it("fails fast on malformed messaging plans", () => {
    const result = runDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_PLAN_B64: "not-base64-json",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_MESSAGING_PLAN_B64");
  });

  it("writes a reduced runtime plan artifact for entrypoint startup", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-plan-artifact-"));
    const artifactPath = path.join(tmp, "runtime", "messaging-runtime-plan.json");
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [
        {
          channelId: "telegram",
          active: true,
          disabled: false,
          inputs: [{ value: "do-not-persist-input-value" }],
        },
        { channelId: "slack", active: false, disabled: true },
      ],
      disabledChannels: ["slack"],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegram-bot-token",
          providerName: "telegram-provider-name",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialHash: "do-not-persist-hash",
        },
      ],
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "openclaw.json",
          kind: "json-fragment",
          path: "channels.telegram",
          value: { token: "do-not-persist-render-value" },
        },
      ],
      buildSteps: [
        {
          channelId: "telegram",
          kind: "build-file",
          outputId: "seed-file",
          value: { content: "do-not-persist-build-step" },
        },
      ],
      runtimeSetup: {
        nodePreloads: [
          {
            channelId: "telegram",
            module: "telegram-diagnostics",
            source: "/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js",
            target: "/tmp/nemoclaw-telegram-diagnostics.js",
            injectInto: ["boot", "connect"],
            optional: false,
            installMessage: "[channels] install telegram diagnostics",
            installedMessage: "[channels] installed telegram diagnostics",
          },
        ],
        envAliases: [],
        secretScans: [],
      },
    };

    try {
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "runtime-setup",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: artifactPath,
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
      expect(artifact).toMatchObject({
        schemaVersion: 1,
        sandboxName: "test-sandbox",
        agent: "openclaw",
        workflow: "rebuild",
        channels: [
          { channelId: "telegram", active: true, disabled: false },
          { channelId: "slack", active: false, disabled: true },
        ],
        disabledChannels: ["slack"],
        credentialBindings: [{ channelId: "telegram", providerEnvKey: "TELEGRAM_BOT_TOKEN" }],
        runtimeSetup: {
          nodePreloads: [
            {
              channelId: "telegram",
              source: "/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js",
              target: "/tmp/nemoclaw-telegram-diagnostics.js",
              injectInto: ["boot", "connect"],
              optional: false,
            },
          ],
          envAliases: [],
          secretScans: [],
        },
      });
      expect(JSON.stringify(artifact)).not.toContain("do-not-persist");
      expect(JSON.stringify(artifact)).not.toContain("openshell:resolve:env");
      expect(artifact.runtimeSetup.nodePreloads[0]).not.toHaveProperty("module");
      expect((fs.statSync(artifactPath).mode & 0o777).toString(8)).toBe("644");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installs package-install specs supplied by the compiled plan", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-package-plan-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        "require('node:fs').appendFileSync(process.env.OPENCLAW_TRACE, `${process.argv.slice(2).join('|')}\\n`);",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "discord", active: true }],
      credentialBindings: [],
      agentRender: [],
      buildSteps: [
        {
          channelId: "discord",
          kind: "package-install",
          outputId: "openclawPluginPackage",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@example/manifest-owned-plugin@{{openclaw.version}}",
            pin: false,
          },
        },
      ],
    };

    try {
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: tmp + ":" + (process.env.PATH || "/usr/bin:/bin"),
            OPENCLAW_TRACE: tracePath,
            OPENCLAW_VERSION: "2026.5.22",
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe(
        "plugins|install|npm:@example/manifest-owned-plugin@2026.5.22",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs pinned installs during agent-install without doctor env injection", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-message-plugins-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/bin/sh",
        'printf \'%s|%s|%s|%s|%s|%s|%s\\n\' "$1" "$2" "$3" "$4" "${TELEGRAM_BOT_TOKEN:-}" "${DISCORD_BOT_TOKEN:-}" "${SLACK_BOT_TOKEN:-}" >> "$OPENCLAW_TRACE"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const planEnv = withLegacyMessagingPlanEnv(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_VERSION: "2026.5.22",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
            "telegram",
            "discord",
            "slack",
            "whatsapp",
            "wechat",
          ]),
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfigB64(),
        },
        "openclaw",
      );
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: planEnv,
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim().split("\n")).toEqual([
        "plugins|install|npm:@openclaw/discord@2026.5.22|--pin|||",
        "plugins|install|npm:@tencent-weixin/openclaw-weixin@2.4.3|--pin|||",
        "plugins|install|npm:@openclaw/slack@2026.5.22|--pin|||",
        "plugins|install|npm:@openclaw/whatsapp@2026.5.22|--pin|||",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#4246: messaging post-agent-install render reaches the mocked OpenClaw doctor boundary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-discord-runtime-contract-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const discordChannels = channelsB64(["discord"]);
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, `${args.join("|")}|${process.env.DISCORD_BOT_TOKEN || ""}|${process.env.BRAVE_API_KEY || ""}\\n`);',
        'if (args[0] === "plugins" && args[1] === "install") {',
        '  if (args[2] !== "npm:@openclaw/discord@2026.5.22") process.exit(41);',
        '  if (args[3] !== "--pin") process.exit(47);',
        "  process.exit(0);",
        "}",
        'if (args[0] === "doctor" && args[1] === "--fix" && args[2] === "--non-interactive") {',
        '  if (process.env.DISCORD_BOT_TOKEN !== "openshell:resolve:env:DISCORD_BOT_TOKEN") process.exit(42);',
        '  const config = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"));',
        "  if (config.plugins?.entries?.discord?.enabled !== true) process.exit(43);",
        "  if (config.channels?.discord?.enabled !== true) process.exit(44);",
        '  if (config.channels?.discord?.accounts?.default?.token !== "openshell:resolve:env:DISCORD_BOT_TOKEN") process.exit(45);',
        "  process.exit(0);",
        "}",
        "process.exit(46);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const generatorEnv = withLegacyMessagingPlanEnv(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: discordChannels,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
          NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        },
        "openclaw",
      );
      const generatorResult = spawnSync("node", ["--experimental-strip-types", GENERATOR_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: generatorEnv,
        timeout: 10_000,
      });
      expect(generatorResult.status, generatorResult.stderr).toBe(0);

      const applierEnv = {
        PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
        HOME: tmp,
        OPENCLAW_TRACE: tracePath,
        OPENCLAW_VERSION: "2026.5.22",
        NEMOCLAW_MESSAGING_PLAN_B64: generatorEnv.NEMOCLAW_MESSAGING_PLAN_B64,
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      };
      const pluginResult = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: applierEnv,
          timeout: 10_000,
        },
      );
      expect(pluginResult.status, pluginResult.stderr).toBe(0);

      const postInstallResult = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "post-agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: applierEnv,
          timeout: 10_000,
        },
      );

      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim().split("\n")).toEqual([
        "plugins|install|npm:@openclaw/discord@2026.5.22|--pin||",
        "doctor|--fix|--non-interactive|openshell:resolve:env:DISCORD_BOT_TOKEN|openshell:resolve:env:BRAVE_API_KEY",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reapplies OpenClaw messaging render after doctor rewrites config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-doctor-rewrite-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    const channels = channelsB64(["telegram", "discord", "slack", "wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/usr/bin/env node",
        'const fs = require("fs");',
        'const path = require("path");',
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, args.join("|") + String.fromCharCode(10));',
        'if (args[0] !== "doctor" || args[1] !== "--fix" || args[2] !== "--non-interactive") process.exit(46);',
        'const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");',
        'const config = JSON.parse(fs.readFileSync(configPath, "utf8"));',
        'if (config.channels?.telegram?.accounts?.default?.botToken !== "openshell:resolve:env:TELEGRAM_BOT_TOKEN") process.exit(40);',
        "if (config.channels?.discord?.enabled !== true) process.exit(41);",
        "if (config.plugins?.entries?.discord?.enabled !== true) process.exit(42);",
        "if (config.plugins?.entries?.slack?.enabled !== true) process.exit(43);",
        'if (config.channels?.["openclaw-weixin"]?.accounts?.primary?.enabled !== true) process.exit(44);',
        'fs.writeFileSync(configPath, JSON.stringify({ channels: { telegram: { accounts: { default: { botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN" } } } }, plugins: { entries: {} } }, null, 2) + String.fromCharCode(10));',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const generatorEnv = withLegacyMessagingPlanEnv(
        {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      const generatorResult = spawnSync("node", ["--experimental-strip-types", GENERATOR_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: generatorEnv,
        timeout: 10_000,
      });
      expect(generatorResult.status, generatorResult.stderr).toBe(0);

      const postInstallResult = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "post-agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            HOME: tmp,
            OPENCLAW_TRACE: tracePath,
            NEMOCLAW_MESSAGING_PLAN_B64: generatorEnv.NEMOCLAW_MESSAGING_PLAN_B64,
          },
          timeout: 10_000,
        },
      );
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim()).toBe("doctor|--fix|--non-interactive");

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.channels?.telegram?.accounts?.default).toMatchObject({
        botToken: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        enabled: true,
      });
      expect(config.channels?.discord?.enabled).toBe(true);
      expect(config.plugins?.entries?.discord).toEqual({ enabled: true });
      expect(config.channels?.slack?.enabled).toBe(true);
      expect(config.plugins?.entries?.slack).toEqual({ enabled: true });
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies post-agent-install WeChat build files from the compiled messaging plan", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-post-agent-install-"));
    const channels = channelsB64(["wechat"]);
    const wechatConfig = Buffer.from(
      JSON.stringify({ accountId: "primary", baseUrl: "https://ilinkai.wechat.com", userId: "u1" }),
    ).toString("base64");

    try {
      const generatorEnv = withLegacyMessagingPlanEnv(
        {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channels,
          NEMOCLAW_WECHAT_CONFIG_B64: wechatConfig,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        "openclaw",
      );
      const generatorResult = spawnSync("node", ["--experimental-strip-types", GENERATOR_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: generatorEnv,
        timeout: 10_000,
      });
      expect(generatorResult.status, generatorResult.stderr).toBe(0);

      const fakeOpenclaw = path.join(tmp, "openclaw");
      fs.writeFileSync(fakeOpenclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const postInstallResult = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "post-agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
            HOME: tmp,
            NEMOCLAW_MESSAGING_PLAN_B64: generatorEnv.NEMOCLAW_MESSAGING_PLAN_B64,
          },
          timeout: 10_000,
        },
      );
      expect(postInstallResult.status, postInstallResult.stderr).toBe(0);

      const config = JSON.parse(
        fs.readFileSync(path.join(tmp, ".openclaw", "openclaw.json"), "utf-8"),
      );
      expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual({
        source: "npm",
        spec: "@tencent-weixin/openclaw-weixin@2.4.3",
        installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
      });
      expect(config.plugins?.load?.paths ?? []).not.toContain(
        "/sandbox/.openclaw/extensions/openclaw-weixin",
      );
      expect(config.channels?.["openclaw-weixin"]?.accounts?.primary).toEqual({ enabled: true });
      expect(config.channels?.wechat).toBeUndefined();

      const account = JSON.parse(
        fs.readFileSync(
          path.join(tmp, ".openclaw", "openclaw-weixin", "accounts", "primary.json"),
          "utf-8",
        ),
      );
      expect(account).toMatchObject({
        token: "openshell:resolve:env:WECHAT_BOT_TOKEN",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "u1",
      });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(tmp, ".openclaw", "openclaw-weixin", "accounts.json"), "utf-8"),
        ),
      ).toEqual(["primary"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects post-agent-install render targets that escape the agent root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-render-target-escape-"));
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      channels: [{ channelId: "telegram", active: true }],
      credentialBindings: [],
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "~/.openclaw/../escaped.json",
          kind: "json-fragment",
          path: "channels.telegram.enabled",
          value: true,
        },
      ],
      buildSteps: [],
    };

    try {
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "openclaw",
          "--phase",
          "post-agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            HOME: tmp,
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("must stay inside");
      expect(fs.existsSync(path.join(tmp, "escaped.json"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects multiline env render lines from serialized plans", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-env-line-injection-"));
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      channels: [{ channelId: "slack", active: true }],
      credentialBindings: [],
      agentRender: [
        {
          channelId: "slack",
          agent: "hermes",
          target: "~/.hermes/.env",
          kind: "env-lines",
          renderId: "slack-hermes-env",
          lines: ["SLACK_ALLOWED_USERS=U123\nEVIL=1"],
        },
      ],
      buildSteps: [],
    };

    try {
      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "hermes",
          "--phase",
          "post-agent-install",
        ],
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            HOME: tmp,
            NEMOCLAW_MESSAGING_PLAN_B64: Buffer.from(JSON.stringify(plan)).toString("base64"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("line breaks");
      const envPath = path.join(tmp, ".hermes", ".env");
      expect(fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "").not.toContain(
        "EVIL=1",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies Hermes messaging render to config.yaml and .env in post-agent-install", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-render-"));
    try {
      const hermesDir = path.join(tmp, ".hermes");
      fs.mkdirSync(hermesDir, { recursive: true });
      fs.writeFileSync(
        path.join(hermesDir, "config.yaml"),
        [
          "# Managed by NemoClaw - Hermes configuration",
          "# Upstream provider: openai",
          "# OpenShell rewrites model.base_url to the upstream endpoint at request time.",
          "_config_version: 12",
          "platform_toolsets:",
          "  api_server:",
          "  - web",
          "platforms:",
          "  api_server:",
          "    enabled: true",
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(hermesDir, ".env"), "API_SERVER_PORT=18642\n");
      const env = withLegacyMessagingPlanEnv(
        {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: tmp,
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
        },
        "hermes",
      );

      const result = spawnSync(
        "node",
        [
          "--experimental-strip-types",
          SCRIPT_PATH,
          "--agent",
          "hermes",
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

      expect(result.status, result.stderr).toBe(0);
      const configYaml = fs.readFileSync(path.join(hermesDir, "config.yaml"), "utf-8");
      expect(configYaml).toContain("telegram:");
      expect(configYaml).toContain("enabled: true");
      const envFile = fs.readFileSync(path.join(hermesDir, ".env"), "utf-8");
      expect(envFile).toContain("API_SERVER_PORT=18642\n");
      expect(envFile).toContain("TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
