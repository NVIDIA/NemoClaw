// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ChannelManifest,
  SandboxMessagingPlan,
} from "../index";

type FunctionLike = (...args: never[]) => unknown;

type FunctionFieldKey<T> = {
  [Key in keyof T]-?: Extract<NonNullable<T[Key]>, FunctionLike> extends never
    ? never
    : Key;
}[keyof T];

type AssertNever<T extends never> = T;

type _ManifestFieldsContainNoFunctions = AssertNever<FunctionFieldKey<ChannelManifest>>;
type _PlanFieldsContainNoFunctions = AssertNever<FunctionFieldKey<SandboxMessagingPlan>>;

const telegramManifest = {
  schemaVersion: 1,
  id: "telegram",
  displayName: "Telegram",
  description: "Telegram bot messaging",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "token-paste",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "TELEGRAM_BOT_TOKEN",
      prompt: {
        label: "Telegram Bot Token",
        help: "Create a Telegram bot and copy the token.",
      },
    },
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_ALLOWED_IDS",
      statePath: "allowedIds.telegram",
      prompt: {
        label: "Telegram User ID",
      },
    },
    {
      id: "requireMention",
      kind: "config",
      required: false,
      envKey: "TELEGRAM_REQUIRE_MENTION",
      validValues: ["0", "1"],
      defaultValue: "1",
      statePath: "telegramConfig.requireMention",
    },
  ],
  credentials: [
    {
      id: "telegramBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-telegram-bridge",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
      placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    },
  ],
  policyPresets: ["telegram"],
  render: [
    {
      id: "telegram-openclaw",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.telegram.accounts.default",
        value: {
          botToken: "{{credential.telegramBotToken.placeholder}}",
          enabled: true,
          allowFrom: "{{allowedIds.telegram.csv}}",
        },
      },
    },
    {
      id: "telegram-hermes",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "TELEGRAM_BOT_TOKEN={{credential.telegramBotToken.placeholder}}",
        "TELEGRAM_ALLOWED_USERS={{allowedIds.telegram.csv}}",
      ],
    },
  ],
  state: {
    persist: {
      allowedIds: ["allowedIds"],
      telegramConfig: ["requireMention"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.telegram",
        env: "TELEGRAM_ALLOWED_IDS",
      },
      {
        statePath: "telegramConfig.requireMention",
        env: "TELEGRAM_REQUIRE_MENTION",
      },
    ],
  },
  hooks: [],
} as const satisfies ChannelManifest;

const wechatHookManifest = {
  schemaVersion: 1,
  id: "wechat",
  displayName: "WeChat",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "host-qr",
  },
  inputs: [
    {
      id: "botToken",
      kind: "secret",
      required: true,
      envKey: "WECHAT_BOT_TOKEN",
    },
    {
      id: "accountId",
      kind: "config",
      required: true,
      envKey: "WECHAT_ACCOUNT_ID",
      statePath: "wechatConfig.accountId",
    },
  ],
  credentials: [
    {
      id: "wechatBotToken",
      sourceInput: "botToken",
      providerName: "{sandboxName}-wechat-bridge",
      providerEnvKey: "WECHAT_BOT_TOKEN",
      placeholder: "openshell:resolve:env:WECHAT_BOT_TOKEN",
    },
  ],
  policyPresets: ["wechat"],
  render: [],
  state: {
    persist: {
      wechatConfig: ["accountId"],
    },
    rebuildHydration: [
      {
        statePath: "wechatConfig.accountId",
        env: "WECHAT_ACCOUNT_ID",
      },
    ],
  },
  hooks: [
    {
      id: "wechat-host-qr",
      phase: "enroll",
      handler: "wechat.ilinkLogin",
      outputs: [
        {
          id: "botToken",
          kind: "secret",
          required: true,
        },
        {
          id: "accountId",
          kind: "config",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
  ],
} as const satisfies ChannelManifest;

const telegramPlan = {
  schemaVersion: 1,
  channels: [
    {
      channelId: "telegram",
      displayName: "Telegram",
      active: true,
      inputs: [
        {
          inputId: "botToken",
          kind: "secret",
          required: true,
          sourceEnv: "TELEGRAM_BOT_TOKEN",
        },
        {
          inputId: "allowedIds",
          kind: "config",
          required: false,
          sourceEnv: "TELEGRAM_ALLOWED_IDS",
          statePath: "allowedIds.telegram",
        },
      ],
      credentialBindings: [
        {
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "demo-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        },
      ],
      policyPresets: ["telegram"],
      render: [
        {
          kind: "json-fragment",
          agent: "openclaw",
          target: "openclaw.json",
          path: "channels.telegram.accounts.default",
          value: {
            botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
            enabled: true,
          },
        },
        {
          kind: "env-lines",
          agent: "hermes",
          target: "~/.hermes/.env",
          lines: ["TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN"],
        },
      ],
      buildInputs: [],
      hooks: [],
    },
  ],
} as const satisfies SandboxMessagingPlan;

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function findFunctionPaths(value: unknown, prefix = "$"): string[] {
  if (typeof value === "function") return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findFunctionPaths(entry, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => findFunctionPaths(entry, `${prefix}.${key}`));
  }
  return [];
}

function collectProductionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) return collectProductionFiles(absolute);
    if (absolute.endsWith(".ts") && !absolute.endsWith(".test.ts")) return [absolute];
    return [];
  });
}

function collectModuleSpecifiers(source: string): string[] {
  const pattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

describe("messaging manifest type contracts", () => {
  it("serializes representative manifests without losing required fields", () => {
    const parsedTelegram = jsonRoundTrip(telegramManifest);
    const parsedWechat = jsonRoundTrip(wechatHookManifest);

    expect(parsedTelegram).toEqual(telegramManifest);
    expect(parsedTelegram.schemaVersion).toBe(1);
    expect(parsedTelegram.auth.mode).toBe("token-paste");
    expect(parsedTelegram.inputs.map((input) => input.id)).toEqual([
      "botToken",
      "allowedIds",
      "requireMention",
    ]);
    expect(parsedWechat.hooks[0]?.handler).toBe("wechat.ilinkLogin");
    expect(parsedWechat.hooks[0]?.outputs?.map((output) => output.id)).toEqual([
      "botToken",
      "accountId",
    ]);
  });

  it("serializes plan objects without embedding raw secret values", () => {
    const rawSecret = "123456:raw-telegram-token";
    const parsed = jsonRoundTrip(telegramPlan);
    const serialized = JSON.stringify(parsed);

    expect(parsed).toEqual(telegramPlan);
    expect(serialized).toContain("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
    expect(serialized).not.toContain(rawSecret);
    expect(parsed.channels[0]?.credentialBindings[0]).not.toHaveProperty("value");
  });

  it("uses hook handler references instead of function-valued fields", () => {
    expect(findFunctionPaths(telegramManifest)).toEqual([]);
    expect(findFunctionPaths(wechatHookManifest)).toEqual([]);
    expect(findFunctionPaths(telegramPlan)).toEqual([]);
    expect(wechatHookManifest.hooks[0]?.handler).toBe("wechat.ilinkLogin");
  });

  it("keeps the new production module isolated from side-effect layers", () => {
    const moduleRoot = path.join(import.meta.dirname, "..");
    const files = collectProductionFiles(moduleRoot);
    const forbiddenFragments = [
      "gateway",
      "state/registry",
      "credentials",
      "node:fs",
      "node:child_process",
      "child_process",
      "adapters/openshell",
      "src/commands",
      "lib/actions",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const specifiers = collectModuleSpecifiers(source);
      for (const fragment of forbiddenFragments) {
        expect(
          specifiers.some((specifier) => specifier.includes(fragment)),
          `${path.relative(moduleRoot, file)} imports ${fragment}`,
        ).toBe(false);
      }
    }
  });
});
