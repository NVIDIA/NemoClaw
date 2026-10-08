// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  type CollectOpenShellGpuDiagnosticsRequest,
  type OpenShellGpuDiagnosticArtifact,
  type OpenShellGpuDiagnosticArtifactName,
  type OpenShellGpuDiagnosticError,
  type OpenShellGpuDiagnostics,
} from "./gpu-diagnostics";
import {
  buildOpenShellDiagnosticEnvironment,
  resolveOpenshellBinaryOrNull,
} from "./resolve-shared";
import { assertCliOpenShellSandboxName, assertCliOpenShellTarget } from "./target-validation";

const GPU_DIAGNOSTIC_OUTPUT_LIMIT_BYTES = 1024 * 1024;

type CaptureGpuDiagnostic = (
  binary: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    killSignal: "SIGKILL";
    maxBuffer: number;
    stdio: ["ignore", "pipe", "pipe"];
    timeout: number;
  }>,
) => Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stderr" | "stdout">;

type GpuDiagnosticCommand = Readonly<{
  name: OpenShellGpuDiagnosticArtifactName;
  args: readonly string[];
}>;

type GpuDiagnosticRunnerResult = Readonly<{
  error?: Error | null;
  signal?: NodeJS.Signals | null;
  status: number | null;
  stderr: string | Buffer | null;
  stdout: string | Buffer | null;
}>;

export type RunnerOpenShellGpuDiagnosticsDeps = Readonly<{
  authority?: Readonly<{
    sandboxName: string;
    target: CollectOpenShellGpuDiagnosticsRequest["target"];
  }>;
  decodeOutput?: (value: string | Buffer) => string;
  now?: () => number;
  run: (args: readonly string[], timeoutMs: number) => GpuDiagnosticRunnerResult;
  supportsDoctorLogs?: boolean;
}>;

export type CliOpenShellGpuDiagnosticsDeps = Readonly<{
  capture?: CaptureGpuDiagnostic;
  environment?: NodeJS.ProcessEnv;
  hostCwd?: string;
  now?: () => number;
  outputLimitBytes?: number;
  resolveBinary?: (environment: NodeJS.ProcessEnv) => string | null;
}>;

function targetArgs(target: CollectOpenShellGpuDiagnosticsRequest["target"]): string[] {
  return target.kind === "named" ? ["-g", target.gatewayName] : [];
}

function commands(
  sandboxName: string,
  target: CollectOpenShellGpuDiagnosticsRequest["target"],
): readonly GpuDiagnosticCommand[] {
  const gateway = targetArgs(target);
  return [
    {
      name: "openshell-sandbox-get.txt",
      args: ["sandbox", "get", ...gateway, sandboxName],
    },
    { name: "openshell-sandbox-list.txt", args: ["sandbox", "list", ...gateway] },
    {
      name: "openshell-logs.txt",
      args: ["doctor", "logs", ...gateway, "--name", "nemoclaw"],
    },
  ];
}

function validateRequest(
  request: CollectOpenShellGpuDiagnosticsRequest,
  environment: NodeJS.ProcessEnv,
): void {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error("Invalid OpenShell GPU diagnostic timeout");
  }
  if (request.deadlineMs !== undefined && !Number.isFinite(request.deadlineMs)) {
    throw new Error("Invalid OpenShell GPU diagnostic deadline");
  }
  assertCliOpenShellSandboxName(request.sandboxName);
  assertCliOpenShellTarget(request.target, environment);
}

function sameTarget(
  left: CollectOpenShellGpuDiagnosticsRequest["target"],
  right: CollectOpenShellGpuDiagnosticsRequest["target"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "selected" || (right.kind === "named" && left.gatewayName === right.gatewayName))
  );
}

function errorFor(error: Error, redact: (value: string) => string): OpenShellGpuDiagnosticError {
  const code = (error as NodeJS.ErrnoException).code;
  const message = redact(error.message);
  if (code === "ENOENT") return { kind: "unavailable", message };
  if (code === "ETIMEDOUT") return { kind: "timeout", message };
  if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "capture", message };
  }
  return { kind: "invocation", message };
}

function failedArtifacts(
  error: OpenShellGpuDiagnosticError,
): readonly OpenShellGpuDiagnosticArtifact[] {
  return ["openshell-sandbox-get.txt", "openshell-sandbox-list.txt", "openshell-logs.txt"].map(
    (name) => ({
      name,
      content: "",
      outcome: { kind: "failed", error },
    }),
  ) as readonly OpenShellGpuDiagnosticArtifact[];
}

function failedArtifact(
  name: OpenShellGpuDiagnosticArtifactName,
  error: OpenShellGpuDiagnosticError,
): OpenShellGpuDiagnosticArtifact {
  return { name, content: "", outcome: { kind: "failed", error } };
}

/** Adapt one already-authorized OpenShell runner to the closed GPU diagnostic capability. */
export function createRunnerOpenShellGpuDiagnostics(
  deps: RunnerOpenShellGpuDiagnosticsDeps,
): OpenShellGpuDiagnostics {
  return {
    collect(request) {
      const target = deps.authority?.target ?? request.target;
      try {
        validateRequest(request, {});
        assertCliOpenShellTarget(target, {});
        if (
          deps.authority &&
          (request.sandboxName !== deps.authority.sandboxName ||
            (request.target.kind === "named" && !sameTarget(request.target, target)))
        ) {
          throw new Error("OpenShell GPU diagnostics disagree with runner authority");
        }
      } catch (error) {
        return failedArtifacts({
          kind: "configuration",
          message: request.redact(error instanceof Error ? error.message : String(error)),
        });
      }

      const now = deps.now ?? Date.now;
      const artifacts: OpenShellGpuDiagnosticArtifact[] = [];
      for (const { name, args } of commands(request.sandboxName, target)) {
        if (name === "openshell-logs.txt" && deps.supportsDoctorLogs === false) {
          artifacts.push(
            failedArtifact(name, {
              kind: "unavailable",
              message: "OpenShell runner authority does not support doctor logs",
            }),
          );
          continue;
        }
        const remainingMs =
          request.deadlineMs === undefined
            ? request.timeoutMs
            : Math.ceil(request.deadlineMs - now());
        if (remainingMs <= 0) {
          artifacts.push(
            failedArtifact(name, {
              kind: "timeout",
              message: "OpenShell GPU diagnostic deadline expired",
            }),
          );
          continue;
        }
        let result: GpuDiagnosticRunnerResult;
        try {
          result = deps.run(args, Math.min(request.timeoutMs, remainingMs));
        } catch (error) {
          artifacts.push(
            failedArtifact(
              name,
              errorFor(error instanceof Error ? error : new Error(String(error)), request.redact),
            ),
          );
          continue;
        }
        if (result.error) {
          artifacts.push(failedArtifact(name, errorFor(result.error, request.redact)));
          continue;
        }
        if (result.signal) {
          artifacts.push(
            failedArtifact(name, {
              kind: "invocation",
              message: `OpenShell GPU diagnostic exited on ${result.signal}`,
            }),
          );
          continue;
        }
        if (result.status !== 0) {
          artifacts.push(
            failedArtifact(name, {
              kind: "invocation",
              message: `OpenShell GPU diagnostic exited with code ${String(result.status)}`,
            }),
          );
          continue;
        }
        try {
          const stdout = result.stdout ?? "";
          const content = deps.decodeOutput ? deps.decodeOutput(stdout) : String(stdout);
          artifacts.push({
            name,
            content: request.redact(content.trim()),
            outcome: { kind: "completed", exitCode: 0 },
          });
        } catch (error) {
          artifacts.push(
            failedArtifact(name, {
              kind: "capture",
              message: request.redact(error instanceof Error ? error.message : String(error)),
            }),
          );
        }
      }
      return artifacts;
    },
  };
}

export function createCliOpenShellGpuDiagnostics(
  deps: CliOpenShellGpuDiagnosticsDeps = {},
): OpenShellGpuDiagnostics {
  const capture: CaptureGpuDiagnostic =
    deps.capture ?? ((binary, args, options) => spawnSync(binary, [...args], options));
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  return {
    collect(request) {
      const sourceEnvironment = deps.environment ?? process.env;
      try {
        validateRequest(request, sourceEnvironment);
      } catch (error) {
        return failedArtifacts({
          kind: "configuration",
          message: request.redact(error instanceof Error ? error.message : String(error)),
        });
      }

      let binary: string | null;
      try {
        binary = resolveBinary(sourceEnvironment);
      } catch (error) {
        return failedArtifacts(
          errorFor(error instanceof Error ? error : new Error(String(error)), request.redact),
        );
      }
      if (!binary) {
        return failedArtifacts({
          kind: "unavailable",
          message: "OpenShell binary not found",
        });
      }
      if (!path.isAbsolute(binary)) {
        return failedArtifacts({
          kind: "configuration",
          message: "OpenShell executable must be absolute",
        });
      }

      const environment = buildOpenShellDiagnosticEnvironment(sourceEnvironment);
      return createRunnerOpenShellGpuDiagnostics({
        now: deps.now,
        run: (args, timeout) =>
          capture(binary, args, {
            cwd: deps.hostCwd ?? REPOSITORY_ROOT,
            encoding: "utf8",
            env: environment,
            killSignal: "SIGKILL",
            maxBuffer: deps.outputLimitBytes ?? GPU_DIAGNOSTIC_OUTPUT_LIMIT_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            timeout,
          }),
      }).collect(request);
    },
  };
}

export const cliOpenShellGpuDiagnostics = createCliOpenShellGpuDiagnostics();
