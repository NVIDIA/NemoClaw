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
} from "../../scripts/generate-openclaw-config.mts";
import { applyMessagingAgentRenderToObject } from "../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../../src/lib/messaging/channels";
import { MessagingWorkflowPlanner } from "../../src/lib/messaging/compiler";
import { createBuiltInMessagingHookRegistry } from "../../src/lib/messaging/hooks";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

const BASE_ENV = baseOpenClawGenerationEnv();
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

function messagingPlanner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) =>
          key === "TELEGRAM_BOT_TOKEN" ? "123456:test-telegram-token" : null,
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
      },
      telegram: {
        fetch: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { ok: true };
          },
          async text() {
            return "";
          },
        }),
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

describe("generate-openclaw-config.mts: default plugin entries", () => {
  it("adds the installed NemoClaw plugin to the default OpenClaw allowlist (#8975)", () => {
    const config = buildConfig({ ...BASE_ENV });
    expect(config.plugins.allow).toEqual(["nemoclaw"]);
  });

  it("allows the enabled diagnostics plugin (#8975)", () => {
    const config = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_OPENCLAW_OTEL: "1",
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
    });

    expect(config.plugins.entries["diagnostics-otel"]).toEqual({ enabled: true });
    expect(config.plugins.allow).toContain("diagnostics-otel");
  });

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
    EXPECTED_MANAGED_IMAGE_OPENCLAW_NEUTRAL_CAPABILITIES.forEach(({ channelId, pluginId }) => {
      expect(config.plugins.entries[pluginId], pluginId).toEqual({ enabled: false });
      expect(config.channels[channelId], channelId).toEqual({ enabled: false });
    });
    ["diagnostics-otel", "brave", "tavily"].forEach((pluginId) => {
      expect(config.plugins.entries[pluginId], pluginId).toEqual({ enabled: false });
    });
    expect(config.tools.web.search).toEqual({ enabled: false });
  });

  it("removes active Telegram account and credential configuration while retaining its bundled inert capability (#9361)", async () => {
    const baseline = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
    });
    expect(baseline.channels.telegram).toEqual({ enabled: false });
    expect(baseline.plugins.entries.telegram).toEqual({ enabled: false });

    const planner = messagingPlanner();
    const addedPlan = await planner.buildPlan({
      sandboxName: "demo",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["telegram"],
      credentialAvailability: { TELEGRAM_BOT_TOKEN: true },
    });
    const added = structuredClone(baseline);
    applyMessagingAgentRenderToObject(added, addedPlan, "openclaw.json");

    expect(added.channels.telegram).toMatchObject({
      enabled: true,
      accounts: {
        default: {
          botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          enabled: true,
        },
      },
    });
    expect(added.plugins.entries.telegram).toEqual({ enabled: true });
    expect(added.plugins.allow).toContain("telegram");
    expect(addedPlan.credentialBindings).toContainEqual(
      expect.objectContaining({ channelId: "telegram", providerEnvKey: "TELEGRAM_BOT_TOKEN" }),
    );
    expect(addedPlan.networkPolicy.entries.some((entry) => entry.channelId === "telegram")).toBe(
      true,
    );
    expect(JSON.stringify(added)).not.toContain("123456:test-telegram-token");

    const removedPlan = await planner.buildChannelRemovePlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "openclaw",
      sandboxEntry: {
        name: "demo",
        messaging: { schemaVersion: 1, plan: addedPlan },
      },
      channelId: "telegram",
    });
    expect(removedPlan?.channels).toEqual([]);
    expect(removedPlan?.credentialBindings).toEqual([]);
    expect(removedPlan?.networkPolicy.entries).toEqual([]);
    expect(removedPlan?.agentRender).toEqual([]);

    const removed = buildConfig({
      ...BASE_ENV,
      NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
    });
    applyMessagingAgentRenderToObject(removed, removedPlan, "openclaw.json");
    expect(removed.channels.telegram).toEqual({ enabled: false });
    expect(removed.channels.telegram.accounts).toBeUndefined();
    expect(JSON.stringify(removed.channels.telegram)).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(removed.plugins.entries.telegram).toEqual({ enabled: false });
    expect(removed.plugins.allow).not.toContain("telegram");
    expect(removed.channels.discord).toEqual({ enabled: false });
    expect(removed.plugins.entries.discord).toEqual({ enabled: false });
  });

  it("retains existing plugin allowlist and managed-image install metadata while explicitly disabling the plugin (#7744)", () => {
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
        JSON.stringify({
          plugins: {
            allow: ["openclaw-weixin"],
            installs: { "openclaw-weixin": installEntry },
          },
        }),
      );
      Object.keys(process.env).forEach((name) => {
        delete process.env[name];
      });
      Object.assign(process.env, BASE_ENV, {
        HOME: tempDirectory,
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      });

      main();

      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(config.plugins?.installs?.["openclaw-weixin"]).toEqual(installEntry);
      expect(config.plugins?.allow).toEqual(["nemoclaw", "openclaw-weixin"]);
      expect(config.plugins?.entries?.["openclaw-weixin"]).toEqual({ enabled: false });
      expect(config.channels?.["openclaw-weixin"]).toEqual({ enabled: false });
    } finally {
      Object.keys(process.env).forEach((name) => {
        delete process.env[name];
      });
      Object.assign(process.env, originalEnvironment);
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
