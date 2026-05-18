// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Host-side WeChat (personal) QR login orchestration.
//
// Drives the iLink QR handshake end-to-end: fetch the QR, render it in the
// terminal, poll for status, handle IDC redirects + QR refresh on expiry,
// and return the resulting credentials. Pure orchestration — the iLink
// HTTP layer lives in ./qr.ts and the terminal renderer is injected so
// tests can stay offline.

import {
  fetchWechatQrSession,
  pollWechatQrStatus,
  type FetchLike,
  type WechatQrSession,
  type WechatQrStatusResponse,
  WechatQrError,
  WECHAT_ILINK_BOOTSTRAP_BASE_URL,
} from "./qr";

/** Total deadline for a single login attempt. 8 minutes is long enough to
 *  cover a slow human + IDC redirects and short enough that a forgotten
 *  terminal eventually times out. */
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000;

/** Pause between status polls when the server returned a fast response. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Maximum number of QR refresh attempts per login. */
const MAX_QR_REFRESH_COUNT = 3;

export interface WechatLoginCredentials {
  /** Bot token. Persist into OpenShell as the `WECHAT_BOT_TOKEN` provider
   *  credential; never write to disk. */
  token: string;
  /** Stable per-account id (`ilink_bot_id`). Non-secret. */
  accountId: string;
  /** Per-account base URL for subsequent CGI calls. Rotates via IDC; treat
   *  as authoritative at login time and re-fetch on next login. */
  baseUrl: string;
  /** WeChat user id of the operator who scanned. Add to `WECHAT_ALLOWED_IDS`
   *  unless overridden. Non-secret but PII-adjacent — redact when logging. */
  userId: string;
}

export type WechatLoginResult =
  | { kind: "ok"; credentials: WechatLoginCredentials }
  | { kind: "timeout" }
  | { kind: "expired"; reason: "max_refresh_exceeded" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

export interface WechatLoginOptions {
  /** Inject a fetch fake for tests. */
  fetch?: FetchLike;
  /** Render a QR in the terminal. Defaults to qrcode-terminal. Tests can
   *  swap this for a no-op or capture. */
  renderQr?: (qrUrl: string) => void;
  /** Sink for human-readable progress messages. Defaults to stderr; tests
   *  can capture. */
  log?: (message: string) => void;
  /** Cooperative cancellation hook. */
  signal?: AbortSignal;
  /** Override the overall login deadline. */
  totalTimeoutMs?: number;
  /** Override the inter-poll pause. */
  pollIntervalMs?: number;
  /** Override the bootstrap iLink host (offline tests). */
  bootstrapBaseUrl?: string;
  /** Clock seam for tests. */
  now?: () => number;
  /** Sleep seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface ResolvedLoginOptions {
  fetch?: FetchLike;
  renderQr: (qrUrl: string) => void;
  log: (message: string) => void;
  signal?: AbortSignal;
  totalTimeoutMs: number;
  pollIntervalMs: number;
  bootstrapBaseUrl: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Default terminal renderer. Loaded lazily so unit tests that mock the
 *  renderer don't pay the import cost or the side effect of writing to
 *  stdout. */
function defaultRenderer(qrUrl: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const qrterm = require("qrcode-terminal") as {
    generate(text: string, opts: { small?: boolean }, cb?: (rendered: string) => void): void;
  };
  qrterm.generate(qrUrl, { small: true });
}

function resolveOptions(opts: WechatLoginOptions = {}): ResolvedLoginOptions {
  return {
    fetch: opts.fetch,
    renderQr: opts.renderQr ?? defaultRenderer,
    log: opts.log ?? ((msg: string) => process.stderr.write(`${msg}\n`)),
    signal: opts.signal,
    totalTimeoutMs: opts.totalTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    bootstrapBaseUrl: opts.bootstrapBaseUrl ?? WECHAT_ILINK_BOOTSTRAP_BASE_URL,
    now: opts.now ?? (() => Date.now()),
    // Do NOT unref this timer. The inter-poll sleep is the only thing
    // holding the event loop open between iterations once the previous
    // fetch's keep-alive socket is released (notably after an IDC redirect
    // switches hosts). An unref'd timer there causes Node to exit silently
    // mid-login.
    sleep:
      opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}

function emitQr(session: WechatQrSession, opts: ResolvedLoginOptions): void {
  opts.log("");
  opts.log("  Scan the QR below with WeChat on your phone (look for: Discover → Scan).");
  opts.log("  If the QR does not render, open this URL on your phone instead:");
  opts.log(`    ${session.qrcodeUrl}`);
  opts.log("");
  try {
    opts.renderQr(session.qrcodeUrl);
  } catch (err) {
    opts.log(`  (could not render terminal QR: ${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Run the host-side QR login end-to-end. Returns a discriminated result so
 *  callers can branch on success/expiry/timeout/abort without try/catch. */
export async function runWechatHostQrLogin(
  options: WechatLoginOptions = {},
): Promise<WechatLoginResult> {
  const opts = resolveOptions(options);
  if (opts.signal?.aborted) return { kind: "aborted" };

  let session: WechatQrSession;
  try {
    session = await fetchWechatQrSession({
      fetch: opts.fetch,
      bootstrapBaseUrl: opts.bootstrapBaseUrl,
    });
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }

  emitQr(session, opts);
  let scannedAnnounced = false;
  // Counts refreshes only (the initial QR is not a refresh). MAX_QR_REFRESH_COUNT
  // is the upper bound on refreshes per login; starting at 0 keeps the
  // increment-then-compare guard at "case expired" allowing exactly that many.
  let qrRefreshCount = 0;
  let currentBaseUrl = opts.bootstrapBaseUrl;
  const deadline = opts.now() + opts.totalTimeoutMs;
  let lastStatus: string | undefined;
  // Diagnostic sink — visible by default while the WeChat path is new so
  // operators can self-diagnose IDC redirects and silently-swallowed
  // gateway errors. Quiet via NEMOCLAW_WECHAT_QUIET=1 once the flow is
  // stable in their environment.
  const debug = process.env.NEMOCLAW_WECHAT_QUIET === "1"
    ? (_msg: string) => {}
    : (msg: string) => opts.log(`  [wechat] ${msg}`);
  debug(`polling ${currentBaseUrl}`);

  while (opts.now() < deadline) {
    if (opts.signal?.aborted) return { kind: "aborted" };

    let status: WechatQrStatusResponse;
    try {
      status = await pollWechatQrStatus({
        baseUrl: currentBaseUrl,
        qrcode: session.qrcode,
        fetch: opts.fetch,
        signal: opts.signal,
        onDebug: debug,
      });
    } catch (err) {
      // pollWechatQrStatus already swallows abort + gateway timeouts; any
      // error escaping here is a real protocol/HTTP failure we can't recover
      // from without restarting the login.
      debug(`poll fatal: ${errorMessage(err)}`);
      return { kind: "error", message: errorMessage(err) };
    }
    if (status.status !== lastStatus) {
      debug(
        `status=${status.status}${status.redirect_host ? ` redirect_host=${status.redirect_host}` : ""}`,
      );
      lastStatus = status.status;
    }

    switch (status.status) {
      case "wait":
        await opts.sleep(opts.pollIntervalMs);
        continue;

      case "scaned":
        if (!scannedAnnounced) {
          opts.log("  ✓ QR scanned. Confirm the login on your phone to continue…");
          scannedAnnounced = true;
        }
        await opts.sleep(opts.pollIntervalMs);
        continue;

      case "scaned_but_redirect": {
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`;
          opts.log(`  → IDC redirect — continuing on ${status.redirect_host}`);
          debug(`polling ${currentBaseUrl}`);
        }
        await opts.sleep(opts.pollIntervalMs);
        continue;
      }

      case "expired": {
        qrRefreshCount += 1;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          return { kind: "expired", reason: "max_refresh_exceeded" };
        }
        opts.log(`  ⏳ QR expired — refreshing (${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})…`);
        try {
          session = await fetchWechatQrSession({
            fetch: opts.fetch,
            bootstrapBaseUrl: opts.bootstrapBaseUrl,
          });
        } catch (err) {
          return { kind: "error", message: errorMessage(err) };
        }
        currentBaseUrl = opts.bootstrapBaseUrl;
        scannedAnnounced = false;
        emitQr(session, opts);
        await opts.sleep(opts.pollIntervalMs);
        continue;
      }

      case "confirmed": {
        const credentials = extractCredentials(status);
        if (!credentials) {
          return {
            kind: "error",
            message: "WeChat login confirmed but server omitted bot_token / ilink_bot_id.",
          };
        }
        opts.log("  ✓ WeChat login confirmed.");
        return { kind: "ok", credentials };
      }
    }
  }

  return { kind: "timeout" };
}

function extractCredentials(status: WechatQrStatusResponse): WechatLoginCredentials | null {
  if (
    typeof status.bot_token !== "string" ||
    typeof status.ilink_bot_id !== "string" ||
    typeof status.baseurl !== "string" ||
    typeof status.ilink_user_id !== "string"
  ) {
    return null;
  }
  return {
    token: status.bot_token,
    accountId: normalizeWeixinAccountId(status.ilink_bot_id),
    baseUrl: status.baseurl,
    userId: status.ilink_user_id,
  };
}

/** Mirrors `normalizeAccountId` from `openclaw/plugin-sdk/account-id`, which
 *  the upstream @tencent-weixin/openclaw-weixin plugin uses to derive its
 *  on-disk filenames. Replaces `@` and `.` with `-` so e.g.
 *  `b0f5860fdecb@im.bot` → `b0f5860fdecb-im-bot`. We normalize at capture
 *  time so the build-time seed step writes files under the same name the
 *  upstream plugin will look for at runtime. */
export function normalizeWeixinAccountId(rawId: string): string {
  return rawId.replace(/[@.]/g, "-");
}

function errorMessage(err: unknown): string {
  if (err instanceof WechatQrError) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
