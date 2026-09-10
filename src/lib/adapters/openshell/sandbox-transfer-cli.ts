// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type SpawnOptions } from "node:child_process";

import { redirectInheritedChildStdoutToStderr } from "../../cli/stdout-guard";
import {
  superviseProcessSession,
  type ProcessSessionChild,
  type ProcessSessionSignals,
} from "../../core/process-session";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import { buildOpenShellCommandEnv } from "./runtime";
import { resolveOpenshellBinaryOrNull } from "./resolve-shared";
import type {
  OpenShellSandboxTransferCompletion,
  OpenShellSandboxTransferExecutor,
  OpenShellSandboxTransferOutcome,
  OpenShellSandboxTransferRequest,
} from "./sandbox-transfer";

type TransferSpawner = (
  binary: string,
  args: readonly string[],
  options: SpawnOptions,
) => ProcessSessionChild;

const hostSignals: ProcessSessionSignals = {
  add: (signal, listener) => process.on(signal, listener),
  remove: (signal, listener) => process.off(signal, listener),
};

function failure(
  reason: Extract<OpenShellSandboxTransferOutcome, { kind: "failed" }>["reason"],
): OpenShellSandboxTransferCompletion {
  return { outcome: { kind: "failed", reason }, wasInterrupted: () => false, release() {} };
}

function validRequest(request: OpenShellSandboxTransferRequest): boolean {
  return (
    (request.direction === "upload" || request.direction === "download") &&
    isValidName(request.sandboxName) &&
    (request.target.kind === "selected" ||
      (request.target.kind === "named" && isValidName(request.target.gatewayName))) &&
    [request.source, request.destination].every(
      (value) => value.length > 0 && !value.includes("\0"),
    )
  );
}

export function createCliOpenShellSandboxTransferExecutor(
  deps: {
    resolveBinary?: () => string | null;
    spawnChild?: TransferSpawner;
    signalSource?: ProcessSessionSignals;
  } = {},
): OpenShellSandboxTransferExecutor {
  return {
    async run(request) {
      let binary: string | null;
      try {
        if (!validRequest(request)) return failure("invalid_request");
        assertNoOpenShellGatewayEndpointOverride();
        binary = (deps.resolveBinary ?? resolveOpenshellBinaryOrNull)();
      } catch {
        return failure("invalid_request");
      }
      if (!binary) return failure("unavailable");

      const gateway = request.target.kind === "named" ? ["-g", request.target.gatewayName] : [];
      const args = [
        "sandbox",
        request.direction,
        ...gateway,
        request.sandboxName,
        request.source,
        request.destination,
      ];
      const signals = deps.signalSource ?? hostSignals;
      let interrupted = false;
      const listeners = new Map<() => void, () => void>();
      const trackedSignals: ProcessSessionSignals = {
        add(signal, listener) {
          const tracked = () => {
            interrupted = true;
            listener();
          };
          listeners.set(listener, tracked);
          signals.add(signal, tracked);
        },
        remove(signal, listener) {
          const tracked = listeners.get(listener);
          if (tracked) signals.remove(signal, tracked);
          listeners.delete(listener);
        },
      };
      const spawnChild: TransferSpawner =
        deps.spawnChild ?? ((file, argv, options) => spawn(file, [...argv], options));
      // Transfers keep inherited output and have no fixed timeout or capture budget.
      const result = await superviseProcessSession(
        () =>
          spawnChild(binary, args, {
            cwd: REPOSITORY_ROOT,
            env: buildOpenShellCommandEnv(),
            stdio: redirectInheritedChildStdoutToStderr("inherit"),
          }),
        trackedSignals,
      );
      let outcome: OpenShellSandboxTransferOutcome;
      if (interrupted || result.signal) {
        outcome = { kind: "failed", reason: "interrupted" };
      } else if (result.error) {
        outcome = {
          kind: "failed",
          reason:
            (result.error as NodeJS.ErrnoException).code === "ENOENT"
              ? "unavailable"
              : "invocation",
        };
      } else if (result.status === null) {
        outcome = { kind: "failed", reason: "indeterminate" };
      } else {
        outcome = { kind: "completed", exitCode: result.status };
      }
      return {
        outcome,
        wasInterrupted: () => interrupted,
        release: result.releaseSignals ?? (() => {}),
      };
    },
  };
}
