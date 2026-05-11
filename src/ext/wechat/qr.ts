// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side iLink QR login client for WeChat (personal).
//
// This is a NemoClaw-native re-implementation of the QR-login handshake
// the upstream @tencent-weixin/openclaw-weixin plugin runs in-sandbox
// (https://docs.openclaw.ai/channels/wechat). Running it on the host
// instead of inside the sandbox lets NemoClaw capture the resulting bot
// token and per-account metadata up front, store the secret in OpenShell
// as a provider credential, and never persist it inside the sandbox image
// or its state directory. The captured session is then seeded into the
// upstream plugin's on-disk account store at image build time (see
// scripts/seed-wechat-accounts.py), so the upstream plugin starts
// already-logged-in and never tries to drive its own QR login inside the
// sandbox.
//
// Endpoints (Tencent iLink CGI, observed against the public gateway):
//   GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3
//     → { qrcode, qrcode_img_content }
//   GET <baseUrl>/ilink/bot/get_qrcode_status?qrcode=<qrcode>
//     → { status, bot_token?, ilink_bot_id?, baseurl?, ilink_user_id?,
//         redirect_host? }   (long-poll, server holds up to ~30s)

/** Fixed iLink gateway used to mint a fresh QR. Per-account base URLs are
 *  served back via the `scaned_but_redirect` status; pin only the bootstrap
 *  host here. */
export const WECHAT_ILINK_BOOTSTRAP_BASE_URL = "https://ilinkai.weixin.qq.com";

/** `bot_type=3` selects the personal-WeChat bot variant on iLink. */
export const WECHAT_ILINK_DEFAULT_BOT_TYPE = "3";

/** Required by iLink — selects the bot client surface. */
export const WECHAT_ILINK_APP_ID = "bot";

/** iLink-App-ClientVersion is encoded as `(major<<16)|(minor<<8)|patch`.
 *  Pinned in lockstep with the @tencent-weixin/openclaw-weixin version
 *  installed in the sandbox image, so the iLink gateway sees the same
 *  client version from both the host login and the in-sandbox plugin.
 *  Bump together with the version pinned in the Dockerfile. */
export const WECHAT_ILINK_CLIENT_VERSION = encodeIlinkClientVersion("2.4.2");

/** Client-side ceiling for a single status long-poll. 35s keeps us within
 *  typical 60s gateway/proxy idle windows. */
export const WECHAT_QR_POLL_TIMEOUT_MS = 35_000;

export type WechatQrStatus = "wait" | "scaned" | "expired" | "confirmed" | "scaned_but_redirect";

export interface WechatQrSession {
  /** Opaque token to pass to subsequent status polls. Treat as secret-ish:
   *  exposing it lets a third party hijack this in-flight login. */
  qrcode: string;
  /** URL the user opens / scans in WeChat. Safe to render. */
  qrcodeUrl: string;
}

export interface WechatQrStatusResponse {
  status: WechatQrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

/** Minimal fetch contract — covers the global `fetch` and any test fake. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface WechatQrClientOptions {
  /** Override transport; defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Override bootstrap base URL — useful for offline tests. */
  bootstrapBaseUrl?: string;
  /** Override bot type — defaults to `3` (personal WeChat). */
  botType?: string;
  /** Hard cap on the bootstrap request. Default 10s — long enough for the
   *  iLink TLS handshake on a slow network, short enough that a black-holed
   *  gateway doesn't hang the onboarding flow indefinitely. */
  timeoutMs?: number;
}

const WECHAT_QR_BOOTSTRAP_TIMEOUT_MS = 10_000;

const KNOWN_WECHAT_QR_STATUSES: ReadonlySet<WechatQrStatus> = new Set([
  "wait",
  "scaned",
  "expired",
  "confirmed",
  "scaned_but_redirect",
]);

export class WechatQrError extends Error {
  constructor(
    public readonly kind: "network" | "http" | "parse",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "WechatQrError";
  }
}

/** Encode a SemVer string the way iLink expects: `(major<<16)|(minor<<8)|patch`. */
export function encodeIlinkClientVersion(semver: string): number {
  const parts = semver.split(".").map((p) => Number.parseInt(p, 10));
  const major = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1] : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2] : 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function buildIlinkHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": WECHAT_ILINK_APP_ID,
    "iLink-App-ClientVersion": String(WECHAT_ILINK_CLIENT_VERSION),
  };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Bootstrap a new QR session against the fixed iLink host. The returned
 *  `qrcode` is the cookie used for subsequent polling; `qrcodeUrl` is what
 *  the operator scans in WeChat. */
export async function fetchWechatQrSession(
  opts: WechatQrClientOptions = {},
): Promise<WechatQrSession> {
  const transport = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!transport) {
    throw new WechatQrError("network", "global fetch is not available; pass opts.fetch");
  }
  const baseUrl = ensureTrailingSlash(opts.bootstrapBaseUrl ?? WECHAT_ILINK_BOOTSTRAP_BASE_URL);
  const botType = opts.botType ?? WECHAT_ILINK_DEFAULT_BOT_TYPE;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    baseUrl,
  );

  const timeoutMs = opts.timeoutMs ?? WECHAT_QR_BOOTSTRAP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await transport(url.toString(), {
      method: "GET",
      headers: buildIlinkHeaders(),
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new WechatQrError(
        "network",
        `WeChat QR init request timed out after ${timeoutMs}ms`,
      );
    }
    throw new WechatQrError("network", `WeChat QR init request failed: ${stringify(err)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await safeText(response);
    throw new WechatQrError("http", `WeChat QR init returned ${response.status}: ${body}`, response.status);
  }
  const text = await response.text();
  let parsed: { qrcode?: unknown; qrcode_img_content?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    throw new WechatQrError("parse", `WeChat QR init returned non-JSON body: ${stringify(err)}`);
  }
  if (typeof parsed.qrcode !== "string" || typeof parsed.qrcode_img_content !== "string") {
    throw new WechatQrError(
      "parse",
      "WeChat QR init response missing qrcode or qrcode_img_content fields",
    );
  }
  return { qrcode: parsed.qrcode, qrcodeUrl: parsed.qrcode_img_content };
}

/** Long-poll status for an existing QR session. The `baseUrl` may change
 *  mid-flow when the server returns `scaned_but_redirect`; callers should
 *  pass the latest base URL. Treats abort and gateway timeouts as a benign
 *  `wait` so the orchestrator can simply re-poll. The `onDebug` callback
 *  fires for the silently-swallowed events (transport errors, 5xx, abort)
 *  so the orchestrator can surface them when needed — without it, those
 *  failures are invisible to the operator. */
export async function pollWechatQrStatus(params: {
  baseUrl: string;
  qrcode: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDebug?: (event: string) => void;
}): Promise<WechatQrStatusResponse> {
  const transport = params.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!transport) {
    throw new WechatQrError("network", "global fetch is not available; pass params.fetch");
  }
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
    ensureTrailingSlash(params.baseUrl),
  );

  const timeoutMs = params.timeoutMs ?? WECHAT_QR_POLL_TIMEOUT_MS;
  const localController = new AbortController();
  const timer = setTimeout(() => localController.abort(), timeoutMs);
  const externalAbort = () => localController.abort();
  if (params.signal) {
    if (params.signal.aborted) localController.abort();
    else params.signal.addEventListener("abort", externalAbort, { once: true });
  }

  try {
    let response: Awaited<ReturnType<FetchLike>>;
    params.onDebug?.(`poll request → ${url.toString()}`);
    try {
      response = await transport(url.toString(), {
        method: "GET",
        headers: buildIlinkHeaders(),
        signal: localController.signal,
      });
    } catch (err) {
      // Abort and gateway-timeout-shaped errors fall through as `wait`.
      // Only the orchestrator's overall deadline ends the loop.
      if (isAbortError(err)) {
        params.onDebug?.(`poll abort (treated as wait)`);
        return { status: "wait" };
      }
      params.onDebug?.(`poll transport error: ${stringify(err)} (treated as wait)`);
      return { status: "wait" };
    }
    params.onDebug?.(`poll response ← status=${response.status}`);
    if (!response.ok) {
      // 5xx gateway hiccups also fall through as `wait` — Cloudflare 524s
      // are routine on the iLink long-poll path.
      if (response.status >= 500) {
        params.onDebug?.(`poll http ${response.status} (treated as wait)`);
        return { status: "wait" };
      }
      const body = await safeText(response);
      throw new WechatQrError(
        "http",
        `WeChat QR status returned ${response.status}: ${body}`,
        response.status,
      );
    }
    const text = await response.text();
    let parsed: WechatQrStatusResponse;
    try {
      parsed = JSON.parse(text) as WechatQrStatusResponse;
    } catch (err) {
      throw new WechatQrError("parse", `WeChat QR status returned non-JSON body: ${stringify(err)}`);
    }
    if (typeof parsed?.status !== "string") {
      throw new WechatQrError("parse", "WeChat QR status response missing 'status' field");
    }
    if (!KNOWN_WECHAT_QR_STATUSES.has(parsed.status as WechatQrStatus)) {
      throw new WechatQrError(
        "parse",
        `WeChat QR status returned unknown status '${parsed.status}'`,
      );
    }
    return parsed;
  } finally {
    clearTimeout(timer);
    if (params.signal) params.signal.removeEventListener("abort", externalAbort);
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
