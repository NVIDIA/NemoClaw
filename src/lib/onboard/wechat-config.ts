// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../credentials/store";
import type { Session } from "../state/onboard-session";

export interface WechatConfigSnapshot {
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

/**
 * Read WeChat per-account metadata. Prefers fresh values from
 * `process.env` (set by the host-qr handler this run, or by
 * `rebuildSandbox`'s env-stash); falls back to the recorded session for
 * the resume case where `setupMessagingChannels` short-circuits the
 * host-qr handler because the bot token is already cached.
 *
 * Non-secret — the bot token lives in the OpenShell provider, not here.
 * The metadata is what `patchStagedDockerfile` serializes into
 * `NEMOCLAW_WECHAT_CONFIG_B64` so `seed-wechat-accounts.py` can write
 * `<stateDir>/openclaw-weixin/accounts/<id>.json` at image-build time.
 */
export function gatherWechatConfig(session: Session | null): WechatConfigSnapshot {
  const cfg: WechatConfigSnapshot = {};
  const accountId = normalizeCredentialValue(process.env.WECHAT_ACCOUNT_ID || "");
  const baseUrl = normalizeCredentialValue(process.env.WECHAT_BASE_URL || "");
  const userId = normalizeCredentialValue(process.env.WECHAT_USER_ID || "");
  if (accountId) cfg.accountId = accountId;
  if (baseUrl) cfg.baseUrl = baseUrl;
  if (userId) cfg.userId = userId;
  if (Object.keys(cfg).length === 0 && session?.wechatConfig) {
    if (session.wechatConfig.accountId) cfg.accountId = session.wechatConfig.accountId;
    if (session.wechatConfig.baseUrl) cfg.baseUrl = session.wechatConfig.baseUrl;
    if (session.wechatConfig.userId) cfg.userId = session.wechatConfig.userId;
  }
  return cfg;
}

/**
 * Detect WeChat account drift on resume: a fresh host-qr login (or env
 * stash) produced an accountId/baseUrl/userId triple that differs from
 * what was recorded in the session. Forces a sandbox recreate because
 * the per-account base URL is baked into `openclaw.json` at build time —
 * an unchanged image would keep talking to the previous IDC host.
 */
export function hasWechatConfigDrift(session: Session | null): boolean {
  const recorded = session?.wechatConfig ?? null;
  const accountId = normalizeCredentialValue(process.env.WECHAT_ACCOUNT_ID || "");
  if (!accountId) return false;
  const baseUrl = normalizeCredentialValue(process.env.WECHAT_BASE_URL || "");
  const userId = normalizeCredentialValue(process.env.WECHAT_USER_ID || "");
  return (
    (recorded?.accountId ?? "") !== accountId ||
    (recorded?.baseUrl ?? "") !== baseUrl ||
    (recorded?.userId ?? "") !== userId
  );
}

/**
 * Build the `Session.wechatConfig` payload for `updateSession`. Returns
 * `null` when the snapshot has no fields so the session field stays
 * normalized (matches `parseWechatConfig`'s null-on-empty contract).
 */
export function toSessionWechatConfig(
  cfg: WechatConfigSnapshot,
): { accountId?: string; baseUrl?: string; userId?: string } | null {
  return Object.keys(cfg).length > 0
    ? { accountId: cfg.accountId, baseUrl: cfg.baseUrl, userId: cfg.userId }
    : null;
}
