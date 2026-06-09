// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox-side reachability probe for the Ollama auth proxy (port 11435).
 *
 * Issue #3340: On Brev VMs (and any Linux host with UFW default-deny), the
 * Ollama auth proxy on port 11435 is unreachable from the sandbox's Docker
 * bridge network. This is a thin Ollama-specific wrapper over the generic
 * host-service reachability probe (see ./host-service-reachability); the
 * generic helper runs a short-lived container on the OpenShell Docker network
 * and TCP-connects to host.openshell.internal:<port>.
 */

import { OLLAMA_PROXY_PORT } from "../core/ports";
import {
  DEFAULT_PROBE_NETWORK,
  formatHostServiceUnreachableMessage,
  type HostServiceReachabilityOptions,
  type HostServiceReachabilityReason,
  type HostServiceReachabilityResult,
  __test as hostServiceTest,
  probeHostServiceSandboxReachability,
} from "./host-service-reachability";

export const DEFAULT_OLLAMA_PROBE_NETWORK = DEFAULT_PROBE_NETWORK;
const OLLAMA_SERVICE_LABEL = "Ollama auth proxy";

export type OllamaProxyReachabilityReason = HostServiceReachabilityReason;
export type OllamaProxyReachabilityResult = HostServiceReachabilityResult;
export type OllamaProxyReachabilityOptions = Partial<HostServiceReachabilityOptions>;

export async function probeOllamaProxySandboxReachability(
  opts: OllamaProxyReachabilityOptions = {},
): Promise<OllamaProxyReachabilityResult> {
  return probeHostServiceSandboxReachability({
    ...opts,
    port: opts.port ?? OLLAMA_PROXY_PORT,
  });
}

export function formatOllamaProxyUnreachableMessage(
  result: OllamaProxyReachabilityResult,
  port: number = OLLAMA_PROXY_PORT,
): string {
  return formatHostServiceUnreachableMessage(result, {
    serviceLabel: OLLAMA_SERVICE_LABEL,
    port,
  });
}

export const __test = hostServiceTest;
