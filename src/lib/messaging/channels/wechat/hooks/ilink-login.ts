// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import { normalizeWechatIlinkBaseUrl } from "../ilink-base-url";

export interface WechatLoginCredentials {
  readonly token: string;
  readonly accountId: string;
  readonly baseUrl?: string;
  readonly userId?: string;
}

export type WechatLoginResult =
  | {
      readonly kind: "ok";
      readonly credentials: WechatLoginCredentials;
      readonly summary?: string;
    }
  | { readonly kind: "timeout" }
  | { readonly kind: "expired"; readonly reason?: string }
  | { readonly kind: "aborted" }
  | { readonly kind: "error"; readonly message?: string };

export const WECHAT_ILINK_LOGIN_HOOK_ID = "wechat.ilinkLogin";

export interface WechatIlinkLoginHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runLogin?: () => Promise<WechatLoginResult>;
  readonly saveCredential?: (key: string, value: string) => void;
  readonly log?: (message: string) => void;
}

export function createWechatIlinkLoginHook(
  options: WechatIlinkLoginHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    if (context.isInteractive === false) {
      (options.log ?? console.log)(
        `  Skipped ${context.channelId} (host QR login requires interactive mode)`,
      );
      throw new Error("WeChat host QR login requires interactive mode.");
    }

    const runLogin = options.runLogin;
    if (!runLogin) {
      throw new Error(
        "WeChat host QR login hook requires an injected runLogin implementation in phase 1.",
      );
    }
    const result = await runLogin();
    if (result.kind !== "ok") {
      const reason = wechatFailureReason(result);
      (options.log ?? console.log)(`  Skipped ${context.channelId} (${reason})`);
      throw new Error(`WeChat host QR login failed: ${reason}.`);
    }

    const env = options.env ?? process.env;
    const saveCredential = options.saveCredential;
    if (!saveCredential) {
      throw new Error(
        "WeChat host QR login hook requires an injected saveCredential implementation in phase 1.",
      );
    }
    const { token, accountId, baseUrl, userId } = result.credentials;
    const normalizedBaseUrl = normalizeWechatIlinkBaseUrl(baseUrl);

    saveCredential("WECHAT_BOT_TOKEN", token);
    env.WECHAT_BOT_TOKEN = token;
    env.WECHAT_ACCOUNT_ID = accountId;
    if (normalizedBaseUrl) env.WECHAT_BASE_URL = normalizedBaseUrl;
    if (userId) env.WECHAT_USER_ID = userId;
    const suffix = result.summary ? ` (${result.summary})` : "";
    (options.log ?? console.log)(`  ✓ ${context.channelId} token saved${suffix}`);

    const outputs: Record<string, MessagingHookOutputMap[string]> = {
      botToken: {
        kind: "secret",
        value: token,
      },
      accountId: {
        kind: "config",
        value: accountId,
      },
    };

    if (normalizedBaseUrl) {
      outputs.baseUrl = {
        kind: "config",
        value: normalizedBaseUrl,
      };
    }
    if (userId) {
      outputs.userId = {
        kind: "config",
        value: userId,
      };
    }
    if (declaresOutput(context.outputDeclarations, "allowedIds")) {
      const allowedIds = mergeCsvValues(readString(context.inputs?.allowedIds), userId ?? "");
      if (allowedIds) {
        env.WECHAT_ALLOWED_IDS = allowedIds;
        outputs.allowedIds = {
          kind: "config",
          value: allowedIds,
        };
      }
    }

    return { outputs };
  };
}

export function createWechatIlinkLoginHookRegistration(
  options: WechatIlinkLoginHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WECHAT_ILINK_LOGIN_HOOK_ID,
    handler: createWechatIlinkLoginHook(options),
  };
}

function wechatFailureReason(result: Exclude<WechatLoginResult, { kind: "ok" }>): string {
  if (result.kind === "timeout") return "QR login timed out";
  if (result.kind === "expired") return "QR expired too many times";
  if (result.kind === "aborted") return "login aborted";
  return result.message || "unknown error";
}

function declaresOutput(
  declarations: readonly { readonly id: string }[] | undefined,
  outputId: string,
): boolean {
  return (declarations ?? []).some((declaration) => declaration.id === outputId);
}

function readString(value: MessagingSerializableValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function mergeCsvValues(existing: string, next: string): string {
  const values = new Set(normalizeCsvValues(existing));
  const normalized = normalizeCredentialValue(next);
  if (normalized) values.add(normalized);
  return Array.from(values).join(",");
}

function normalizeCsvValues(value: string): string[] {
  return normalizeCredentialValue(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeCredentialValue(value: string): string {
  const normalized = value.trim();
  if (/[\r\n]/.test(normalized)) {
    throw new Error("WeChat config values must not contain line breaks.");
  }
  return normalized;
}
