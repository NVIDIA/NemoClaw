// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { saveCredential } from "../credentials/store";
import { HOST_QR_LOGIN_HANDLERS } from "../host-qr-handlers";
import type { ChannelDef } from "../sandbox/channels";

export interface HostQrDispatchOutcome {
  ok: boolean;
  summary?: string;
  reason?: string;
}

/**
 * Run a channel's host-side QR login handler and apply its token +
 * non-secret metadata side effects (credential save, process.env stash,
 * DM-allowlist default). Extracted from `setupMessagingChannels` to keep
 * `src/lib/onboard.ts` focused on flow rather than per-channel mechanism.
 *
 * Belt-and-suspenders: handlers may wrap their own body in try/catch, but
 * a future handler might not — wrap the await in a real try/catch so any
 * throw that escapes before the Promise is returned still becomes a
 * structured "error" outcome and the channel is skipped instead of
 * crashing onboarding.
 */
export async function dispatchHostQrLogin(
  ch: ChannelDef & { name: string },
): Promise<HostQrDispatchOutcome> {
  const handler = HOST_QR_LOGIN_HANDLERS[ch.name];
  if (!handler) return { ok: false, reason: "no host-qr handler registered" };
  let result: Awaited<ReturnType<typeof handler>>;
  try {
    result = await handler();
  } catch (err: unknown) {
    result = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (result.kind !== "ok") {
    const reason =
      result.kind === "timeout"
        ? "QR login timed out"
        : result.kind === "expired"
          ? "QR expired too many times"
          : result.kind === "aborted"
            ? "login aborted"
            : `login failed: ${result.message ?? "unknown error"}`;
    return { ok: false, reason };
  }
  if (result.token) {
    saveCredential(ch.envKey, result.token);
    process.env[ch.envKey] = result.token;
  }
  // Non-secret per-account metadata: the in-sandbox wrapper plugin reads
  // these via NEMOCLAW_*_CONFIG_B64 build args, so seed-wechat-accounts.py
  // (and equivalents) can pre-seed credentials without re-running the QR
  // handshake. See `patchStagedDockerfile`'s `wechatConfig` parameter.
  if (result.extraEnv) {
    for (const [key, value] of Object.entries(result.extraEnv)) {
      process.env[key] = value;
    }
  }
  if (ch.userIdEnvKey && result.defaultUserId && !process.env[ch.userIdEnvKey]) {
    process.env[ch.userIdEnvKey] = result.defaultUserId;
  }
  return { ok: true, summary: result.summary };
}
