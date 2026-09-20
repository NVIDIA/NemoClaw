// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { classifyManagedGatewayEndpointBinding } from "../../../../nemoclaw/dist/shared/openshell-gateway-endpoint-boundary.cjs";
import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import {
  getGatewayReuseState,
  hasStaleGateway,
  isGatewayHealthy,
  shouldSelectNamedGatewayForReuse,
} from "../../domain/gateway-reuse";
import { withSelectedOpenShellCommandOptions } from "./command-argv";
import { assertNoOpenShellGatewayEndpointOverride } from "./gateway-scope";
import type {
  OpenShellGatewayReuseObservation,
  OpenShellGatewayReuseObserver,
} from "./gateway-reuse";
import {
  classifyCliOpenShellCommandError,
  stripOpenShellCliAnsi,
  type CaptureOpenShellCommand,
} from "./sandbox-observer-cli";
import type { OpenShellSandboxError } from "./sandbox-observer";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

function failed(error: OpenShellSandboxError): OpenShellGatewayReuseObservation {
  return {
    gatewayReuseState: "missing",
    healthy: false,
    namedMetadata: false,
    shouldSelect: false,
    endpoints: [],
    endpointBinding: "unknown",
    error,
  };
}

type GatewayRegistryEntry = Readonly<{
  name: string;
  endpoint: string;
  active: boolean;
}>;

function parseGatewayRegistry(output: string): GatewayRegistryEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;

  const entries: GatewayRegistryEntry[] = [];
  const names = new Set<string>();
  let activeCount = 0;
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !isValidName(entry.name) ||
      typeof entry.endpoint !== "string" ||
      typeof entry.active !== "boolean" ||
      names.has(entry.name)
    ) {
      return null;
    }
    names.add(entry.name);
    if (entry.active) activeCount += 1;
    entries.push({ name: entry.name, endpoint: entry.endpoint, active: entry.active });
  }
  return activeCount <= 1 ? entries : null;
}

function gatewayMetadataOutput(entry: GatewayRegistryEntry | undefined): string {
  return entry ? `Gateway: ${entry.name}\nGateway endpoint: ${entry.endpoint}` : "";
}

export function createCliOpenShellGatewayReuseObserver(
  capture: CaptureOpenShellCommand,
  environment?: NodeJS.ProcessEnv,
): OpenShellGatewayReuseObserver {
  return {
    async observeGatewayReuse(request) {
      const name = request.target.gatewayName;
      if (
        (request.timeoutMs !== undefined &&
          (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0)) ||
        !isValidName(name) ||
        (request.runtimeSelection && request.runtimeSelection.gatewayName !== name)
      ) {
        return failed({
          kind: "command",
          reason: "invalid_request",
          message: "Invalid OpenShell gateway reuse target.",
        });
      }
      try {
        if (!request.runtimeSelection) assertNoOpenShellGatewayEndpointOverride(environment);
        const opts = withSelectedOpenShellCommandOptions(
          {
            ...(environment
              ? {
                  env: Object.fromEntries(
                    Object.entries(environment).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                  replaceEnv: true as const,
                }
              : {}),
            ignoreError: true,
            includeStderr: true,
            includeStreams: true,
            timeout: request.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
          } as const,
          request.runtimeSelection,
        );
        const outputs: string[] = [];
        for (const args of [
          ["status", "-g", name],
          ["gateway", "list", "-o", "json"],
        ]) {
          const result = await capture(args, opts);
          const error = classifyCliOpenShellCommandError(
            /^\s*Error:/im.test(result.output) && result.status === 0
              ? { ...result, status: 1 }
              : result,
          );
          if (
            error &&
            !(error.kind === "transport" && error.reason === "unreachable") &&
            !(
              error.kind === "command" &&
              /\bNo (?:active )?gateway\b|No gateway metadata found/i.test(result.output)
            )
          )
            return failed(error);
          outputs.push(args[0] === "gateway" ? (result.stdout ?? result.output) : result.output);
        }
        const [statusOutput = "", registryOutput = ""] = outputs;
        const registry = parseGatewayRegistry(registryOutput);
        if (!registry)
          return failed({
            kind: "schema",
            message: "OpenShell returned an unrecognized gateway registry.",
          });
        const namedOutput = gatewayMetadataOutput(registry.find((entry) => entry.name === name));
        const activeOutput = gatewayMetadataOutput(registry.find((entry) => entry.active));
        const observationOutputs = [statusOutput, namedOutput, activeOutput];
        const namedMetadata = hasStaleGateway(namedOutput, name);
        const healthy = isGatewayHealthy(statusOutput, namedOutput, activeOutput, name);
        const reuse = getGatewayReuseState(statusOutput, namedOutput, activeOutput, name, name);
        // A selected name cannot authorize recovery without its named metadata.
        if (reuse === "stale" && !namedMetadata)
          return failed({
            kind: "schema",
            message: "Gateway metadata is unavailable; recovery authority cannot be verified.",
          });
        const endpoints: (string | null)[] = [];
        for (const output of observationOutputs) {
          for (const match of stripOpenShellCliAnsi(output).matchAll(
            /^\s*(?:Gateway endpoint|Server):\s*(.*)$/gim,
          )) {
            try {
              const endpoint = new URL(match[1].trim());
              endpoints.push(
                ["https:", "http:"].includes(endpoint.protocol) &&
                  !endpoint.username &&
                  !endpoint.password &&
                  endpoint.pathname === "/" &&
                  !endpoint.search &&
                  !endpoint.hash
                  ? endpoint.origin
                  : null,
              );
            } catch {
              endpoints.push(null);
            }
          }
        }
        return {
          gatewayReuseState: reuse,
          healthy,
          namedMetadata,
          shouldSelect: shouldSelectNamedGatewayForReuse(
            statusOutput,
            namedOutput,
            activeOutput,
            name,
          ),
          endpoints,
          endpointBinding:
            request.expectedGatewayPort === undefined
              ? "unknown"
              : classifyManagedGatewayEndpointBinding(
                  observationOutputs,
                  request.expectedGatewayPort,
                ),
        };
      } catch {
        return failed({
          kind: "command",
          reason: "failed",
          message: "OpenShell gateway reuse observation failed.",
        });
      }
    },
  };
}
