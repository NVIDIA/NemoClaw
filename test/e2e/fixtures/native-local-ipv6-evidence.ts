// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlockList, isIP } from "node:net";
import os from "node:os";

/** Require only ULA answers so a successful request cannot hide an IPv4 fallback. */
export function nativeLocalUlaOnlyResolution(output: string): boolean {
  const addresses: unknown = JSON.parse(output);
  const ula = new BlockList();
  ula.addSubnet("fc00::", 7, "ipv6");
  return (
    Array.isArray(addresses) &&
    addresses.length > 0 &&
    addresses.every(
      (address: unknown) =>
        typeof address === "string" && isIP(address) === 6 && ula.check(address, "ipv6"),
    )
  );
}

/** Observe both address families to reject an unexercised IPv4 fallback. */
export function nativeLocalIpv6ResolutionCommand(): string[] {
  return [
    "python3",
    "-c",
    "import json,socket; print(json.dumps(sorted({r[4][0] for r in socket.getaddrinfo('host.openshell.internal',8081,type=socket.SOCK_STREAM)})))",
  ];
}

/** Require a policy response rather than treating a network timeout as a denial. */
export function nativeLocalIpv6DeniedCommand(address: string, body: string): string[] {
  if (isIP(address) !== 6) throw new Error("The denial probe requires an IPv6 literal.");
  return [
    "curl",
    "-sS",
    "--max-time",
    "15",
    "--noproxy",
    "",
    "--write-out",
    "\n%{http_code}",
    "--header",
    "Content-Type: application/json",
    "--data",
    body,
    `http://[${address}]:8081/v1/chat/completions`,
  ];
}

/** This scenario requires the WSL Docker host bridge, not the Podman runtime. */
export function isWslDockerIpv6TestHost(
  release = os.release(),
  runtime = process.env.NEMOCLAW_GATEWAY_RUNTIME,
): boolean {
  return /microsoft/i.test(release) && runtime !== "podman";
}
