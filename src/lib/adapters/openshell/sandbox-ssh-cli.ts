// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import { createTempSshConfig } from "../../sandbox/temp-ssh-config";
import { resolveOpenshell } from "./resolve";
import {
  runCliOpenShellBufferedCommand,
  type OpenShellBufferedCommandRunner,
  type OpenShellBufferedCommandRunResult,
} from "./sandbox-command-cli";
import { resolveOpenshellSandboxSshHost } from "./sandbox-ssh-host";
import type { OpenShellSandboxSshExecutor, OpenShellSandboxSshResult } from "./sandbox-ssh";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

function failure(result: OpenShellBufferedCommandRunResult): OpenShellSandboxSshResult | null {
  if (result.timedOut) return { kind: "failed", reason: "timeout" };
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") return { kind: "failed", reason: "timeout" };
  if (code === "ENOENT") return { kind: "failed", reason: "unavailable" };
  if (code === "ECANCELED" || result.signal) {
    return {
      kind: "failed",
      reason: "cancelled",
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { kind: "failed", reason: "capture" };
  if (result.error || result.status === null) return { kind: "failed", reason: "transport" };
  return null;
}

export function createCliOpenShellSandboxSshExecutor(
  deps: {
    resolveBinary?: () => string | null;
    runBuffered?: OpenShellBufferedCommandRunner;
    commandTransport?: boolean;
  } = {},
): OpenShellSandboxSshExecutor {
  const run = deps.runBuffered ?? runCliOpenShellBufferedCommand;
  return {
    async run(request) {
      const environment = request.environment;
      try {
        assertNoOpenShellGatewayEndpointOverride(environment ?? process.env);
      } catch {
        return { kind: "failed", reason: "configuration" };
      }
      if (
        !isValidName(request.sandboxName) ||
        (request.target.kind === "named" && !isValidName(request.target.gatewayName)) ||
        request.command.includes("\0")
      ) {
        return { kind: "failed", reason: "configuration" };
      }
      const binary = (deps.resolveBinary ?? resolveOpenshell)();
      if (!binary) return { kind: "failed", reason: "unavailable" };
      const gateway = request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
      const probeOptions = { environment, timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS };
      try {
        const sandbox = await run(
          binary,
          ["sandbox", "get", ...gateway, request.sandboxName],
          probeOptions,
        );
        const sandboxFailure = failure(sandbox);
        if (sandboxFailure) return sandboxFailure;
        if (sandbox.status !== 0) return { kind: "failed", reason: "transport" };
        const config = await run(
          binary,
          ["sandbox", "ssh-config", ...gateway, request.sandboxName],
          probeOptions,
        );
        const configFailure = failure(config);
        if (configFailure) return configFailure;
        if (config.status !== 0) return { kind: "failed", reason: "transport" };
        const sshHost = resolveOpenshellSandboxSshHost(request.sandboxName, config.stdout);
        if (sshHost === null) {
          return { kind: "failed", reason: "configuration" };
        }
        const temporary = createTempSshConfig(
          config.stdout,
          deps.commandTransport ? "nemoclaw-ssh-" : "nemoclaw-ver-",
        );
        try {
          const result = await run(
            "ssh",
            [
              "-F",
              temporary.file,
              "-o",
              "StrictHostKeyChecking=no",
              "-o",
              "UserKnownHostsFile=/dev/null",
              "-o",
              "ConnectTimeout=5",
              "-o",
              "LogLevel=ERROR",
              sshHost,
              request.command,
            ],
            {
              environment,
              timeoutMilliseconds: request.timeoutMilliseconds ?? 15000,
            },
          );
          // OpenSSH cannot distinguish a transport failure from remote exit 255.
          const commandFailure =
            failure(result) ??
            (result.status === 255
              ? { kind: "failed" as const, reason: "transport" as const }
              : null);
          if (commandFailure) {
            return deps.commandTransport
              ? {
                  ...commandFailure,
                  command: {
                    exitCode: result.status ?? 1,
                    stdout: result.stdout,
                    stderr: result.stderr,
                  },
                }
              : commandFailure;
          }
          return {
            kind: "completed",
            exitCode: result.status ?? 1,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        } finally {
          temporary.cleanup();
        }
      } catch {
        return { kind: "failed", reason: "transport" };
      }
    },
  };
}

/** Retain legacy host aliases and command diagnostics needed during recovery. */
export function createCliOpenShellSandboxSshCommandExecutor(
  deps: Parameters<typeof createCliOpenShellSandboxSshExecutor>[0] = {},
): OpenShellSandboxSshExecutor {
  return createCliOpenShellSandboxSshExecutor({ ...deps, commandTransport: true });
}
