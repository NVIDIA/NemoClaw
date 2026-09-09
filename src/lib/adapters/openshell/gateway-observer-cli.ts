// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withSelectedOpenShellCommandOptions } from "./command-argv";
import { assertNoOpenShellGatewayEndpointOverride } from "./gateway-scope";
import type { OpenShellGatewayObservation, OpenShellGatewayObserver } from "./gateway-observer";
import { isValidName } from "../../sandbox-name-contract";
import { stripAnsi as stripOpenShellCliAnsi } from "./client";
import {
  classifyCliOpenShellCommandError,
  type CaptureOpenShellCommand,
  type CapturedOpenShellCommandResult,
} from "./sandbox-observer-cli";
import type { OpenShellSandboxError } from "./sandbox-observer";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const messages = {
  authentication: "OpenShell could not authenticate the gateway observation.",
  command: "The OpenShell gateway observation failed.",
  schema: "The OpenShell CLI and gateway schemas do not match.",
  timeout: "OpenShell gateway observation timed out.",
};

function gatewayError(result: CapturedOpenShellCommandResult): OpenShellSandboxError | null {
  // OpenShell status can print an Error line while exiting successfully.
  const printedError = /^\s*Error:/im.test(stripOpenShellCliAnsi(result.output));
  return classifyCliOpenShellCommandError(
    printedError && result.status === 0 ? { ...result, status: 1 } : result,
    messages,
  );
}

function gatewayName(output: string): string | null {
  const names = [...output.matchAll(/^\s*Gateway:\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
  return names.length === 1 && isValidName(names[0]) ? names[0] : null;
}

function failed(
  error: OpenShellSandboxError,
  activeGateway: string | null = null,
): OpenShellGatewayObservation {
  return {
    state: "observation_failed",
    activeGateway,
    recoveryBlocked: true,
    unavailable: error.kind === "timeout" || error.kind === "transport",
    diagnostic: error.message,
    error,
  };
}

export function createCliOpenShellGatewayObserver(
  capture: CaptureOpenShellCommand,
): OpenShellGatewayObserver {
  return {
    async observeGateway(request) {
      const name = request.target.gatewayName;
      if (
        !isValidName(name) ||
        (request.runtimeSelection && request.runtimeSelection.gatewayName !== name) ||
        (request.timeoutMs !== undefined &&
          (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
      ) {
        return failed({
          kind: "command",
          reason: "invalid_request",
          message: "Invalid OpenShell gateway observation target or timeout.",
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
            maxBuffer: 1024 * 1024,
          } as const,
          request.runtimeSelection,
        );
        // Status observes selection intentionally; named metadata never follows ambient selection.
        const status = await capture(["status"], opts);
        const info = await capture(["gateway", "info", "-g", name], opts);
        const statusText = stripOpenShellCliAnsi(status.output);
        const infoText = stripOpenShellCliAnsi(info.output);
        const activeGateway = gatewayName(statusText);
        const named = gatewayName(infoText) === name;
        const connected = /^\s*Status:\s*Connected\b/im.test(statusText);
        const unsupported = /^\s*gateway info is not supported by this gateway version\s*$/i.test(
          infoText,
        );
        const missing = /\bNo (?:active )?gateway(?: configured)?\b|No gateway metadata found/i;
        const statusError = gatewayError(status);
        const infoError = gatewayError(info);
        const absentInfo = missing.test(infoText);
        const absentStatus = missing.test(statusText);
        // Only known absence and unreachable responses describe resource state. Other failures are not absence.
        for (const [error, absent, legacy] of [
          [statusError, absentStatus, false],
          [infoError, absentInfo, unsupported && connected && activeGateway === name],
        ] as const) {
          if (
            error &&
            !(error.kind === "transport" && error.reason === "unreachable") &&
            !(error.kind === "command" && error.reason === "failed" && (absent || legacy))
          )
            return failed(error, activeGateway);
        }
        if (connected && activeGateway === name && absentInfo) {
          return failed(
            { kind: "schema", message: "OpenShell gateway selection and metadata disagree." },
            activeGateway,
          );
        }
        let state: OpenShellGatewayObservation["state"];
        if (
          !statusError &&
          connected &&
          activeGateway === name &&
          ((!infoError && named) || unsupported)
        )
          state = "healthy_named";
        else if (activeGateway === name && named && statusError?.kind === "transport")
          state = "named_unreachable";
        else if (activeGateway === name && named) state = "named_unhealthy";
        else if (!statusError && connected && activeGateway && activeGateway !== name)
          state = "connected_other";
        else if (absentStatus || absentInfo) state = "missing_named";
        else
          return failed(
            statusError ??
              infoError ?? {
                kind: "schema",
                message: "OpenShell returned an unrecognized gateway observation.",
              },
            activeGateway,
          );
        const diagnostic = {
          healthy_named: `Connected to gateway '${name}'.`,
          named_unreachable: `Gateway '${name}' is unreachable.`,
          named_unhealthy: `Gateway '${name}' is not connected.`,
          connected_other: `Connected to gateway '${activeGateway}' instead of '${name}'.`,
          missing_named: `Gateway '${name}' is not configured.`,
        }[state];
        return {
          state,
          activeGateway,
          recoveryBlocked: false,
          unavailable:
            state === "named_unreachable" ||
            state === "named_unhealthy" ||
            (state === "missing_named" && absentStatus),
          diagnostic,
        };
      } catch {
        return failed({
          kind: "command",
          reason: "failed",
          message:
            "OpenShell gateway observation could not be completed. Check gateway configuration and CLI access.",
        });
      }
    },
  };
}
