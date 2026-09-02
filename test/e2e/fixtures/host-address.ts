// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { prepareConfiguredGatewayHostRuntime } from "../../../src/lib/onboard/docker-driver-gateway-env.ts";
import { isPortableExperimentalProfile } from "../../../src/lib/onboard/docker-driver-platform.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import { assertExitZero } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

export type HostAddressSource =
  | "runtime-provider"
  | "route"
  | "hostname"
  | "darwin-interface"
  | "darwin-ifconfig"
  | "loopback";
export interface HostAddressResult {
  address: string;
  source: HostAddressSource;
  probe: ShellProbeResult | null;
}

export function configuredRuntimeProviderHostAddress(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!environment.NEMOCLAW_GATEWAY_RUNTIME || isPortableExperimentalProfile(environment)) {
    return null;
  }
  return prepareConfiguredGatewayHostRuntime({ environment, platform }).sandboxHostAddress;
}

export function parseHostAddressProbe(
  output: string,
): Pick<HostAddressResult, "address" | "source"> {
  const trimmed = output.trim();
  const match = trimmed.match(/^(route|hostname|darwin-interface|darwin-ifconfig)\s+(\S+)$/);
  if (match) {
    const address = match[2];
    if (isIP(address) !== 4) {
      throw new Error(
        `host address discovery returned invalid IPv4 address from ${match[1]}: ${address}`,
      );
    }

    return { source: match[1] as HostAddressSource, address };
  }

  if (trimmed === "loopback 127.0.0.1") {
    return { source: "loopback", address: "127.0.0.1" };
  }

  throw new Error(`host address discovery returned unrecognized probe output: ${trimmed}`);
}

export async function discoverHostAddress(
  host: HostCliClient,
  artifactName = "host-address-for-sandbox",
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<HostAddressResult> {
  const runtimeProviderAddress = configuredRuntimeProviderHostAddress(environment, platform);
  if (runtimeProviderAddress !== null) {
    if (isIP(runtimeProviderAddress) !== 4) {
      throw new Error(`runtime provider returned invalid sandbox host address: ${runtimeProviderAddress}`);
    }
    return { source: "runtime-provider", address: runtimeProviderAddress, probe: null };
  }
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
  assertExitZero(probe, "host address discovery");
  return { ...parseHostAddressProbe(probe.stdout), probe };
}
