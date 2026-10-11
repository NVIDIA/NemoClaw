// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type SpawnOptions } from "node:child_process";
import { captureOpenshellCommandAsyncResult } from "../../adapters/openshell/command-execution";
import {
  buildSandboxCommandEnvironment,
  createCliOpenShellSandboxCommandExecutor,
} from "../../adapters/openshell/sandbox-command-cli";
import { createCliOpenShellInferenceRouteObserver } from "../../adapters/openshell/inference-route-cli";
import type {
  ObserveOpenShellInferenceRouteRequest,
  OpenShellInferenceRouteResult,
} from "../../adapters/openshell/inference-route";
import type { OpenShellSandboxBufferedCommandRequest } from "../../adapters/openshell/sandbox-command";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { resolveOpenshellBinaryOrNull } from "../../adapters/openshell/resolve-shared";
import { REPOSITORY_ROOT } from "../../core/repository-root";

/** Bounded native evidence shares cancellation and releases every installed listener. */
export function createSupervisedSandboxCommandReader(
  signal: AbortSignal,
  foreground = false,
): {
  read: (
    request: OpenShellSandboxBufferedCommandRequest,
    runtimeSelection?: OpenShellRuntimeSelection,
  ) => Promise<string>;
  observeInferenceRoute: (
    request: ObserveOpenShellInferenceRouteRequest,
    runtimeSelection: OpenShellRuntimeSelection,
  ) => Promise<OpenShellInferenceRouteResult>;
  dispose: () => void;
} {
  const listeners = { SIGTERM: new Set<() => void>(), SIGINT: new Set<() => void>() };
  const forwardTerm = () => {
    for (const listener of listeners.SIGTERM) listener();
  };
  const forwardProcessTerm = () => {
    forwardTerm();
    process.removeListener("SIGTERM", forwardProcessTerm);
    process.kill(process.pid, "SIGTERM");
  };
  const forwardInt = () => {
    for (const listener of listeners.SIGINT) listener();
    process.removeListener("SIGINT", forwardInt);
    process.kill(process.pid, "SIGINT");
  };
  signal.addEventListener("abort", forwardTerm, { once: true });
  process.on("SIGTERM", forwardProcessTerm);
  process.on("SIGINT", forwardInt);
  const signalSource = {
    add: (signalName: "SIGTERM" | "SIGINT", listener: () => void) => {
      listeners[signalName].add(listener);
      if (signal.aborted) queueMicrotask(listener);
    },
    remove: (signalName: "SIGTERM" | "SIGINT", listener: () => void) => {
      listeners[signalName].delete(listener);
    },
  };
  const capture = (
    binary: string,
    args: readonly string[],
    request: Parameters<typeof captureOpenshellCommandAsyncResult>[2],
  ) =>
    captureOpenshellCommandAsyncResult(binary, args, {
      ...request,
      killGraceMs: 0,
      signalSource,
      ...(foreground
        ? {
            spawnImpl: ((binary: string, args: readonly string[] = [], options?: SpawnOptions) =>
              spawn(binary, [...args], { ...options, detached: false })) as typeof spawn,
          }
        : {}),
    });
  const executor = createCliOpenShellSandboxCommandExecutor({
    signalSource,
    runBuffered: (binary, args, request) =>
      capture(binary, args, {
        ...request,
        cwd: request.hostCwd,
      }),
  });
  return {
    read: async (request, runtimeSelection) => {
      if (signal.aborted) throw new Error("Native evidence cancelled");
      const result = await executor.runBuffered({
        ...request,
        environment: buildSandboxCommandEnvironment(runtimeSelection, request.environment),
      });
      if (signal.aborted || result.outcome.kind !== "completed" || result.outcome.exitCode !== 0)
        throw new Error("Native evidence could not be verified");
      return result.stdout;
    },
    observeInferenceRoute: async (request, runtimeSelection) => {
      const environment = buildSandboxCommandEnvironment(runtimeSelection);
      return await createCliOpenShellInferenceRouteObserver(
        async (args, options) => {
          const binary = resolveOpenshellBinaryOrNull(environment);
          if (!binary) throw new Error("OpenShell is unavailable");
          const result = await capture(binary, args, {
            environment,
            cwd: REPOSITORY_ROOT,
            timeoutMilliseconds: options.timeout,
            timeoutKillSignal: "SIGKILL",
            outputLimitBytes: options.outputLimitBytes,
          });
          return { ...result, output: result.stdout };
        },
        { environment },
      ).observeInferenceRoute(request);
    },
    dispose: () => {
      signal.removeEventListener("abort", forwardTerm);
      process.removeListener("SIGTERM", forwardProcessTerm);
      process.removeListener("SIGINT", forwardInt);
    },
  };
}
