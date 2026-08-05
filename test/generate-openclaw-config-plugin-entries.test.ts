// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Focused tests for the default plugin entries written into openclaw.json by
// scripts/generate-openclaw-config.mts. Split out of generate-openclaw-config
// .test.ts to keep that file within its size budget.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildConfig,
  MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES,
  MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES,
  main,
} from "../scripts/generate-openclaw-config.mts";

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
const EXPECTED_MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES = [
  { channelId: "telegram", pluginId: "telegram" },
  { channelId: "discord", pluginId: "discord" },
  { channelId: "openclaw-weixin", pluginId: "openclaw-weixin" },
  { channelId: "slack", pluginId: "slack" },
  { channelId: "whatsapp", pluginId: "whatsapp" },
  { channelId: "msteams", pluginId: "msteams" },
  { channelId: "googlechat", pluginId: "googlechat" },
] as const;
const EXPECTED_MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES = [
  { channelId: "imessage", pluginId: "imessage" },
] as const;
const EXPECTED_MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES = [
  ...EXPECTED_MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES,
  ...EXPECTED_MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES,
] as const;

describe("generate-openclaw-config.mts: default plugin entries", () => {
  it("omits the stale acpx entry and disables bundled bonjour by default", () => {
    const config = buildConfig({ ...BASE_ENV });
    expect(config.plugins.entries.acpx).toBeUndefined();
    expect(config.plugins.entries.bonjour).toEqual({ enabled: false });
  });

  it("does not reference the uninstalled qqbot plugin", () => {
    // qqbot is not bundled in the sandbox image, so a config entry for it makes
    // OpenClaw warn "plugin not installed: qqbot" on every first TUI launch (#6000).
    const config = buildConfig({ ...BASE_ENV });
    expect(config.plugins.entries.qqbot).toBeUndefined();
  });

  it("keeps every managed-image plugin and channel explicitly inert before first start (#7744)", () => {
    const config = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
    });

    expect(MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES).toEqual(
      EXPECTED_MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES,
    );
    expect(MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES).toEqual(
      EXPECTED_MANAGED_IMAGE_OPENCLAW_BUNDLED_INERT_CAPABILITIES,
    );
    for (const { channelId, pluginId } of EXPECTED_MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES) {
      expect(config.plugins.entries[pluginId], pluginId).toEqual({ enabled: false });
      expect(config.channels[channelId], channelId).toEqual({ enabled: false });
    }
    for (const pluginId of ["diagnostics-otel", "brave", "tavily"]) {
      expect(config.plugins.entries[pluginId], pluginId).toEqual({ enabled: false });
    }
    expect(config.tools.web.search).toEqual({ enabled: false });
  });

  it("retains managed-image install metadata while explicitly disabling the plugin (#7744)", () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-union-"));
    const originalEnvironment = { ...process.env };
    const configPath = path.join(tempDirectory, ".openclaw", "openclaw.json");
    const installEntry = {
      source: "npm",
      spec: "@tencent-weixin/openclaw-weixin@2.4.3",
      installPath: "/sandbox/.openclaw/extensions/openclaw-weixin",
    };
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({ plugins: { installs: { "openclaw-weixin": installEntry } } }),
      );
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, BASE_ENV, {
        HOME: tempDirectory,
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      });

      main();

      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual(installEntry);
      expect(config.plugins?.entries?.["openclaw-weixin"]).toEqual({ enabled: false });
      expect(config.channels?.["openclaw-weixin"]).toEqual({ enabled: false });
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, originalEnvironment);
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
