// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for scripts/openclaw-build-messaging-plugins.py.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "openclaw-build-messaging-plugins.py",
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

function runDryRun(envOverrides: Record<string, string> = {}) {
  return spawnSync("python3", [SCRIPT_PATH, "--dry-run"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...envOverrides,
    },
    timeout: 10_000,
  });
}

function parseDryRun(envOverrides: Record<string, string> = {}) {
  const result = runDryRun(envOverrides);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("openclaw-build-messaging-plugins.py", () => {
  it("pins selected external messaging plugins to OPENCLAW_VERSION", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
        "telegram",
        "discord",
        "slack",
        "whatsapp",
      ]),
    });

    expect(payload.installSpecs).toEqual([
      "npm:@openclaw/discord@2026.5.22",
      "npm:@openclaw/slack@2026.5.22",
      "npm:@openclaw/whatsapp@2026.5.22",
    ]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      SLACK_APP_TOKEN: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
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

  it("forces WhatsApp to the OpenClaw runtime version on 2026.5.18 sandboxes", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.18",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["whatsapp"]),
    });

    expect(payload.installSpecs).toEqual(["npm:@openclaw/whatsapp@2026.5.18"]);
  });

  it("pins the diagnostics OTEL plugin when OpenClaw OTEL is enabled", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_OPENCLAW_OTEL: "1",
    });

    expect(payload.diagnosticsOtelEnabled).toBe(true);
    expect(payload.installSpecs).toEqual(["npm:@openclaw/diagnostics-otel@2026.5.22"]);
  });

  it("requires OPENCLAW_VERSION when OpenClaw OTEL is enabled", () => {
    const result = runDryRun({
      NEMOCLAW_OPENCLAW_OTEL: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENCLAW_VERSION is required");
  });

  it("fails fast on malformed channel payloads", () => {
    const result = runDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: "not-base64-json",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_MESSAGING_CHANNELS_B64");
  });

  it("runs pinned installs before doctor and limits doctor env injection to the doctor command", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-message-plugins-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/bin/sh",
        "printf '%s|%s|%s|%s|%s|%s|%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"${TELEGRAM_BOT_TOKEN:-}\" \"${DISCORD_BOT_TOKEN:-}\" \"${SLACK_BOT_TOKEN:-}\" >> \"$OPENCLAW_TRACE\"",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("python3", [SCRIPT_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_VERSION: "2026.5.22",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
            "telegram",
            "discord",
            "slack",
            "whatsapp",
          ]),
        },
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim().split("\n")).toEqual([
        "plugins|install|npm:@openclaw/discord@2026.5.22|--pin|||",
        "plugins|install|npm:@openclaw/slack@2026.5.22|--pin|||",
        "plugins|install|npm:@openclaw/whatsapp@2026.5.22|--pin|||",
        [
          "doctor",
          "--fix",
          "--non-interactive",
          "",
          "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          "openshell:resolve:env:DISCORD_BOT_TOKEN",
          "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        ].join("|"),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("#4246: generated Discord config reaches the mocked OpenClaw plugin-load boundary", () => {
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
        'fs.appendFileSync(process.env.OPENCLAW_TRACE, `${args.join("|")}|${process.env.DISCORD_BOT_TOKEN || ""}\\n`);',
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
      const generatorResult = spawnSync("node", ["--experimental-strip-types", GENERATOR_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          ...BASE_GENERATOR_ENV,
          NEMOCLAW_MESSAGING_CHANNELS_B64: discordChannels,
          NEMOCLAW_OPENCLAW_MANAGED_PROXY: "0",
        },
        timeout: 10_000,
      });
      expect(generatorResult.status, generatorResult.stderr).toBe(0);

      const pluginResult = spawnSync("python3", [SCRIPT_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          HOME: tmp,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_VERSION: "2026.5.22",
          NEMOCLAW_MESSAGING_CHANNELS_B64: discordChannels,
        },
        timeout: 10_000,
      });

      expect(pluginResult.status, pluginResult.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim().split("\n")).toEqual([
        "plugins|install|npm:@openclaw/discord@2026.5.22|--pin|",
        "doctor|--fix|--non-interactive|openshell:resolve:env:DISCORD_BOT_TOKEN",
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
