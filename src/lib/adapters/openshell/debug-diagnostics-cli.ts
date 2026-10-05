// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { spawnExitCode } from "../../core/process-exit";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  assertCliOpenShellSandboxName,
  assertCliOpenShellTarget,
  runCliOpenShellBufferedCommand,
  type OpenShellBufferedCommandRunner,
} from "./sandbox-command-cli";
import {
  type CollectOpenShellDebugDiagnosticsRequest,
  type OpenShellDebugArtifact,
  type OpenShellDebugArtifactName,
  type OpenShellDebugDiagnosticError,
  type OpenShellDebugDiagnostics,
} from "./debug-diagnostics";
import {
  buildOpenShellDiagnosticEnvironment,
  resolveOpenshellBinaryOrNull,
} from "./resolve-shared";

const DEBUG_OUTPUT_LIMIT_BYTES = 1024 * 1024;

type DebugCommand = Readonly<{
  name: OpenShellDebugArtifactName;
  args: readonly string[];
}>;

export type CliOpenShellDebugDiagnosticsDeps = Readonly<{
  environment?: NodeJS.ProcessEnv;
  hostCwd?: string;
  outputLimitBytes?: number;
  redact: (value: string) => string;
  resolveBinary?: (environment: NodeJS.ProcessEnv) => string | null;
  runBuffered?: OpenShellBufferedCommandRunner;
}>;

function targetArgs(request: CollectOpenShellDebugDiagnosticsRequest): string[] {
  return request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
}

function commands(request: CollectOpenShellDebugDiagnosticsRequest): readonly DebugCommand[] {
  const gateway = targetArgs(request);
  return [
    { name: "openshell-status", args: ["status", ...gateway] },
    { name: "openshell-sandbox-list", args: ["sandbox", "list", ...gateway] },
    {
      name: "openshell-sandbox-get",
      args: ["sandbox", "get", ...gateway, request.sandboxName],
    },
    { name: "openshell-logs", args: ["logs", ...gateway, request.sandboxName] },
    ...(!request.quick
      ? [{ name: "openshell-gateway-info" as const, args: ["gateway", "info", ...gateway] }]
      : []),
  ];
}

function errorFor(error: Error, redact: (value: string) => string): OpenShellDebugDiagnosticError {
  const code = (error as NodeJS.ErrnoException).code;
  const message = redact(error.message);
  if (code === "ENOENT") return { kind: "unavailable", message };
  if (code === "ETIMEDOUT") return { kind: "timeout", message };
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { kind: "capture", message };
  return { kind: "invocation", message };
}

function failedArtifacts(
  request: CollectOpenShellDebugDiagnosticsRequest,
  error: OpenShellDebugDiagnosticError,
  content: string,
): readonly OpenShellDebugArtifact[] {
  return commands(request).map(({ name }) => ({
    name,
    content,
    outcome: { kind: "failed", error },
  }));
}

export function createCliOpenShellDebugDiagnostics(
  deps: CliOpenShellDebugDiagnosticsDeps,
): OpenShellDebugDiagnostics {
  const runBuffered = deps.runBuffered ?? runCliOpenShellBufferedCommand;
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  return {
    async collect(request) {
      const sourceEnvironment = deps.environment ?? process.env;
      try {
        if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
          throw new Error("Invalid OpenShell debug timeout");
        }
        assertCliOpenShellSandboxName(request.sandboxName);
        assertCliOpenShellTarget(request.target, sourceEnvironment);
      } catch (error) {
        const configuration = {
          kind: "configuration" as const,
          message: deps.redact(error instanceof Error ? error.message : String(error)),
        };
        return failedArtifacts(
          request,
          configuration,
          `  (OpenShell diagnostics skipped: ${configuration.message})\n`,
        );
      }

      let binary: string | null;
      try {
        binary = resolveBinary(sourceEnvironment);
      } catch (error) {
        const invocation = errorFor(
          error instanceof Error ? error : new Error(String(error)),
          deps.redact,
        );
        return failedArtifacts(request, invocation, "\n");
      }
      if (!binary) {
        return failedArtifacts(
          request,
          { kind: "unavailable", message: "OpenShell binary not found" },
          "  (openshell not found, skipping)\n",
        );
      }
      if (!path.isAbsolute(binary)) {
        return failedArtifacts(
          request,
          { kind: "configuration", message: "OpenShell executable must be absolute" },
          "  (OpenShell diagnostics skipped: OpenShell executable must be absolute)\n",
        );
      }

      const environment = buildOpenShellDiagnosticEnvironment(sourceEnvironment);
      const artifacts: OpenShellDebugArtifact[] = [];
      for (const command of commands(request)) {
        let result: Awaited<ReturnType<OpenShellBufferedCommandRunner>>;
        try {
          result = await runBuffered(binary, command.args, {
            environment,
            hostCwd: deps.hostCwd ?? REPOSITORY_ROOT,
            outputLimitBytes: deps.outputLimitBytes ?? DEBUG_OUTPUT_LIMIT_BYTES,
            timeoutKillSignal: "SIGKILL",
            timeoutMilliseconds: request.timeoutMs,
          });
        } catch (error) {
          const invocation = errorFor(
            error instanceof Error ? error : new Error(String(error)),
            deps.redact,
          );
          artifacts.push({
            name: command.name,
            content: "\n",
            outcome: { kind: "failed", error: invocation },
          });
          continue;
        }
        const content = deps.redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
        let error: OpenShellDebugDiagnosticError | null = null;
        if (result.timedOut) {
          error = { kind: "timeout", message: "OpenShell diagnostic timed out" };
        } else if (result.error) {
          error = errorFor(result.error, deps.redact);
        }
        artifacts.push({
          name: command.name,
          content,
          outcome: error
            ? { kind: "failed", error }
            : { kind: "completed", exitCode: spawnExitCode(result) },
        });
      }
      return artifacts;
    },
  };
}
