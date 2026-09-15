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
import {
  formatHostServiceUnreachableMessage,
  probeHostServiceSandboxReachability,
  type HostServiceReachabilityOptions,
  type HostServiceReachabilityResult,
} from "../host-service-reachability";

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
  return formatHostServiceUnreachableMessage(result, {
    serviceLabel: SERVICE_LABEL,
    port,
    extraLines: [
      `    Host-side 127.0.0.1:${port} passed. The sandbox route uses the OpenShell Docker bridge IP.`,
      `    A loopback-only Docker publish (-p 127.0.0.1:${port}:${port}) or a 127.0.0.1-only host bind can make this sandbox route unreachable.`,
      "    Publish the port on the Docker gateway IP as well, for example:",
      `      docker run ... ${gatewayBind} ...`,
    ],
  });
}
