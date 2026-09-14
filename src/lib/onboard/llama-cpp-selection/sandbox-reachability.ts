// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox-side reachability for an attached llama.cpp server on port 8081.
 *
 * Host fingerprint only proves 127.0.0.1:8081. The registered sandbox route
 * is host.openshell.internal:8081 (the OpenShell Docker bridge). A
 * loopback-only Docker publish or 127.0.0.1-only host bind blackholes that hop
 * (#11626). Reuse the generic host-service probe (#3340 / #4564).
 */

import { LLAMA_CPP_PORT } from "../../inference/llama-cpp";
import { cliName } from "../branding";
import {
  probeHostServiceSandboxReachability,
  type HostServiceReachabilityOptions,
  type HostServiceReachabilityResult,
} from "../host-service-reachability";

const HOST_INTERNAL_NAME = "host.openshell.internal";
const SERVICE_LABEL = "llama.cpp server";

export type LlamaCppSandboxReachabilityResult = HostServiceReachabilityResult;
export type LlamaCppSandboxReachabilityOptions = Partial<HostServiceReachabilityOptions>;

export async function probeLlamaCppSandboxReachability(
  opts: LlamaCppSandboxReachabilityOptions = {},
): Promise<LlamaCppSandboxReachabilityResult> {
  return probeHostServiceSandboxReachability({
    ...opts,
    port: opts.port ?? LLAMA_CPP_PORT,
  });
}

export function formatLlamaCppSandboxUnreachableMessage(
  result: LlamaCppSandboxReachabilityResult,
  port: number = LLAMA_CPP_PORT,
): string {
  const gatewayBind =
    result.gatewayIp === undefined
      ? `-p 127.0.0.1:${port}:${port} -p <docker-gateway-ip>:${port}:${port}`
      : `-p 127.0.0.1:${port}:${port} -p ${result.gatewayIp}:${port}:${port}`;
  const ufw =
    result.subnet && result.gatewayIp
      ? `      sudo ufw allow from ${result.subnet} to ${result.gatewayIp} port ${port} proto tcp`
      : result.subnet
        ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
        : [
            `      SUBNET=$(docker network inspect ${result.networkName} --format '{{(index .IPAM.Config 0).Subnet}}')`,
            `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
          ].join("\n");
  return [
    `  ✗ Sandbox containers cannot reach the ${SERVICE_LABEL} at ${HOST_INTERNAL_NAME}:${port}.`,
    `    Host-side 127.0.0.1:${port} passed. The sandbox route uses the OpenShell Docker bridge IP.`,
    `    A loopback-only Docker publish (-p 127.0.0.1:${port}:${port}) or a 127.0.0.1-only host bind blackholes SYN packets to that hop.`,
    "    Publish the port on the Docker gateway IP as well, for example:",
    `      docker run ... ${gatewayBind} ...`,
    "    Binding 0.0.0.0 also works and exposes the port more widely.",
    "    If a host firewall blocks the OpenShell Docker bridge:",
    ufw,
    `    Then rerun \`${cliName()} onboard\`.`,
  ].join("\n");
}
