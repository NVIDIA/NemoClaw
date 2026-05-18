// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pluggable host-side QR login handlers.
//
// Channels marked `loginMethod: "host-qr"` in KNOWN_CHANNELS dispatch through
// this registry instead of the paste prompt. Each handler runs the
// provider-specific QR handshake on the host (so the operator can scan with
// a phone), captures the bot token + non-secret account metadata, and
// returns a normalized result that the onboard flow can apply uniformly.
//
// To register a new host-qr channel:
//   1. Add `loginMethod: "host-qr"` to its ChannelDef in sandbox-channels.ts.
//   2. Add an entry to HOST_QR_LOGIN_HANDLERS below — keep the QR/network
//      code under src/ext/<channel>/ and only the adapter here.

export type HostQrLoginKind = "ok" | "timeout" | "expired" | "aborted" | "error";

export interface HostQrLoginResult {
  kind: HostQrLoginKind;
  /** Free-text reason; populated for kind="error". */
  message?: string;
  /** Bot token to save under the channel's envKey. Required for kind="ok". */
  token?: string;
  /** Non-secret per-account metadata to stash on process.env so the
   *  Dockerfile-patch path can serialize it into the channel's build args
   *  (e.g. NEMOCLAW_WECHAT_CONFIG_B64). Keys are env-var names. */
  extraEnv?: Record<string, string>;
  /** User id to seed into the channel's userIdEnvKey when one isn't set
   *  (DM-allowlist convenience). */
  defaultUserId?: string;
  /** One-line summary appended to the success log,
   *  e.g. `✓ wechat token saved (account 12345)`. */
  summary?: string;
}

export type HostQrLoginHandler = () => Promise<HostQrLoginResult>;

export const HOST_QR_LOGIN_HANDLERS: Record<string, HostQrLoginHandler> = {
  wechat: async () => {
    // Wrap the lazy require + the runWechatHostQrLogin call in a single
    // try/catch so any unexpected throw (missing module after bundling, a
    // qrcode-terminal native-IO error, an iLink protocol edge case that
    // escapes the discriminated result) turns into a structured "error"
    // result the onboard dispatcher already knows how to render — instead
    // of bubbling an unhandled rejection up through the registry.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { runWechatHostQrLogin } = require("../ext/wechat/login") as {
        runWechatHostQrLogin: typeof import("../ext/wechat/login").runWechatHostQrLogin;
      };
      const result = await runWechatHostQrLogin();
      if (result.kind !== "ok") {
        return result.kind === "error"
          ? { kind: "error", message: result.message }
          : { kind: result.kind };
      }
      const { token, accountId, baseUrl, userId } = result.credentials;
      return {
        kind: "ok",
        token,
        extraEnv: {
          WECHAT_ACCOUNT_ID: accountId,
          WECHAT_BASE_URL: baseUrl,
          WECHAT_USER_ID: userId,
        },
        defaultUserId: userId,
        summary: `account ${accountId}`,
      };
    } catch (err) {
      return {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
