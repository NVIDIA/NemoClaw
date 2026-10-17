// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../sandbox-name-contract";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { captureSanitizedResolvedOpenshellAsync } from "./sanitized-capture";
import { classifyCliOpenShellCommandError } from "./sandbox-observer-cli";
import type { OpenShellSandboxSettings } from "./sandbox-settings";

export function createCliOpenShellSandboxSettings(
  capture: typeof captureSanitizedResolvedOpenshellAsync = captureSanitizedResolvedOpenshellAsync,
): OpenShellSandboxSettings {
  return {
    enableAuditLogs: async ({ target, sandboxName, timeoutMs }) => {
      if (
        !isValidName(sandboxName) ||
        (target.kind === "named" && !isValidName(target.gatewayName))
      ) {
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "invalid_request",
            message: "Invalid sandbox audit target.",
          },
        };
      }
      if (target.kind === "named") assertNoOpenShellGatewayEndpointOverride();
      const optOut = process.env.NEMOCLAW_NO_AUTO_AUDIT_LOGS?.toLowerCase();
      if (optOut && optOut !== "0" && optOut !== "false") {
        return { ok: true, value: undefined };
      }
      console.error(
        `NemoClaw is attempting to enable OpenShell OCSF JSON audit logs for sandbox '${sandboxName}' (ocsf_json_enabled=true). Set NEMOCLAW_NO_AUTO_AUDIT_LOGS=1 to opt out.`,
      );
      const args = ["settings", "set"];
      if (target.kind === "named") args.push("-g", target.gatewayName);
      args.push(sandboxName, "--key", "ocsf_json_enabled", "--value", "true");
      const result = await capture(args, {
        ignoreError: true,
        includeStreams: true,
        includeStderr: true,
        timeout: timeoutMs,
        outputLimitBytes: 1024 * 1024,
      });
      const error = classifyCliOpenShellCommandError(result, {
        authentication: "OpenShell could not authenticate the sandbox audit setting update.",
        command: "OpenShell could not enable sandbox audit logs.",
        schema: "The OpenShell CLI and gateway settings schemas do not match.",
        timeout: "Enabling OpenShell sandbox audit logs timed out.",
      });
      return error ? { ok: false, error } : { ok: true, value: undefined };
    },
  };
}

export const cliOpenShellSandboxSettings = createCliOpenShellSandboxSettings();
