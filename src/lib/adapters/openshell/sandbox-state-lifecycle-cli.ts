// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { isValidName } from "../../name-validation";
import { buildOpenShellSubprocessEnv, resolveOpenshellBinaryOrNull } from "./resolve-shared";
import type {
  MutateOpenShellSandboxRequest,
  OpenShellSandboxMutationSubmission,
  OpenShellSandboxStateLifecycle,
} from "./sandbox-lifecycle-sdk";

const DEFAULT_MUTATION_TIMEOUT_MS = 75_000;

export function createCliOpenShellSandboxStateLifecycle(
  environment: NodeJS.ProcessEnv,
): OpenShellSandboxStateLifecycle {
  const mutate = (
    action: "start" | "stop",
    request: MutateOpenShellSandboxRequest,
  ): OpenShellSandboxMutationSubmission => {
    if (
      !isValidName(request.sandboxName) ||
      !isValidName(request.target.gatewayName) ||
      (request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
    ) {
      return {
        kind: "failed",
        error: { kind: "schema", message: "Invalid sandbox request." },
      };
    }
    const executable = resolveOpenshellBinaryOrNull(environment);
    if (!executable || !path.isAbsolute(executable)) {
      return {
        kind: "failed",
        error: { kind: "transport", reason: "unreachable", message: "OpenShell is unavailable." },
      };
    }
    const result = spawnSync(
      executable,
      ["sandbox", action, "-g", request.target.gatewayName, request.sandboxName],
      {
        encoding: "utf8",
        env: buildOpenShellSubprocessEnv(environment),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: request.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
      },
    );
    if (result.status === 0 && !result.error && !result.signal) return { kind: "accepted" };
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      kind: "failed",
      error: timedOut
        ? { kind: "timeout", message: "OpenShell timed out." }
        : {
            kind: "command",
            reason: "failed",
            message: `OpenShell could not ${action} the sandbox.`,
          },
    };
  };
  return {
    startSandbox: (request) => Promise.resolve(mutate("start", request)),
    stopSandbox: (request) => Promise.resolve(mutate("stop", request)),
  };
}
