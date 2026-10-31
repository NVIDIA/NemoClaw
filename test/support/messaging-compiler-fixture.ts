// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../../src/lib/messaging/channels";
import { createBuiltInMessagingHookRegistry } from "../../src/lib/messaging/hooks";
import { ManifestCompiler } from "../../src/lib/messaging/compiler/manifest-compiler";

export const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
  DISCORD_BOT_TOKEN: "test-discord-token",
  WECHAT_BOT_TOKEN: "test-wechat-token",
  SLACK_BOT_TOKEN: "xoxb-test-slack-token",
  SLACK_APP_TOKEN: "xapp-test-slack-token",
  MSTEAMS_APP_PASSWORD: "test-teams-client-secret",
};
export const TEST_TEAMS_ENV = {
  MSTEAMS_APP_ID: "test-teams-app-id",
  MSTEAMS_TENANT_ID: "test-teams-tenant-id",
  TEAMS_ALLOWED_USERS: "00000000-0000-0000-0000-000000000001",
  MSTEAMS_PORT: "3978",
} as const;
export const TEST_WECHAT_LOGIN = {
  token: "test-wechat-token",
  accountId: "test-wechat-account",
  baseUrl: "https://ilinkai.wechat.com",
  userId: "test-wechat-user",
} as const;

export function compiler(): ManifestCompiler {
  return new ManifestCompiler(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "",
        log: () => {},
      },
      discord: {
        authentication: { fetch: async () => Response.json({ id: "1", bot: true }), log: () => {} },
      },
      slack: {
        validateCredentials: {
          log: () => {},
          validateCredentials: () => ({ ok: true }),
        },
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
      wechat: {
        ilinkLogin: {
          env: {},
          log: () => {},
          saveCredential: () => {},
          runLogin: async () => ({
            kind: "ok",
            credentials: TEST_WECHAT_LOGIN,
          }),
        },
        seedOpenClawAccount: {
          now: () => "2026-01-01T00:00:00.000Z",
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}
