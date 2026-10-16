// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import policy from "./native-endpoint-policy.generated.json" with { type: "json" };

const blocked = new BlockList();
for (const [address, prefix] of policy.ipv4)
  blocked.addSubnet(String(address), Number(prefix), "ipv4");
for (const [address, prefix] of policy.ipv6)
  blocked.addSubnet(String(address), Number(prefix), "ipv6");

export type NativeEndpointLookup = (
  host: string,
  options: { all: true },
) => Promise<LookupAddress[]>;

function bareHost(endpoint: URL) {
  return endpoint.hostname.replace(/^\[|\]$/gu, "");
}

function privateAddress(address: string) {
  const family = isIP(address);
  return family === 0 || blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

export function assertNativeInferenceEndpoint(endpoint: URL, inference: string) {
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("The inference endpoint must not contain credentials, a query, or a fragment.");
  const local = inference === "local" || inference === "qualification";
  if (local) {
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    )
      throw new Error("Local inference must use an explicit loopback endpoint.");
    return;
  }
  if (endpoint.protocol !== "https:")
    throw new Error("Remote inference requires an HTTPS endpoint.");
  const host = bareHost(endpoint).replace(/\.$/u, "").toLowerCase();
  if (
    policy.names.some((name) => host === name || host.endsWith(`.${name}`)) ||
    (isIP(host) !== 0 && privateAddress(host))
  )
    throw new Error("Remote inference cannot use a private or reserved endpoint.");
}

export async function resolveNativeInferenceAddresses(
  endpoint: URL,
  inference: string,
  lookup: NativeEndpointLookup = dnsLookup,
): Promise<LookupAddress[]> {
  assertNativeInferenceEndpoint(endpoint, inference);
  const host = bareHost(endpoint);
  // Explicit local mode is the only exception, and localhost never uses DNS.
  if (host === "localhost" && (inference === "local" || inference === "qualification"))
    return [{ address: "127.0.0.1", family: 4 }];
  const family = isIP(host);
  if (family) return [{ address: host, family }];
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error("The inference endpoint could not be resolved.");
  }
  if (
    !Array.isArray(addresses) ||
    addresses.length === 0 ||
    addresses.some(
      (entry) =>
        !entry ||
        typeof entry.address !== "string" ||
        isIP(entry.address) !== entry.family ||
        privateAddress(entry.address),
    )
  )
    throw new Error("The inference endpoint did not resolve exclusively to public addresses.");
  // Copy resolver-owned data before it is captured by the connection callback.
  return addresses.map(({ address, family }) => ({ address, family }));
}

export async function requestNativeInference(
  endpoint: URL,
  inference: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: Buffer;
    signal: AbortSignal;
  },
  lookup: NativeEndpointLookup = dnsLookup,
): Promise<IncomingMessage> {
  options.signal.throwIfAborted();
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const cancelled = () => reject(new Error("The inference request was cancelled."));
    options.signal.addEventListener("abort", cancelled, { once: true });
    resolveNativeInferenceAddresses(endpoint, inference, lookup)
      .then(resolve, reject)
      .finally(() => {
        options.signal.removeEventListener("abort", cancelled);
      });
  });
  options.signal.throwIfAborted();
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      rejectUnauthorized: true,
      // Never reuse a connection admitted under another resolution or consult
      // ambient proxy settings. TLS keeps the original URL host/SNI verification.
      agent: false,
      lookup: (_host, lookupOptions, callback) => {
        queueMicrotask(() => {
          if (lookupOptions.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy();
        reject(new Error("Inference endpoint redirects are not allowed."));
      } else resolve(response);
    });
    request.end(options.body);
  });
}
