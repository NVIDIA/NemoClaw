// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "./channels";
import {
  collectBuiltInMessagingChannelDiagnostics,
  collectVisibleConfigRecords,
} from "./diagnostics";
import { MessagingWorkflowPlanner } from "./compiler/workflow-planner";
import { createBuiltInMessagingHookRegistry } from "./hooks";

describe("messaging channel diagnostics", () => {
  it("derives common channel diagnostic metadata directly from manifests", () => {
    const specs = collectBuiltInMessagingChannelDiagnostics();

    expect(specs.map((spec) => spec.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
    expect(specs.find((spec) => spec.channelId === "telegram")).toMatchObject({
      policyPresets: ["telegram"],
      preferredDefault: false,
    });
    expect(specs.find((spec) => spec.channelId === "wechat")).toMatchObject({
      policyPresets: ["wechat"],
    });
    expect(specs.find((spec) => spec.channelId === "whatsapp")).toMatchObject({
      policyPresets: ["whatsapp"],
      preferredDefault: true,
      deepProbe: "in-sandbox-qr",
      doctorWhenNoHealthSignals: expect.objectContaining({
        hint: "run `{cli} {sandbox} channels status --channel {channel}` to probe inbound delivery",
      }),
    });
    expect(specs.find((spec) => spec.channelId === "teams")).toMatchObject({
      policyPresets: ["teams"],
      preferredDefault: false,
    });
  });
});

describe("collectVisibleConfigRecords (compiled plan integration)", () => {
  it("renders Telegram visible config from a plan compiled out of process env, not from injected plan inputs", async () => {
    const planner = new MessagingWorkflowPlanner(
      createBuiltInChannelManifestRegistry(),
      createBuiltInMessagingHookRegistry({
        common: {
          env: {
            TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
            TELEGRAM_GROUP_POLICY: "allowlist",
          },
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

    const plan = await withEnvOverrides(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
        TELEGRAM_GROUP_POLICY: "allowlist",
        TELEGRAM_REQUIRE_MENTION: undefined,
      },
      () =>
        planner.buildPlan({
          sandboxName: "alpha",
          agent: "openclaw",
          workflow: "onboard",
          isInteractive: true,
          configuredChannels: ["telegram"],
        }),
    );

    const diagnostic = collectBuiltInMessagingChannelDiagnostics().find(
      (spec) => spec.channelId === "telegram",
    );
    expect(diagnostic).toBeDefined();

    const records = collectVisibleConfigRecords(diagnostic!, plan, "telegram", "openclaw");
    const labels = records.map((record) => record.input.label);
    const byLabel = (label: string) => records.find((record) => record.input.label === label);

    expect(labels).toContain("Telegram group policy");
    expect(labels).toContain("Telegram group mention mode");
    expect(byLabel("Telegram group policy")?.display).toMatchObject({
      source: "persisted",
      detail: "allowlist",
    });
    expect(byLabel("Telegram group mention mode")?.display).toMatchObject({
      source: "persisted",
      detail: "mention-only (TELEGRAM_REQUIRE_MENTION=1)",
    });
  });
});

async function withEnvOverrides<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  applyEnvOverrides(values);
  try {
    return await run();
  } finally {
    applyEnvOverrides(previous);
  }
}

function applyEnvOverrides(values: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    value === undefined ? Reflect.deleteProperty(process.env, key) : (process.env[key] = value);
  }
}
