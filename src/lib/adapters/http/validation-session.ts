// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isPrivateHostname, isPrivateIp } from "../../private-networks";
import { addTraceEvent, withTraceSpan } from "../../trace";
import type { CurlProbeResult } from "./probe";
import { summarizeProbeFailure } from "./probe";

export interface ValidationSessionRequest {
  url: string;
  headers?: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface ValidationSession {
  request(input: ValidationSessionRequest): Promise<CurlProbeResult>;
  close(): void;
}

export type ValidationDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface ValidationSessionOptions {
  env?: NodeJS.ProcessEnv;
  lookup?: ValidationDnsLookup;
  /** Addresses approved by the custom-endpoint SSRF preflight. */
  pinnedAddresses?: readonly string[];
  onSocket?: (socket: net.Socket) => void;
  dnsTimeoutMs?: number;
  /** @internal Allows local HTTP servers in transport unit tests. */
  allowPrivateAddressesForTesting?: boolean;
}

const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const CURL_TLS_ENV_NAMES = ["CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_DNS_LOOKUP_TIMEOUT_MS = 5_000;

function configured(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()));
}

function isNoProxyEndpoint(endpoint: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  const hostname = endpoint.hostname.toLowerCase();
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const lastColon = entry.lastIndexOf(":");
      const includesPort = lastColon > 0 && /^\d+$/.test(entry.slice(lastColon + 1));
      const candidateHost = includesPort ? entry.slice(0, lastColon) : entry;
      const candidatePort = includesPort ? entry.slice(lastColon + 1) : null;
      if (candidatePort !== null && candidatePort !== port) return false;
      if (candidateHost.startsWith(".")) {
        return hostname === candidateHost.slice(1) || hostname.endsWith(candidateHost);
      }
      return hostname === candidateHost;
    });
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function getValidationSessionIneligibility(
  endpointUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return "invalid_url";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "unsupported_protocol";
  if (parsed.username || parsed.password) return "embedded_credentials";
  if (parsed.search || parsed.hash) return "endpoint_query_or_fragment";
  const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
  const literalHostname =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (net.isIP(literalHostname)) return "ip_literal";
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "local_endpoint";
  }
  if (hostname === "host.openshell.internal") return "sandbox_internal_endpoint";
  if (hostname === "host.docker.internal") return "docker_internal_endpoint";
  if (isPrivateHostname(parsed.hostname)) return "private_endpoint";
  // Node's built-in agents do not implement forward-proxy tunnelling. Keep curl
  // authoritative whenever proxy routing may be part of endpoint reachability.
  if (configured(env, PROXY_ENV_NAMES) && !isNoProxyEndpoint(parsed, env)) {
    return "proxy_configured";
  }
  // NODE_EXTRA_CA_CERTS is consumed by Node itself at process startup. Curl-only
  // CA overrides are not, so those requests remain on the compatibility path.
  if (configured(env, CURL_TLS_ENV_NAMES)) return "curl_tls_configured";
  return null;
}

function curlStatusForError(error: NodeJS.ErrnoException): number {
  if (error.name === "AbortError" || error.code === "ETIMEDOUT") return 28;
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") return 6;
  if (
    error.code === "ECONNREFUSED" ||
    error.code === "ECONNRESET" ||
    error.code === "EHOSTUNREACH" ||
    error.code === "ENETUNREACH"
  ) {
    return 7;
  }
  if (error.code?.startsWith("CERT_") || error.code?.startsWith("ERR_TLS_")) return 60;
  return 1;
}

export function buildLookup(
  addresses: Array<{ address: string; family: number }>,
): net.LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === "object" ? options.family : undefined;
    const eligible = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (requestedFamily && eligible.length === 0) {
      callback(
        Object.assign(new Error(`no resolved IPv${requestedFamily} address is available`), {
          code: "ENOTFOUND",
        }),
        [],
      );
      return;
    }
    const selected = eligible;
    if (options?.all) {
      callback(null, selected);
      return;
    }
    const first = selected[0];
    callback(null, first.address, first.family);
  };
}

export async function createValidationSession(
  endpointUrl: string,
  options: ValidationSessionOptions = {},
): Promise<ValidationSession | null> {
  const env = options.env ?? process.env;
  const ineligible = getValidationSessionIneligibility(endpointUrl, env);
  if (ineligible) {
    addTraceEvent("validation_transport_fallback", { reason: ineligible });
    return null;
  }

  const endpoint = new URL(endpointUrl);
  const lookup = options.lookup ?? (dns.lookup as ValidationDnsLookup);
  let addresses: Array<{ address: string; family: number }>;
  if (options.pinnedAddresses && options.pinnedAddresses.length > 0) {
    addresses = options.pinnedAddresses.map((address) => ({ address, family: net.isIP(address) }));
    if (addresses.some(({ family }) => family === 0)) {
      addTraceEvent("validation_transport_fallback", { reason: "invalid_pinned_address" });
      return null;
    }
  } else {
    try {
      addresses = await withTraceSpan(
        "nemoclaw.inference.validation_dns_lookup",
        { "server.address": endpoint.hostname },
        () =>
          withTimeout(
            lookup(endpoint.hostname, { all: true, verbatim: true }),
            options.dnsTimeoutMs ?? DEFAULT_DNS_LOOKUP_TIMEOUT_MS,
            "validation DNS lookup timed out",
          ),
      );
    } catch (error) {
      addTraceEvent("validation_transport_fallback", {
        reason: "dns_lookup_failed",
        error_code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      return null;
    }
  }
  if (addresses.length === 0) {
    addTraceEvent("validation_transport_fallback", { reason: "dns_lookup_empty" });
    return null;
  }
  if (
    !options.allowPrivateAddressesForTesting &&
    addresses.some(({ address }) => isPrivateIp(address))
  ) {
    addTraceEvent("validation_transport_fallback", { reason: "private_dns_address" });
    return null;
  }

  const sharedOptions = {
    keepAlive: true,
    maxSockets: 1,
    maxFreeSockets: 1,
    // Ask Node's net stack to consume the full lookup result and race address
    // families rather than pinning validation to the first IPv4/IPv6 answer.
    autoSelectFamily: true,
    lookup: buildLookup(addresses),
  };
  const agent =
    endpoint.protocol === "https:" ? new https.Agent(sharedOptions) : new http.Agent(sharedOptions);
  const seenSockets = new WeakSet<net.Socket>();
  const endpointOrigin = endpoint.origin;
  let closed = false;

  addTraceEvent("validation_transport_selected", {
    transport: "node_keepalive",
    address_count: addresses.length,
  });

  return {
    request(input) {
      const requestUrl = new URL(input.url);
      if (requestUrl.origin !== endpointOrigin) {
        return Promise.resolve({
          ok: false,
          httpStatus: 0,
          curlStatus: 1,
          body: "",
          stderr: "validation session origin mismatch",
          message: "validation session origin mismatch",
        });
      }
      return withTraceSpan(
        "nemoclaw.inference.node_validation_request",
        { "http.url": requestUrl.origin, transport: "node_keepalive" },
        () =>
          new Promise<CurlProbeResult>((resolve) => {
            const target = new URL(input.url);
            let settled = false;
            let responseStarted = false;
            let status = 0;
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            let overallTimer: NodeJS.Timeout | undefined;
            let terminalError: NodeJS.ErrnoException | undefined;
            const finish = (result: CurlProbeResult) => {
              if (settled) return;
              settled = true;
              if (overallTimer) clearTimeout(overallTimer);
              resolve(result);
            };
            const requestImpl = target.protocol === "https:" ? https.request : http.request;
            const request = requestImpl(
              target,
              {
                agent,
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(input.body).toString(),
                  ...input.headers,
                },
              },
              (response) => {
                responseStarted = true;
                status = response.statusCode ?? 0;
                const failResponse = (rawError: NodeJS.ErrnoException) => {
                  request.destroy();
                  const body = Buffer.concat(chunks).toString("utf8");
                  const curlStatus = curlStatusForError(rawError);
                  finish({
                    ok: false,
                    httpStatus: status,
                    curlStatus,
                    body,
                    stderr: rawError.message,
                    message: summarizeProbeFailure(body, status, curlStatus, rawError.message),
                  });
                };
                response.on("data", (chunk: Buffer | string) => {
                  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  receivedBytes += buffer.length;
                  if (receivedBytes > MAX_RESPONSE_BYTES) {
                    terminalError = Object.assign(new Error("validation response exceeded 8 MiB"), {
                      code: "EFBIG",
                    });
                    request.destroy(terminalError);
                    return;
                  }
                  chunks.push(buffer);
                });
                response.on("end", () => {
                  const body = Buffer.concat(chunks).toString("utf8");
                  const ok = status >= 200 && status < 300;
                  finish({
                    ok,
                    httpStatus: status,
                    curlStatus: 0,
                    body,
                    stderr: "",
                    message: ok ? `HTTP ${status}` : summarizeProbeFailure(body, status, 0, ""),
                  });
                });
                response.on("close", () => {
                  if (response.complete || settled) return;
                  failResponse(
                    terminalError ??
                      Object.assign(new Error("validation response closed early"), {
                        code: "ECONNRESET",
                      }),
                  );
                });
                response.on("error", failResponse);
              },
            );
            request.on("socket", (socket) => {
              if (!seenSockets.has(socket)) {
                seenSockets.add(socket);
                options.onSocket?.(socket);
                addTraceEvent("validation_socket_opened", { reused: false });
              } else {
                addTraceEvent("validation_socket_reused", { reused: true });
              }
            });
            overallTimer = setTimeout(() => {
              terminalError = Object.assign(new Error("validation request timed out"), {
                code: "ETIMEDOUT",
              });
              request.destroy(terminalError);
            }, input.timeoutMs);
            request.on("error", (rawError: NodeJS.ErrnoException) => {
              const body = Buffer.concat(chunks).toString("utf8");
              const curlStatus = curlStatusForError(rawError);
              finish({
                ok: false,
                httpStatus: status,
                curlStatus,
                body,
                stderr: rawError.message,
                message: summarizeProbeFailure(
                  body,
                  responseStarted ? status : 0,
                  curlStatus,
                  rawError.message,
                ),
              });
            });
            request.end(input.body);
          }),
      );
    },
    close() {
      if (closed) return;
      closed = true;
      agent.destroy();
      addTraceEvent("validation_transport_closed", { transport: "node_keepalive" });
    },
  };
}
