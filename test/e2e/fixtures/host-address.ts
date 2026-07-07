// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

export type HostAddressSource =
  | "route"
  | "hostname"
  | "darwin-interface"
  | "darwin-ifconfig"
  | "loopback";
export interface HostAddressResult {
  address: string;
  source: HostAddressSource;
  probe: ShellProbeResult;
}

export function parseHostAddressProbe(
  output: string,
): Pick<HostAddressResult, "address" | "source"> {
  const match = output.trim().match(/^(route|hostname|darwin-interface|darwin-ifconfig)\s+(\S+)/);
  return match
    ? { source: match[1] as HostAddressSource, address: match[2] }
    : { source: "loopback", address: "127.0.0.1" };
}

export async function discoverHostAddress(
  host: HostCliClient,
  artifactName = "host-address-for-sandbox",
): Promise<HostAddressResult> {
  const probe = await host.command(
    "bash",
    [
      "-lc",
      [
        'ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk \'{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}\')"',
        'if [ -n "$ip_addr" ]; then echo "route $ip_addr"; exit 0; fi',
        "ip_addr=\"$(hostname -I 2>/dev/null | awk '{print $1}')\"",
        'if [ -n "$ip_addr" ]; then echo "hostname $ip_addr"; exit 0; fi',
        'if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then',
        ' for iface in en0 en1 bridge100; do ip_addr="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"; if [ -n "$ip_addr" ]; then echo "darwin-interface $ip_addr"; exit 0; fi; done',
        " ip_addr=\"$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\\./ {print $2; exit}')\"",
        ' if [ -n "$ip_addr" ]; then echo "darwin-ifconfig $ip_addr"; exit 0; fi',
        "fi",
        "echo loopback 127.0.0.1",
      ].join("\n"),
    ],
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 30_000 },
  );
  return { ...parseHostAddressProbe(probe.stdout), probe };
}
