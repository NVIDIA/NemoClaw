// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { classifyManagedGatewayEndpointBinding } from "../../../../nemoclaw/dist/shared/openshell-gateway-endpoint-boundary.cjs";
import { isValidName } from "../../../../nemoclaw/dist/shared/sandbox-name.cjs";
import {
  getGatewayReuseState,
  hasStaleGateway,
  isGatewayHealthy,
  shouldSelectNamedGatewayForReuse,
} from "../../state/gateway";
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

export function createCliOpenShellGatewayReuseObserver(
  capture: CaptureOpenShellCommand,
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
        if (!request.runtimeSelection) assertNoOpenShellGatewayEndpointOverride();
        const opts = withSelectedOpenShellCommandOptions(
          {
            ignoreError: true,
            includeStderr: true,
            includeStreams: true,
            timeout: request.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS,
          } as const,
          request.runtimeSelection,
        );
        const status = await capture(["status", "-g", name], opts);
        const named = await capture(["gateway", "info", "-g", name], opts);
        const active = await capture(["gateway", "info"], opts);
        const outputs = [status.output, named.output, active.output];
        for (const result of [status, named, active]) {
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
        }
        const namedMetadata = hasStaleGateway(named.output, name);
        const healthy = isGatewayHealthy(status.output, named.output, active.output, name);
        const reuse = getGatewayReuseState(status.output, named.output, active.output, name, name);
        // A selected name cannot authorize recovery without its named metadata.
        if (reuse === "stale" && !namedMetadata)
          return failed({
            kind: "schema",
            message: "Gateway metadata is unavailable; recovery authority cannot be verified.",
          });
        const endpoints: (string | null)[] = [];
        for (const output of outputs) {
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
            status.output,
            named.output,
            active.output,
            name,
          ),
          endpoints,
          endpointBinding:
            request.expectedGatewayPort === undefined
              ? "unknown"
              : classifyManagedGatewayEndpointBinding(outputs, request.expectedGatewayPort),
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
