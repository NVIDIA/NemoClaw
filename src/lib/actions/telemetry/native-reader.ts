// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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
  const children = new Set<ChildProcess>();
  // Cleanup must not depend on the caller returning to the event loop.
  const killChildren = () => {
    for (const child of children) {
      try {
        if (!foreground && process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  };
  const listeners = { SIGTERM: new Set<() => void>(), SIGINT: new Set<() => void>() };
  const forwardTerm = () => {
    for (const listener of listeners.SIGTERM) listener();
  };
  const forwardProcessTerm = () => {
    forwardTerm();
    killChildren();
    process.removeListener("SIGTERM", forwardProcessTerm);
    process.kill(process.pid, "SIGTERM");
  };
  const forwardInt = () => {
    for (const listener of listeners.SIGINT) listener();
    killChildren();
    process.removeListener("SIGINT", forwardInt);
    process.kill(process.pid, "SIGINT");
  };
  const cancel = () => {
    forwardTerm();
    killChildren();
  };
  signal.addEventListener("abort", cancel, { once: true });
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
      spawnImpl: ((binary: string, args: readonly string[] = [], options?: SpawnOptions) => {
        if (signal.aborted) throw new Error("Native evidence cancelled");
        const child = spawn(binary, [...args], {
          ...options,
          ...(foreground ? { detached: false } : {}),
        });
        children.add(child);
        child.once("close", () => children.delete(child));
        if (signal.aborted) killChildren();
        return child;
      }) as typeof spawn,
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
      killChildren();
      signal.removeEventListener("abort", cancel);
      process.removeListener("SIGTERM", forwardProcessTerm);
      process.removeListener("SIGINT", forwardInt);
    },
  };
}
