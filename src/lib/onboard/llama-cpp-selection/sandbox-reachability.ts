// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox-side reachability for an attached llama.cpp server on port 8081.
 *
 * Host fingerprint only proves 127.0.0.1:8081. The registered sandbox route
 * is host.openshell.internal:8081 (the OpenShell Docker bridge). A
 * loopback-only Docker publish or 127.0.0.1-only host bind can leave that hop unreachable
 * (#11626). Reuse the generic host-service probe (#3340 / #4564).
 */

import { LLAMA_CPP_PORT } from "../../inference/llama-cpp";
import { cliName } from "../branding";
import {
  formatHostServiceUnreachableMessage,
  probeHostServiceSandboxReachability,
  type HostServiceReachabilityOptions,
  type HostServiceReachabilityResult,
} from "../host-service-reachability";

const SERVICE_LABEL = "llama.cpp server";
const HOST_INTERNAL_NAME = "host.openshell.internal";

export type LlamaCppSandboxReachabilityResult = HostServiceReachabilityResult;
export type LlamaCppSandboxReachabilityOptions = Partial<HostServiceReachabilityOptions>;

export async function probeLlamaCppSandboxReachability(
  opts: LlamaCppSandboxReachabilityOptions = {},
): Promise<LlamaCppSandboxReachabilityResult> {
  return probeHostServiceSandboxReachability({
    ...opts,
    port: opts.port ?? LLAMA_CPP_PORT,
    treatNonBridgeTcpFailureAsConclusive: true,
  });
}

export function formatLlamaCppSandboxUnreachableMessage(
  result: LlamaCppSandboxReachabilityResult,
  port: number = LLAMA_CPP_PORT,
): string {
  const sandboxHost = result.sandboxHostAddress;
  if (typeof sandboxHost === "string" && sandboxHost.length > 0) {
    return [
      `  ✗ Sandbox containers cannot reach the ${SERVICE_LABEL} at ${HOST_INTERNAL_NAME}:${port}.`,
      `    Host-side 127.0.0.1:${port} passed. The sandbox route uses ${sandboxHost}.`,
      `    Keep 127.0.0.1:${port} reachable. Restrict non-loopback ingress to the sandbox network.`,
      `    Also bind, publish, or forward the service so ${sandboxHost}:${port} is reachable from the sandbox. A firewall rule alone cannot make a loopback-only listener reachable.`,
      `    Then rerun \`${cliName()} onboard\`.`,
    ].join("\n");
  }
  if (result.usesHostGatewayRoute === true) {
    return [
      `  ✗ Sandbox containers cannot reach the ${SERVICE_LABEL} at ${HOST_INTERNAL_NAME}:${port}.`,
      `    Host-side 127.0.0.1:${port} passed. The sandbox route uses the runtime host-gateway mapping.`,
      `    Keep 127.0.0.1:${port} reachable. Restrict non-loopback ingress to the sandbox network.`,
      "    Also bind, publish, or forward the service through that mapping. A firewall rule alone cannot make a loopback-only listener reachable.",
      `    Then rerun \`${cliName()} onboard\`.`,
    ].join("\n");
  }
  const gatewayBind =
    result.gatewayIp === undefined
      ? `-p 127.0.0.1:${port}:${port} -p <docker-gateway-ip>:${port}:${port}`
      : `-p 127.0.0.1:${port}:${port} -p ${result.gatewayIp}:${port}:${port}`;
  return formatHostServiceUnreachableMessage(result, {
    serviceLabel: SERVICE_LABEL,
    port,
    extraLines: [
      `    Host-side 127.0.0.1:${port} passed. The sandbox route uses the OpenShell Docker bridge IP.`,
      `    A loopback-only Docker publish (-p 127.0.0.1:${port}:${port}) or a 127.0.0.1-only host bind can make this sandbox route unreachable.`,
      "    If the server runs in Docker, publish the port on the Docker gateway IP as well, for example:",
      `      docker run ... ${gatewayBind} ...`,
      `    If you run llama-server on the host, keep 127.0.0.1:${port} reachable.`,
      `    Restrict non-loopback ingress to the sandbox subnet before you add a listener or forwarder on ${result.gatewayIp ?? "the Docker gateway IP"}:${port}.`,
      "    A firewall rule alone cannot make a loopback-only listener reachable.",
    ],
  });
}
