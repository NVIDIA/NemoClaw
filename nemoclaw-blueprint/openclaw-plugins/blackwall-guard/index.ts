// SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * BLACK_WALL Preflight Guardrail — NemoClaw blueprint plugin.
 *
 * Registers `before_tool_call` + `after_tool_call` hooks with OpenClaw and calls
 * the BLACK_WALL forecast() API to score every tool call BEFORE it executes. In
 * enforce mode it blocks STOP verdicts and (by default) blocks CAUTION verdicts —
 * this runtime has no interactive approval surface; in observe mode it only logs.
 * Every verdict carries an Ed25519-signed receipt that can be verified offline.
 *
 * Self-contained by design: a NemoClaw blueprint plugin is dropped in as a single
 * directory with no node_modules, so the proxy-aware HTTPS client (a raw CONNECT
 * tunnel built on node:net + node:tls) and the forecast/observe calls are inlined
 * here rather than imported from an npm package.
 *
 *   Docs: https://blackwalltier.com  ·  free key: https://blackwalltier.com/dashboard/keys
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import net from "node:net";
import tls from "node:tls";
import { openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = "observe" | "enforce";
type CautionAction = "approve" | "block" | "allow";
type Recommendation = "GO" | "CAUTION" | "STOP" | (string & {});

interface RedFlag {
  code?: string;
  severity?: string;
  message?: string;
}

/** Parsed forecast() response. The API returns more fields; these are the ones the gate reads. */
interface ForecastVerdict {
  id?: string;
  recommendation?: Recommendation;
  risk_score?: number;
  red_flags?: RedFlag[];
  [key: string]: unknown;
}

interface ForecastArgs {
  action: string;
  inputs: unknown;
  context?: Record<string, unknown>;
  depth?: "standard" | "deep";
  parent_forecast_id?: string;
}

interface CallOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  reportedVia?: string;
}

interface ObserveArgs {
  outcome_class?: "matched" | "over_scope" | "under_scope" | "no_op" | "diverged" | "aborted";
  divergence_severity?: "none" | "low" | "medium" | "high" | "critical";
  actual_targets?: string[];
  details?: string;
}

/** The `fetch`-compatible subset that forecast()/observe() consume. */
interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}
type FetchLike = (url: string, init?: Record<string, any>) => Promise<FetchLikeResponse>;

/** Plugin configuration. Every field also has an env-var equivalent (see resolveConfig). */
export interface BlackwallConfig {
  apiKey?: string;
  baseUrl?: string;
  mode?: Mode;
  cautionAction?: CautionAction;
  failClosed?: boolean;
  shouldGate?: (toolName: string) => boolean;
  maxInputBytes?: number;
  forecastTimeoutMs?: number;
  onEvent?: ((event: Record<string, unknown>) => void) | null;
  forecast?: typeof forecast;
  observe?: typeof observe;
}

interface ResolvedConfig {
  apiKey?: string;
  baseUrl?: string;
  mode: Mode;
  failClosed: boolean;
  cautionAction: CautionAction;
  shouldGate: (toolName: string) => boolean;
  maxInputBytes: number;
  forecastTimeoutMs: number;
  onEvent: ((event: Record<string, unknown>) => void) | null;
  forecast: typeof forecast;
  observe: typeof observe;
}

interface HttpError extends Error {
  status?: number;
  body?: unknown;
  forecastId?: string;
  cause?: unknown;
}

const DEFAULT_BASE_URL = "https://blackwalltier.com";

// ---------------------------------------------------------------------------
// Proxy-aware HTTPS client (zero-dependency CONNECT tunnel)
//
// Node's global fetch (undici) IGNORES HTTP(S)_PROXY. In a default-deny /
// proxy-only-egress network — NemoClaw's sandbox, most corporate proxies — a
// direct fetch() to the API is dropped at the firewall. This tunnels the request
// through the proxy via an HTTP CONNECT using only node:net + node:tls.
// ---------------------------------------------------------------------------

// Hard cap on a buffered response body. A verdict is a few KB of JSON; the proxy
// is the (untrusted) egress point and could otherwise stream an unbounded body and
// exhaust memory. Override via BLACKWALL_MAX_RESPONSE_BYTES (floor 64 KiB).
const MAX_RESPONSE_BYTES = Math.max(
  64 * 1024,
  Number(process.env.BLACKWALL_MAX_RESPONSE_BYTES) || 8 * 1024 * 1024,
);

/** Pick the proxy for a target URL from the environment, honoring NO_PROXY. */
function getProxyForUrl(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return null;
  }
  const noProxy = env.NO_PROXY || env.no_proxy || "";
  if (noProxy.trim()) {
    const host = u.hostname;
    for (const raw of noProxy.split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      if (entry === "*") return null;
      const bare = entry.replace(/^\./, "");
      if (host === bare || host.endsWith("." + bare)) return null;
    }
  }
  const proxy =
    u.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
      : env.HTTP_PROXY || env.http_proxy;
  return proxy && proxy.trim() ? proxy.trim() : null;
}

// Refuse to send the API key over plaintext HTTP to a network peer. HTTPS is
// required for any non-loopback host; loopback (localhost, 127.0.0.0/8, ::1) may
// use http since no off-host observer sees it. Throws BEFORE any request or
// Authorization header is emitted; returns the base URL unchanged when allowed.
export function requireSecureBaseUrl(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(
      `BLACK_WALL: invalid base URL ${JSON.stringify(baseUrl)} -- expected an https:// URL.`,
    );
  }
  if (u.protocol === "https:") return baseUrl;
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const isLoopback =
    host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (u.protocol === "http:" && isLoopback) return baseUrl;
  throw new Error(
    `BLACK_WALL: refusing to send the API key over ${u.protocol}// to "${host}" -- the base ` +
      `URL MUST be https:// (plaintext http is allowed only for loopback). ` +
      `Set BLACKWALL_BASE_URL to an https:// endpoint.`,
  );
}

// Strip CR/LF so a hostile header/key value can't inject extra request headers.
const clean = (v: unknown): string => String(v).replace(/[\r\n]/g, "");

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl === -1) break;
    const size = parseInt(buf.slice(i, nl).toString("latin1").trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out.push(buf.slice(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

/** Build a fetch-like function that tunnels HTTPS requests through an HTTP CONNECT proxy. */
export function proxyFetch(
  proxyUrl: string,
  opts: { tls?: Record<string, unknown> } = {},
): FetchLike {
  const proxy = new URL(proxyUrl);
  return function fetchViaProxy(
    targetUrl: string,
    init: Record<string, any> = {},
  ): Promise<FetchLikeResponse> {
    return new Promise<FetchLikeResponse>((resolve, reject) => {
      const target = new URL(targetUrl);
      if (target.protocol !== "https:") {
        reject(new Error("proxyFetch supports https targets only"));
        return;
      }
      const targetHost = target.hostname;
      const targetPort = target.port || "443";
      const signal: AbortSignal | undefined = init.signal;

      let settled = false;
      let proxySocket: net.Socket | undefined;
      let tlsSocket: tls.TLSSocket | undefined;
      const cleanup = () => {
        try {
          tlsSocket && tlsSocket.destroy();
        } catch {
          /* ignore */
        }
        try {
          proxySocket && proxySocket.destroy();
        } catch {
          /* ignore */
        }
        if (signal && signal.removeEventListener) signal.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };
      const done = (val: FetchLikeResponse) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(val);
        }
      };
      const onAbort = () =>
        fail(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

      if (signal) {
        if (signal.aborted) return onAbort();
        if (signal.addEventListener) signal.addEventListener("abort", onAbort, { once: true });
      }

      // 1) TCP connect to the proxy.
      proxySocket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
      proxySocket.on("error", fail);

      proxySocket.once("connect", () => {
        // 2) Ask the proxy to open a raw tunnel to the target host:port.
        let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
        if (proxy.username) {
          const creds = Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString("base64");
          req += `Proxy-Authorization: Basic ${creds}\r\n`;
        }
        req += "Connection: keep-alive\r\n\r\n";
        proxySocket!.write(req);

        // The proxy is untrusted (§ proxyFetch): bound the CONNECT-response header it
        // can accumulate so it can't grow process memory unbounded by withholding the
        // "\r\n\r\n" terminator or streaming an enormous header.
        const MAX_CONNECT_HEADER_BYTES = 64 * 1024;
        let buf = Buffer.alloc(0);
        const onConnectData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) {
            if (buf.length > MAX_CONNECT_HEADER_BYTES) {
              proxySocket!.removeListener("data", onConnectData);
              fail(
                new Error(
                  `proxy CONNECT response header exceeded ${MAX_CONNECT_HEADER_BYTES} bytes without terminator`,
                ),
              );
            }
            return;
          }
          proxySocket!.removeListener("data", onConnectData);
          const statusLine = buf.slice(0, buf.indexOf("\r\n")).toString("latin1");
          const m = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
          if (!m || m[1] !== "200") {
            fail(new Error(`proxy CONNECT rejected: ${statusLine || "(no status)"}`));
            return;
          }
          // Hand any post-CONNECT bytes back to the socket so TLS reads them.
          const rest = buf.slice(idx + 4);
          if (rest.length) proxySocket!.unshift(rest);

          // 3) TLS over the tunnel (verifies the target cert by default).
          tlsSocket = tls.connect({
            socket: proxySocket,
            servername: targetHost,
            ...(opts.tls || {}),
          });
          tlsSocket.on("error", fail);
          tlsSocket.once("secureConnect", sendRequest);
        };
        proxySocket!.on("data", onConnectData);
      });

      const sendRequest = () => {
        const method = (init.method || "GET").toUpperCase();
        const path = target.pathname + target.search;
        const headers: Record<string, unknown> = init.headers || {};
        const bodyBuf =
          init.body == null
            ? null
            : Buffer.from(typeof init.body === "string" ? init.body : JSON.stringify(init.body));

        let req = `${method} ${path} HTTP/1.1\r\nHost: ${clean(targetHost)}\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          if (["host", "content-length", "connection"].includes(k.toLowerCase())) continue;
          req += `${clean(k)}: ${clean(v)}\r\n`;
        }
        if (bodyBuf) req += `Content-Length: ${bodyBuf.length}\r\n`;
        req += "Connection: close\r\n\r\n";
        tlsSocket!.write(req);
        if (bodyBuf) tlsSocket!.write(bodyBuf);

        const chunks: Buffer[] = [];
        let received = 0;
        tlsSocket!.on("data", (c: Buffer) => {
          received += c.length;
          if (received > MAX_RESPONSE_BYTES) {
            fail(new Error(`response body too large (exceeded ${MAX_RESPONSE_BYTES} bytes)`));
            return;
          }
          chunks.push(c);
        });
        tlsSocket!.on("end", () => finish(Buffer.concat(chunks)));
        tlsSocket!.on("close", () => {
          if (!settled) finish(Buffer.concat(chunks));
        });
      };

      const finish = (raw: Buffer) => {
        const sep = raw.indexOf("\r\n\r\n");
        if (sep === -1) {
          fail(new Error("malformed response: no header terminator"));
          return;
        }
        const headPart = raw.slice(0, sep).toString("latin1");
        const rawBody = raw.slice(sep + 4);
        const lines = headPart.split("\r\n");
        const statusLine = lines.shift() || "";
        const sm = /^HTTP\/\d\.\d (\d{3})(?: (.*))?$/.exec(statusLine);
        const status = sm ? Number(sm[1]) : 0;
        const statusText = sm ? sm[2] || "" : "";
        const respHeaders: Record<string, string> = {};
        for (const line of lines) {
          const ci = line.indexOf(":");
          if (ci > 0)
            respHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
        }
        const isChunked = (respHeaders["transfer-encoding"] || "")
          .toLowerCase()
          .includes("chunked");
        const text = (isChunked ? dechunk(rawBody) : rawBody).toString("utf8");
        done({
          ok: status >= 200 && status < 300,
          status,
          statusText,
          headers: { get: (k: string) => respHeaders[String(k).toLowerCase()] ?? null },
          async text() {
            return text;
          },
          async json() {
            return JSON.parse(text);
          },
        });
      };
    });
  };
}

// ---------------------------------------------------------------------------
// forecast() / observe() — the BLACK_WALL REST calls
// ---------------------------------------------------------------------------

/**
 * Call BLACK_WALL forecast. Returns the parsed verdict on a 2xx with a usable
 * body, else throws. Fails CLOSED on a verdict-less 2xx (CDN interstitial,
 * captive portal, truncated proxy body) so a malformed response is never read as
 * "proceed". Error objects carry `.status` / `.body` on HTTP failures.
 */
async function forecast(
  { action, inputs, context, depth, parent_forecast_id }: ForecastArgs,
  opts: CallOptions = {},
): Promise<ForecastVerdict> {
  const apiKey = opts.apiKey ?? process.env.BLACKWALL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BLACK_WALL: missing apiKey (set BLACKWALL_API_KEY or pass opts.apiKey). " +
        "Free key at https://blackwalltier.com/dashboard/keys",
    );
  }
  const baseUrl = requireSecureBaseUrl(
    (opts.baseUrl ?? process.env.BLACKWALL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
  );
  const url = `${baseUrl}/api/v1/forecast`;
  const proxy = opts.fetch ? null : getProxyForUrl(url);
  const fetchImpl: FetchLike | undefined =
    opts.fetch ?? (proxy ? proxyFetch(proxy) : (globalThis.fetch as unknown as FetchLike));
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "BLACK_WALL: no fetch implementation available — pass opts.fetch or run on Node >=18.",
    );
  }

  // A pre-action gate must answer quickly or fail — never hang the caller on a dead backend.
  const timeoutMs = Math.max(
    1000,
    Number(opts.timeoutMs ?? process.env.BLACKWALL_TIMEOUT_MS) || 15000,
  );
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        inputs,
        ...(context ? { context } : {}),
        ...(depth ? { options: { depth } } : {}),
        ...(parent_forecast_id ? { parent_forecast_id } : {}),
      }),
      signal,
    });
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const wrapped: HttpError = new Error(
      timedOut
        ? `BLACK_WALL forecast request timed out after ${timeoutMs}ms`
        : `BLACK_WALL forecast request failed (network): ${err?.message ?? err}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }

  const data = (await res.json().catch(() => ({}))) as ForecastVerdict;

  if (!res.ok) {
    const msg = (data as any)?.message || (data as any)?.error || `HTTP ${res.status}`;
    const err: HttpError = new Error(`BLACK_WALL forecast error (${res.status}): ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  if (!data || typeof data !== "object" || data.recommendation == null || data.risk_score == null) {
    const err: HttpError = new Error(
      "BLACK_WALL forecast returned no usable risk verdict (a 2xx response with an unparseable or verdict-less body).",
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

/** Report the actual outcome of an action against an earlier forecast. Free (no tokens). */
async function observe(
  forecastId: string,
  args: ObserveArgs = {},
  opts: CallOptions = {},
): Promise<Record<string, unknown>> {
  if (!forecastId || typeof forecastId !== "string") {
    throw new Error("BLACK_WALL observe: forecastId (string) is required.");
  }
  const apiKey = opts.apiKey ?? process.env.BLACKWALL_API_KEY;
  if (!apiKey) {
    throw new Error(
      "BLACK_WALL observe: missing apiKey (set BLACKWALL_API_KEY or pass opts.apiKey).",
    );
  }
  const baseUrl = requireSecureBaseUrl(
    (opts.baseUrl ?? process.env.BLACKWALL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
  );
  const url = `${baseUrl}/api/v1/forecast/${encodeURIComponent(forecastId)}/outcome`;
  const proxy = opts.fetch ? null : getProxyForUrl(url);
  const fetchImpl: FetchLike | undefined =
    opts.fetch ?? (proxy ? proxyFetch(proxy) : (globalThis.fetch as unknown as FetchLike));
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "BLACK_WALL observe: no fetch implementation available — pass opts.fetch or run on Node >=18.",
    );
  }

  const timeoutMs = Math.max(
    1000,
    Number(opts.timeoutMs ?? process.env.BLACKWALL_TIMEOUT_MS) || 15000,
  );
  const signal = opts.signal ?? AbortSignal.timeout(timeoutMs);

  const { outcome_class, divergence_severity, actual_targets, details } = args;
  const actualOutcome = {
    ...(outcome_class ? { outcome_class } : {}),
    ...(divergence_severity ? { divergence_severity } : {}),
    ...(actual_targets ? { actual_targets } : {}),
    ...(details ? { details } : {}),
    reported_via: opts.reportedVia ?? "lib_observe",
    reported_at: new Date().toISOString(),
  };

  let res: FetchLikeResponse;
  try {
    res = await fetchImpl(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ actual_outcome: actualOutcome, customer_notes: details ?? null }),
      signal,
    });
  } catch (err: any) {
    const wrapped: HttpError = new Error(
      `BLACK_WALL observe request failed (network): ${err?.message ?? err}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (data as any)?.message || (data as any)?.error || `HTTP ${res.status}`;
    const err: HttpError = new Error(`BLACK_WALL observe error (${res.status}): ${msg}`);
    err.status = res.status;
    err.body = data;
    err.forecastId = forecastId;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// API key from a FILE (for env-scrubbed sandboxes like NemoClaw)
//
// NemoClaw scrubs the Gateway-spawned agent's environment, so BLACKWALL_API_KEY
// is often empty inside the agent even when a login shell sees it. The key can
// instead be delivered as a file the agent reads.
// ---------------------------------------------------------------------------

// An API key is < 200 bytes; cap the read so a huge/binary file at a candidate
// path can't be slurped into memory (OOM) at plugin load.
const MAX_KEY_FILE_BYTES = 4096;

function readKeyFileBounded(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(MAX_KEY_FILE_BYTES + 1);
    const n = readSync(fd, buf, 0, MAX_KEY_FILE_BYTES + 1, 0);
    if (n > MAX_KEY_FILE_BYTES) return null; // oversized -> not an API key file
    return buf.toString("utf8", 0, n).trim() || null;
  } catch {
    return null; // missing / unreadable / not a regular file
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolve the API key from a file. Tries, in order: `$BLACKWALL_API_KEY_FILE`,
 * `$OPENCLAW_HOME/.openclaw/blackwall.key`, then `$HOME/.openclaw/blackwall.key`.
 * Returns the first readable, non-empty, within-cap value, else undefined. Never throws.
 */
function readApiKeyFile(): string | undefined {
  const home = process.env.OPENCLAW_HOME;
  const userHome = process.env.HOME;
  const candidates = [
    process.env.BLACKWALL_API_KEY_FILE,
    home && join(home, ".openclaw", "blackwall.key"),
    userHome && join(userHome, ".openclaw", "blackwall.key"),
  ];
  for (const path of candidates) {
    if (!path) continue;
    const value = readKeyFileBounded(path);
    if (value) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Gate logic
// ---------------------------------------------------------------------------

const DEFAULT_MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_FORECAST_TIMEOUT_MS = 15000;

export function resolveConfig(config: BlackwallConfig = {}): ResolvedConfig {
  const mode = (config.mode ?? process.env.BLACKWALL_MODE ?? "observe").toLowerCase();
  const cautionAction = (config.cautionAction ?? "approve").toLowerCase();
  return {
    apiKey: config.apiKey ?? process.env.BLACKWALL_API_KEY ?? readApiKeyFile(),
    baseUrl: config.baseUrl ?? process.env.BLACKWALL_BASE_URL,
    mode: mode === "enforce" ? "enforce" : "observe",
    // failClosed (enforce only): block when the gate is unreachable instead of
    // letting the action run unscored. Off by default; recommended ON for
    // security-positioned deployments like NemoClaw.
    failClosed:
      typeof config.failClosed === "boolean"
        ? config.failClosed
        : ["1", "true", "yes"].includes(
            String(process.env.BLACKWALL_FAIL_CLOSED ?? "").toLowerCase(),
          ),
    cautionAction: (["block", "approve", "allow"].includes(cautionAction)
      ? cautionAction
      : "approve") as CautionAction,
    shouldGate: typeof config.shouldGate === "function" ? config.shouldGate : () => true,
    maxInputBytes:
      typeof config.maxInputBytes === "number" ? config.maxInputBytes : DEFAULT_MAX_INPUT_BYTES,
    forecastTimeoutMs:
      typeof config.forecastTimeoutMs === "number"
        ? config.forecastTimeoutMs
        : DEFAULT_FORECAST_TIMEOUT_MS,
    onEvent: typeof config.onEvent === "function" ? config.onEvent : null,
    forecast: typeof config.forecast === "function" ? config.forecast : forecast,
    observe: typeof config.observe === "function" ? config.observe : observe,
  };
}

// Cap the inputs we serialize into a forecast so a huge tool payload can't bloat
// the request. Strings over 200 chars are clipped; if clipping strings isn't enough
// (e.g. an oversized nested array/object value), a bounded summary is returned instead,
// so the result is ALWAYS within the cap regardless of payload shape.
function truncateInputs(inputs: any, maxBytes: number): any {
  let serialized: string;
  try {
    serialized = JSON.stringify(inputs);
  } catch {
    return { _truncated: true, _reason: "unserializable" };
  }
  if (serialized.length <= maxBytes) return inputs;

  if (Array.isArray(inputs)) {
    return { _truncated: true, _length: inputs.length, _byteSize: serialized.length };
  }
  if (typeof inputs !== "object" || inputs === null) {
    return { _truncated: true, _byteSize: serialized.length };
  }
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === "string" && v.length > 200) {
      trimmed[k] = `${v.slice(0, 200)}…<truncated ${v.length} chars>`;
    } else {
      trimmed[k] = v;
    }
  }
  trimmed._truncated = true;
  trimmed._original_bytes = serialized.length;

  // Clipping only top-level strings can still leave the object over the cap when a
  // non-string value (nested array/object, huge number) carries the bulk — e.g.
  // { files: hugeArray }. Re-check and fall back to a bounded key summary so the
  // size guard / data-minimization can never be bypassed by payload shape.
  let trimmedBytes: number;
  try {
    trimmedBytes = JSON.stringify(trimmed).length;
  } catch {
    trimmedBytes = Infinity;
  }
  if (trimmedBytes > maxBytes) {
    // slice(0, 50) caps the key COUNT but not key LENGTH — attacker-controlled keys can
    // themselves be megabytes each, which would blow the "bounded summary" past the cap
    // and defeat the whole guard. Clip each key name too so the summary is bounded by a
    // small constant regardless of input shape.
    const _keys = Object.keys(inputs)
      .slice(0, 50)
      .map((k) => (k.length > 64 ? `${k.slice(0, 64)}…<${k.length} chars>` : k));
    return { _truncated: true, _original_bytes: serialized.length, _keys };
  }
  return trimmed;
}

function emit(onEvent: ResolvedConfig["onEvent"], event: Record<string, unknown>): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    /* swallow telemetry errors — never break the hook */
  }
}

// Detailed block reason for a CAUTION verdict under cautionAction:'approve'. Because NemoClaw has
// no interactive approval surface (see handleBeforeToolCall), 'approve' blocks and surfaces the
// red-flag detail here so the agent/operator can see why.
function buildCautionReason(toolName: string, verdict: ForecastVerdict): string {
  const flags = Array.isArray(verdict?.red_flags) ? verdict.red_flags : [];
  const topFlags = flags
    .slice(0, 5)
    .map(
      (f) =>
        `• ${f?.severity?.toUpperCase?.() ?? "flag"}: ${f?.code ?? "unknown"}${f?.message ? ` — ${f.message}` : ""}`,
    )
    .join("\n");
  const risk = typeof verdict?.risk_score === "number" ? ` risk ${verdict.risk_score}/100` : "";
  const tail = flags.length > 5 ? `\n…and ${flags.length - 5} more` : "";
  return `BLACK_WALL flagged "${toolName}" as CAUTION${risk} and this runtime has no interactive approval surface — blocking.\n\n${topFlags || "(no specific red flags surfaced)"}${tail}\n\nSet cautionAction: 'allow' to permit CAUTION actions.`;
}

function buildBlockReason(toolName: string, verdict: ForecastVerdict): string {
  const flagCodes = Array.isArray(verdict?.red_flags)
    ? verdict.red_flags
        .map((f) => f?.code)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ")
    : "";
  const risk = typeof verdict?.risk_score === "number" ? ` (risk ${verdict.risk_score}/100)` : "";
  return `BLACK_WALL blocked tool "${toolName}"${risk}${flagCodes ? `: ${flagCodes}` : ""}`;
}

function keyFor(event: any): string | null {
  if (event?.toolCallId) return event.toolCallId;
  if (event?.runId && event?.toolName) return `run:${event.runId}:${event.toolName}`;
  return null;
}

// before_tool_call and after_tool_call share this map to correlate a verdict with
// its outcome. Bounded: block paths evict immediately, and a TTL timer auto-evicts
// any entry whose after_tool_call never arrives (denied approval, host never ran it).
const pendingForecasts = new Map<string, ForecastVerdict>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const PENDING_TTL_MS = Math.max(1000, Number(process.env.BLACKWALL_PENDING_TTL_MS) || 5 * 60000);

function rememberForecast(k: string | null, verdict: ForecastVerdict): void {
  if (!k || !verdict?.id) return;
  forgetForecast(k); // replace any stale entry/timer for this key
  const timer = setTimeout(() => {
    pendingForecasts.delete(k);
    pendingTimers.delete(k);
  }, PENDING_TTL_MS);
  // A pending eviction timer must not keep the host process alive.
  if (typeof timer?.unref === "function") timer.unref();
  pendingForecasts.set(k, verdict);
  pendingTimers.set(k, timer);
}

function forgetForecast(k: string | null): void {
  if (!k) return;
  const t = pendingTimers.get(k);
  if (t) {
    clearTimeout(t);
    pendingTimers.delete(k);
  }
  pendingForecasts.delete(k);
}

/**
 * Handle a `before_tool_call` event. Returns the shape NemoClaw's hook contract expects:
 *   { block?, blockReason?, params? } | undefined
 */
export async function handleBeforeToolCall(
  event: any,
  cfg: ResolvedConfig,
  logger: any = console,
): Promise<any> {
  const toolName: string | undefined = event?.toolName;
  if (!toolName) return undefined;
  if (!cfg.shouldGate(toolName)) {
    emit(cfg.onEvent, { type: "skipped", toolName, extra: { reason: "opt-out" } });
    return undefined;
  }

  const rawParams = event?.params ?? {};
  const inputs = truncateInputs(rawParams, cfg.maxInputBytes);
  const context: Record<string, unknown> = {
    source: "openclaw",
    ...(event?.toolKind ? { tool_kind: event.toolKind } : {}),
    ...(event?.toolInputKind ? { tool_input_kind: event.toolInputKind } : {}),
    ...(Array.isArray(event?.derivedPaths) && event.derivedPaths.length
      ? { derived_paths: event.derivedPaths.slice(0, 10) }
      : {}),
  };

  let verdict: ForecastVerdict;
  try {
    verdict = await cfg.forecast(
      { action: toolName, inputs, context },
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, timeoutMs: cfg.forecastTimeoutMs },
    );
  } catch (err: any) {
    const failedClosed = cfg.mode === "enforce" && cfg.failClosed;
    emit(cfg.onEvent, { type: "forecast_error", toolName, error: err, failedClosed });
    if (failedClosed) {
      // Fail CLOSED: an unreachable gate blocks the action rather than letting it run unscored.
      const blockReason = `BLACK_WALL gate unreachable — failing closed: ${err?.message ?? err}`;
      logger.warn?.(
        `[blackwall] forecast() failed for tool "${toolName}" — FAILING CLOSED (blocked): ${err?.message ?? err}`,
      );
      return { block: true, blockReason };
    }
    // Default: fail OPEN — a BW outage must not break a benign agent.
    logger.warn?.(
      `[blackwall] forecast() failed for tool "${toolName}" — proceeding without gate (fail-open): ${err?.message ?? err}`,
    );
    return undefined;
  }

  const k = keyFor(event);
  rememberForecast(k, verdict);

  const recommendation = verdict?.recommendation;
  const riskScore = typeof verdict?.risk_score === "number" ? verdict.risk_score : "?";
  // One concise line per gated tool call so operators can see the gate working.
  logger.info?.(
    `[blackwall] ${cfg.mode} · ${toolName} → ${recommendation ?? "?"} (risk ${riskScore}/100${verdict?.id ? `, forecast ${verdict.id}` : ""})`,
  );

  // observe mode: never abort, just score + log.
  if (cfg.mode === "observe") {
    emit(cfg.onEvent, { type: "observed", toolName, forecastId: verdict?.id, recommendation });
    return undefined;
  }

  // enforce mode: STOP -> hard block.
  if (recommendation === "STOP") {
    emit(cfg.onEvent, { type: "stop", toolName, forecastId: verdict?.id, recommendation });
    if (verdict?.id) {
      // Fire-and-forget observe(aborted); don't await — the block must hit the dispatcher promptly.
      cfg
        .observe(
          verdict.id,
          {
            outcome_class: "aborted",
            divergence_severity: "none",
            details: "blocked by enforce-mode guardrail",
          },
          { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: "openclaw_plugin" },
        )
        .catch((err: any) => {
          logger.warn?.(`[blackwall] observe(aborted) failed: ${err?.message ?? err}`);
          emit(cfg.onEvent, {
            type: "observe_error",
            toolName,
            forecastId: verdict.id,
            error: err,
          });
        });
    }
    forgetForecast(k); // blocked -> no after_tool_call will arrive; don't leak the entry
    return { block: true, blockReason: buildBlockReason(toolName, verdict) };
  }

  // enforce mode: CAUTION -> configurable.
  //
  // NemoClaw's before_tool_call result contract is { params?, block?, blockReason? } — there is
  // NO `requireApproval` / interactive approval surface in the sandbox. So `approve` degrades to a
  // BLOCK here (carrying the verdict detail in blockReason) rather than silently proceeding, which
  // is what returning an unsupported `requireApproval` would have done. Set cautionAction:'allow'
  // to let CAUTION actions through unblocked.
  if (recommendation === "CAUTION") {
    if (cfg.cautionAction === "allow") return undefined;
    emit(cfg.onEvent, {
      type: cfg.cautionAction === "approve" ? "require_approval" : "stop",
      toolName,
      forecastId: verdict?.id,
      recommendation,
    });
    forgetForecast(k);
    return {
      block: true,
      blockReason:
        cfg.cautionAction === "approve"
          ? buildCautionReason(toolName, verdict)
          : buildBlockReason(toolName, verdict),
    };
  }

  // GO -> proceed.
  if (recommendation === "GO") return undefined;

  // enforce mode, recommendation is neither GO/CAUTION/STOP: an unexpected verdict value
  // (backend typo, a new enum the gate doesn't yet model) must not silently bypass the guardrail.
  // Fail closed. observe mode already returned above, so this only blocks in enforce mode.
  emit(cfg.onEvent, {
    type: "invalid_recommendation",
    toolName,
    forecastId: verdict?.id,
    recommendation,
  });
  forgetForecast(k);
  return {
    block: true,
    blockReason: `BLACK_WALL returned an unrecognized recommendation "${recommendation}" for "${toolName}" — blocking (fail-closed).`,
  };
}

/**
 * Handle an `after_tool_call` event. Looks up the paired verdict and reports the
 * actual outcome via observe(). Observational only (returns void).
 */
async function handleAfterToolCall(
  event: any,
  cfg: ResolvedConfig,
  logger: any = console,
): Promise<void> {
  const toolName: string | undefined = event?.toolName;
  if (!toolName) return;
  const k = keyFor(event);
  if (!k) return;
  const verdict = pendingForecasts.get(k);
  if (!verdict?.id) return;
  forgetForecast(k);

  const hadError = typeof event?.error === "string" && event.error.length > 0;
  const outcomeClass = hadError ? "diverged" : "matched";
  const details = hadError ? String(event.error).slice(0, 500) : undefined;

  try {
    await cfg.observe(
      verdict.id,
      {
        outcome_class: outcomeClass,
        ...(hadError ? { divergence_severity: "medium", details } : {}),
        ...(typeof event?.durationMs === "number"
          ? { actual_targets: [`duration_ms:${event.durationMs}`] }
          : {}),
      },
      { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, reportedVia: "openclaw_plugin" },
    );
    emit(cfg.onEvent, {
      type: "observed_outcome",
      toolName,
      forecastId: verdict.id,
      extra: { outcomeClass },
    });
  } catch (err: any) {
    logger.warn?.(`[blackwall] observe(${outcomeClass}) failed: ${err?.message ?? err}`);
    emit(cfg.onEvent, { type: "observe_error", toolName, forecastId: verdict.id, error: err });
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Plugin factory. Most installs just enable the package and drive everything via
 * env (BLACKWALL_API_KEY, BLACKWALL_MODE, …); pass `config` to override in code.
 */
export function createBlackwallPlugin(config: BlackwallConfig = {}) {
  return definePluginEntry({
    id: "nemoclaw-blackwall-guard",
    name: "BLACK_WALL Preflight Guardrail",
    description:
      "Pre-action risk check for OpenClaw tool calls. Hooks before_tool_call to call " +
      "BLACK_WALL forecast(); in enforce mode, blocks STOP verdicts and (by default) blocks " +
      "CAUTION verdicts with the named red flags, since this runtime has no interactive " +
      "approval surface. Receipts are Ed25519-signed and verifiable offline.",
    register(api: any) {
      const cfg = resolveConfig(config);
      const logger = api?.logger ?? console;

      if (!cfg.apiKey) {
        logger.warn?.(
          "[blackwall] No apiKey configured. Set BLACKWALL_API_KEY (or drop a key file — see README) or pass " +
            "{ apiKey } to createBlackwallPlugin(). Plugin will load but every forecast() call will fail and the " +
            "hook will fall through (fail-open).",
        );
      }
      emit(cfg.onEvent, {
        type: "register",
        extra: { mode: cfg.mode, cautionAction: cfg.cautionAction },
      });

      api.on("before_tool_call", (event: any) => handleBeforeToolCall(event, cfg, logger), {
        priority: 80,
        timeoutMs: cfg.forecastTimeoutMs,
      });
      api.on("after_tool_call", (event: any) => handleAfterToolCall(event, cfg, logger), {
        priority: 80,
      });
    },
  });
}

// Default export: a pre-constructed plugin reading config from the environment.
export default createBlackwallPlugin();
