// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../sandbox-name-contract";
import { redactCredentialText } from "../../security/credential-filter";
import { redact } from "../../security/redact";
import { withSelectedOpenShellCommandOptions } from "./command-argv";
import { assertNoOpenShellGatewayEndpointOverride } from "./gateway-scope";
import type {
  DeleteOpenShellSandboxRequest,
  OpenShellSandboxDeleteSubmission,
  OpenShellSandboxLifecycle,
} from "./sandbox-lifecycle";
import {
  classifyCliOpenShellCommandError,
  createCliOpenShellSandboxLookupFromRunner,
  createCliOpenShellSandboxObserverFromRunner,
  isExplicitMissingOpenShellSandboxOutput,
  type CapturedOpenShellCommandResult,
} from "./sandbox-observer-cli";
import type { OpenShellSandboxError } from "./sandbox-observer";
import { OPENSHELL_HEAVY_TIMEOUT_MS } from "./command-execution";

const DIAGNOSTIC_LIMIT_BYTES = 4 * 1024;
const CAPTURE_LIMIT_BYTES = 1024 * 1024;

export { createCliOpenShellSandboxLookupFromRunner, createCliOpenShellSandboxObserverFromRunner };

const deleteMessages = {
  authentication: "OpenShell could not authorize the sandbox deletion.",
  command: "The OpenShell sandbox deletion failed.",
  schema: "The OpenShell CLI and gateway sandbox schemas do not match.",
  timeout: "OpenShell sandbox deletion timed out; its result is unknown.",
  unavailable: "OpenShell is unavailable.",
} as const;

const invalidDeleteError: OpenShellSandboxError = {
  kind: "command",
  reason: "invalid_request",
  message: "Invalid OpenShell sandbox deletion request.",
};

export type SandboxLifecycleCapture = (
  args: string[],
  options: {
    env?: Record<string, string>;
    ignoreError: true;
    includeStderr: true;
    includeStreams: true;
    maxBuffer: number;
    replaceEnv?: true;
    timeout: number;
  },
) => CapturedOpenShellCommandResult | Promise<CapturedOpenShellCommandResult>;

export type RunSandboxMutationCommand = (
  args: string[],
  options: {
    env?: Record<string, string>;
    ignoreError: true;
    killProcessTreeOnTimeout: true;
    killSignal: "SIGKILL";
    maxBuffer: number;
    replaceEnv?: true;
    stdio: ["ignore", "pipe", "pipe"];
    suppressOutput: true;
    timeout: number;
  },
) => Readonly<{
  status?: number | null;
  output?: unknown;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error | null;
  signal?: NodeJS.Signals | null;
}>;

function safeDiagnostic(value: string): string {
  const redacted = redactCredentialText(redact(value));
  if (Buffer.byteLength(redacted, "utf8") <= DIAGNOSTIC_LIMIT_BYTES) return redacted;
  const marker = "\n[OpenShell diagnostic truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  const suffixBytes = Math.max(0, DIAGNOSTIC_LIMIT_BYTES - markerBytes);
  const suffixBuffer = Buffer.from(redacted).subarray(-suffixBytes);
  let suffixStart = 0;
  while (suffixStart < suffixBuffer.length && ((suffixBuffer[suffixStart] ?? 0) & 0xc0) === 0x80) {
    suffixStart += 1;
  }
  const suffix = suffixBuffer.subarray(suffixStart).toString("utf8");
  return `${marker}${suffix}`;
}

function validDeleteRequest(request: DeleteOpenShellSandboxRequest): boolean {
  return (
    isValidName(request.sandboxName) &&
    request.target.kind === "named" &&
    isValidName(request.target.gatewayName) &&
    (request.timeoutMs === undefined ||
      (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0)) &&
    (!request.runtimeSelection ||
      request.runtimeSelection.gatewayName === request.target.gatewayName)
  );
}

function outputOf(result: CapturedOpenShellCommandResult): string {
  const streams = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return streams || result.output.trim();
}

function failedDelete(
  error: OpenShellSandboxError,
  diagnostic = "",
  exitCode: number | null = null,
  ambiguous = false,
): OpenShellSandboxDeleteSubmission {
  return { kind: "failed", diagnostic, error, ambiguous, exitCode };
}

function isAmbiguousFailure(
  result: CapturedOpenShellCommandResult,
  error: OpenShellSandboxError,
): boolean {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "EACCES") return false;
  if (
    error.kind === "timeout" ||
    result.status === null ||
    code === "ABORT_ERR" ||
    code === "EPIPE" ||
    code === "ENOBUFS"
  ) {
    return true;
  }
  const output = outputOf(result);
  if (
    error.kind === "transport" &&
    /\b(?:connection refused|no active gateway|no gateway configured|unknown gateway)\b/iu.test(
      output,
    )
  ) {
    return false;
  }
  return error.kind === "transport";
}

export function createCliOpenShellSandboxLifecycle(input: {
  capture: SandboxLifecycleCapture;
  defaultTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}): OpenShellSandboxLifecycle {
  return {
    async deleteSandbox(request) {
      if (!validDeleteRequest(request)) return failedDelete(invalidDeleteError);
      if (!request.runtimeSelection) {
        try {
          assertNoOpenShellGatewayEndpointOverride(input.environment ?? process.env);
        } catch {
          return failedDelete(invalidDeleteError);
        }
      }

      let captured: CapturedOpenShellCommandResult;
      const timeoutMs = request.timeoutMs ?? input.defaultTimeoutMs ?? OPENSHELL_HEAVY_TIMEOUT_MS;
      try {
        captured = await input.capture(
          ["sandbox", "delete", "-g", request.target.gatewayName, request.sandboxName],
          withSelectedOpenShellCommandOptions(
            {
              ignoreError: true,
              includeStderr: true,
              includeStreams: true,
              maxBuffer: CAPTURE_LIMIT_BYTES,
              timeout: timeoutMs,
            } as const,
            request.runtimeSelection,
          ),
        );
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error("OpenShell capture failed.");
        const code = (error as NodeJS.ErrnoException).code;
        const definiteSpawnFailure = code === "ENOENT" || code === "EACCES";
        return failedDelete(
          definiteSpawnFailure
            ? { kind: "command", reason: "failed", message: deleteMessages.unavailable }
            : { kind: "transport", reason: "unreachable", message: deleteMessages.command },
          "",
          null,
          !definiteSpawnFailure,
        );
      }

      const output = outputOf(captured);
      const diagnostic = safeDiagnostic(output);
      const printedError = /^\s*Error:/imu.test(output);
      const error = classifyCliOpenShellCommandError(
        printedError && captured.status === 0 ? { ...captured, status: 1 } : captured,
        {
          ...deleteMessages,
          timeout: `OpenShell sandbox delete timed out after ${String(timeoutMs / 1_000)} seconds. Deletion could not be confirmed.`,
        },
      );
      if (!error) return { kind: "accepted", diagnostic, exitCode: 0 };
      if (
        error.kind === "command" &&
        captured.status !== null &&
        !captured.error &&
        isExplicitMissingOpenShellSandboxOutput(output, request.sandboxName)
      ) {
        return { kind: "absent", diagnostic, exitCode: captured.status ?? 1 };
      }
      return failedDelete(error, diagnostic, captured.status, isAmbiguousFailure(captured, error));
    },
  };
}

function streamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

/** Adapt the existing buffered runner only inside the lifecycle transport boundary. */
export function createCliOpenShellSandboxLifecycleFromRunner(
  run: RunSandboxMutationCommand,
  options: Readonly<{ defaultTimeoutMs?: number; environment?: NodeJS.ProcessEnv }> = {},
): OpenShellSandboxLifecycle {
  return createCliOpenShellSandboxLifecycle({
    ...options,
    capture: (args, captureOptions) => {
      const result = run(args, {
        ...(captureOptions.env ? { env: captureOptions.env } : {}),
        ignoreError: true,
        killProcessTreeOnTimeout: true,
        killSignal: "SIGKILL",
        maxBuffer: captureOptions.maxBuffer,
        ...(captureOptions.replaceEnv ? { replaceEnv: true as const } : {}),
        suppressOutput: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: captureOptions.timeout,
      });
      const stdout = result.stdout === undefined ? undefined : streamText(result.stdout);
      const stderr = result.stderr === undefined ? undefined : streamText(result.stderr);
      const interruption = result.signal
        ? Object.assign(new Error("OpenShell sandbox deletion was interrupted."), {
            code: "ABORT_ERR",
          })
        : undefined;
      const error = interruption ?? result.error;
      return {
        status: result.status ?? null,
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
        output: streamText(result.output) || `${stdout ?? ""}\n${stderr ?? ""}`.trim(),
        ...(error ? { error } : {}),
      };
    },
  });
}
