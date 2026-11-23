// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { isIP } from "node:net";

export const SPARK_INTERFACE_QUERY =
  "JSON.stringify(Object.fromEntries(Object.entries(require('node:os').networkInterfaces()).map(([name, rows]) => [name, rows.map(({address, family, internal, scopeid}) => ({address, family, internal, scopeid}))])))";

export function vllmPublicationProbeUrls(bridge: string, interfaces: unknown) {
  assert(
    interfaces && typeof interfaces === "object" && !Array.isArray(interfaces),
    "invalid interface inventory",
  );
  const allowed = ["127.0.0.1", bridge];
  const denied = new Set<string>();
  let externalIpv4 = false;
  let ipv6 = false;
  const url = (host: string) => `http://${host}:8000/health`;
  for (const [name, entries] of Object.entries(interfaces)) {
    assert(Array.isArray(entries), "invalid interface addresses");
    for (const { address, family, internal, scopeid } of entries) {
      assert(
        typeof address === "string" && !address.includes("%") && typeof internal === "boolean",
        "invalid interface address",
      );
      if (family === "IPv6") {
        assert(
          isIP(address) === 6 && Number.isSafeInteger(scopeid) && scopeid >= 0,
          "invalid IPv6 interface",
        );
        ipv6 = true;
        denied.add(url(`[${address}${scopeid ? `%25${encodeURIComponent(name)}` : ""}]`));
      } else {
        assert(family === "IPv4" && isIP(address) === 4, "invalid IPv4 interface");
        if (allowed.includes(address)) continue;
        externalIpv4 ||= !internal && !address.startsWith("127.");
        denied.add(url(address));
      }
    }
  }
  assert(externalIpv4, "vLLM publication proof requires an unintended non-loopback IPv4 address.");
  return {
    allowed: allowed.map(url),
    denied: [...denied],
    ipv6: ipv6 ? "configured" : "unconfigured",
  };
}

export function vllmPublicationCurlArgs(urls: readonly string[]): string[] {
  return [
    "-q",
    "--noproxy",
    "*",
    "--globoff",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "3",
    "--max-time",
    "5",
    "--write-out",
    "%{exitcode} %{http_code}\n",
    ...urls.flatMap((url) => ["--output", "/dev/null", url]),
  ];
}

export const SPARK_EGRESS_PROBE =
  "status=0; code=$(curl -sS -o /dev/null -w '%{http_connect}' --max-time 20 https://example.com/) || status=$?; printf '%s %s' \"$status\" \"$code\"";
