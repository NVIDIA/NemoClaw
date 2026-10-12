// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import path from "node:path";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import { redactCredentialText } from "../../security/credential-filter";
import type {
  OpenShellInstalledVersionError,
  OpenShellInstalledVersionObservation,
  OpenShellInstalledVersionObserver,
} from "./installed-version";
import { buildOpenShellSubprocessEnv, resolveOpenshellBinaryOrNull } from "./resolve-shared";
import { parseOpenShellVersionFromText } from "./version-text";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT_BYTES = 16 * 1024;

type CaptureInstalledVersion = (
  binary: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    stdio: ["ignore", "pipe", "pipe"];
    timeout: number;
  }>,
) => Pick<SpawnSyncReturns<string>, "error" | "status" | "stderr" | "stdout">;

export type CliOpenShellInstalledVersionObserverDeps = Readonly<{
  capture?: CaptureInstalledVersion;
  environment?: NodeJS.ProcessEnv;
  hostCwd?: string;
  outputLimitBytes?: number;
  resolveBinary?: (environment: NodeJS.ProcessEnv) => string | null;
  timeoutMs?: number;
}>;

function failure(
  kind: OpenShellInstalledVersionError["kind"],
  message: string,
): OpenShellInstalledVersionObservation {
  return { ok: false, error: { kind, message: redactCredentialText(message) } };
}

function captureError(error: Error): OpenShellInstalledVersionObservation {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return failure("unavailable", error.message);
  if (code === "ETIMEDOUT") return failure("timeout", error.message);
  if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return failure("capture", error.message);
  }
  return failure("invocation", error.message);
}

export function createCliOpenShellInstalledVersionObserver(
  deps: CliOpenShellInstalledVersionObserverDeps = {},
): OpenShellInstalledVersionObserver {
  const capture: CaptureInstalledVersion =
    deps.capture ?? ((binary, args, options) => spawnSync(binary, [...args], options));
  const sourceEnvironment = deps.environment ?? process.env;
  const resolveBinary = deps.resolveBinary ?? resolveOpenshellBinaryOrNull;
  return {
    observeInstalledVersion(request = {}) {
      const timeoutMs = request.timeoutMs ?? deps.timeoutMs ?? VERSION_TIMEOUT_MS;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return failure("configuration", "Invalid OpenShell version probe timeout.");
      }

      let binary: string | null;
      try {
        binary = resolveBinary(sourceEnvironment);
      } catch (error) {
        return failure("invocation", error instanceof Error ? error.message : String(error));
      }
      if (!binary) return failure("unavailable", "OpenShell binary not found.");
      if (!path.isAbsolute(binary)) {
        return failure("configuration", "OpenShell executable must be absolute.");
      }

      let result: ReturnType<CaptureInstalledVersion>;
      try {
        result = capture(binary, ["-V"], {
          cwd: deps.hostCwd ?? REPOSITORY_ROOT,
          encoding: "utf8",
          env: buildOpenShellSubprocessEnv(sourceEnvironment),
          maxBuffer: deps.outputLimitBytes ?? VERSION_OUTPUT_LIMIT_BYTES,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
        });
      } catch (error) {
        return captureError(error instanceof Error ? error : new Error(String(error)));
      }
      if (result.error) return captureError(result.error);

      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.status !== 0) {
        const diagnostic = redactCredentialText(output).trim();
        return failure(
          "invocation",
          diagnostic
            ? `OpenShell version probe failed: ${diagnostic}`
            : `OpenShell version probe failed with exit ${String(result.status)}.`,
        );
      }
      const version = parseOpenShellVersionFromText(output);
      return version
        ? { ok: true, version }
        : failure("malformed", "OpenShell returned an unrecognized version.");
    },
  };
}

export const cliOpenShellInstalledVersionObserver = createCliOpenShellInstalledVersionObserver();
