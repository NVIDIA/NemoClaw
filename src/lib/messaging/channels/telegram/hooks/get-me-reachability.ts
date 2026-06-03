// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../../../../credentials/store";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const TELEGRAM_GET_ME_REACHABILITY_HOOK_ID = "telegram.getMeReachability";

interface TelegramFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

type TelegramFetch = (url: string) => Promise<TelegramFetchResponse>;

export interface TelegramGetMeReachabilityHookOptions {
  readonly fetch?: TelegramFetch;
  readonly apiBaseUrl?: string;
}

export function createTelegramGetMeReachabilityHook(
  options: TelegramGetMeReachabilityHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const rawToken = context.inputs?.botToken;
    const token = normalizeCredentialValue(typeof rawToken === "string" ? rawToken : "");
    if (!token) {
      throw new Error("Telegram reachability check requires botToken.");
    }

    const response = await fetchTelegramGetMe(token, options).catch(() => {
      throw new Error("Telegram reachability check failed: Bot API request failed.");
    });
    if (!response.ok) {
      throw new Error(
        `Telegram reachability check failed with HTTP ${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        }.`,
      );
    }

    const payload = await readTelegramJson(response);
    if (!isObject(payload) || payload.ok !== true) {
      throw new Error("Telegram reachability check failed: Bot API rejected the token.");
    }

    return {};
  };
}

export function createTelegramHookRegistrations(
  options: TelegramGetMeReachabilityHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    {
      id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
      handler: createTelegramGetMeReachabilityHook(options),
    },
  ] as const;
}

async function fetchTelegramGetMe(
  token: string,
  options: TelegramGetMeReachabilityHookOptions,
): Promise<TelegramFetchResponse> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  return fetchImpl(`${baseUrl}/bot${token}/getMe`);
}

async function defaultFetch(url: string): Promise<TelegramFetchResponse> {
  if (typeof fetch !== "function") {
    throw new Error("Telegram reachability check requires global fetch.");
  }
  return fetch(url) as Promise<TelegramFetchResponse>;
}

async function readTelegramJson(response: TelegramFetchResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
