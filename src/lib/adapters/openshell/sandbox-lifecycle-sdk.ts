// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as delay } from "node:timers/promises";

import { isValidName } from "../../name-validation";
import { fingerprintOpenShellSandboxId } from "./sandbox-identity";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";

export type MutateOpenShellSandboxRequest = Readonly<{
  sandboxName: string;
  sandboxIdentityFingerprint: string;
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>;
  timeoutMs?: number;
}>;

export type OpenShellSandboxMutationSubmission =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "failed"; error: OpenShellSandboxError }>;

export interface OpenShellSandboxStateLifecycle {
  startSandbox(request: MutateOpenShellSandboxRequest): Promise<OpenShellSandboxMutationSubmission>;
  stopSandbox(request: MutateOpenShellSandboxRequest): Promise<OpenShellSandboxMutationSubmission>;
}

type CallOptions = Readonly<{ signal: AbortSignal }>;
type SdkSandboxRef = Readonly<{ id: string; phase: string }>;
type SdkSandboxMutationResponse = Readonly<{
  sandbox?: Readonly<{ metadata?: Readonly<{ id?: string }> }>;
}>;
type SdkClient = Readonly<{
  sandbox: Readonly<{
    get(name: string, options: CallOptions): Promise<SdkSandboxRef>;
    waitReady(name: string, timeoutSecs: number, options: CallOptions): Promise<SdkSandboxRef>;
  }>;
  raw: Readonly<{
    startSandbox(
      request: Readonly<{ name: string; workspace: string }>,
      options: CallOptions,
    ): Promise<SdkSandboxMutationResponse>;
    stopSandbox(
      request: Readonly<{ name: string; workspace: string }>,
      options: CallOptions,
    ): Promise<SdkSandboxMutationResponse>;
  }>;
}>;

export type SdkOpenShellSandboxStateLifecycleDeps = Readonly<{
  connect?: (target: OpenShellGatewayTarget, options: CallOptions) => Promise<SdkClient>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loadSdk?: () => Promise<unknown>;
  waitForStopPoll?: (signal: AbortSignal) => Promise<void>;
}>;

const DEFAULT_MUTATION_TIMEOUT_MS = 75_000;

function lifecycleError(
  error: unknown,
  timedOut: boolean,
  action: "start" | "stop",
  observedPhase: string | undefined,
): OpenShellSandboxError {
  if (timedOut) {
    return { kind: "timeout", message: "OpenShell timed out." };
  }
  if (error instanceof Error && error.name === "OpenShellSdkPreflightUnavailableError") {
    return { kind: "transport", reason: "unreachable", message: error.message };
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const connectCode =
    error && typeof error === "object" && "connectCode" in error
      ? String((error as { connectCode?: unknown }).connectCode)
      : "";
  if (["7", "16", "auth", "permission_denied", "unauthenticated"].includes(code)) {
    return { kind: "authentication", message: "OpenShell denied access." };
  }
  if (["7", "16"].includes(connectCode)) {
    return { kind: "authentication", message: "OpenShell denied access." };
  }
  if (code === "4" || code === "canceled" || code === "deadline_exceeded") {
    return { kind: "timeout", message: "OpenShell timed out." };
  }
  if (["9", "failed_precondition"].includes(code) || connectCode === "9") {
    return {
      kind: "command",
      reason: "failed",
      message:
        observedPhase?.toLowerCase() === "error"
          ? `OpenShell rejected the ${action} request because the sandbox is in Error state.`
          : `OpenShell rejected the ${action} request because the sandbox's current state does not permit it.`,
    };
  }
  const errorName = error instanceof Error && error.name ? error.name : "unknown error";
  const diagnostic = [
    errorName,
    code ? `code ${code}` : "",
    connectCode ? `connect ${connectCode}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    kind: "transport",
    reason: "unreachable",
    message: `OpenShell is unavailable (${diagnostic}).`,
  };
}

async function mutate(
  action: "start" | "stop",
  request: MutateOpenShellSandboxRequest,
  connect: (target: OpenShellGatewayTarget, options: CallOptions) => Promise<SdkClient>,
  waitForStopPoll: (signal: AbortSignal) => Promise<void>,
): Promise<OpenShellSandboxMutationSubmission> {
  if (
    !isValidName(request.sandboxName) ||
    !isValidName(request.target.gatewayName) ||
    !/^[a-f0-9]{64}$/u.test(request.sandboxIdentityFingerprint) ||
    (request.timeoutMs !== undefined &&
      (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0))
  ) {
    return {
      kind: "failed",
      error: { kind: "schema", message: "Invalid sandbox request." },
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("OpenShell SDK connection timed out."), { code: "4" })),
      { once: true },
    );
  });
  let observedPhase: string | undefined;
  try {
    const client = await Promise.race([
      connect(request.target, { signal: controller.signal }),
      aborted,
    ]);
    const observed = await Promise.race([
      client.sandbox.get(request.sandboxName, { signal: controller.signal }),
      aborted,
    ]);
    if (fingerprintOpenShellSandboxId(observed.id) !== request.sandboxIdentityFingerprint) {
      return {
        kind: "failed",
        error: {
          kind: "transport",
          reason: "identity_mismatch",
          message: "OpenShell sandbox identity changed.",
        },
      };
    }
    observedPhase = observed.phase;
    const operation = action === "start" ? client.raw.startSandbox : client.raw.stopSandbox;
    const mutation = await Promise.race([
      operation({ name: request.sandboxName, workspace: "default" }, { signal: controller.signal }),
      aborted,
    ]);
    if (
      fingerprintOpenShellSandboxId(String(mutation.sandbox?.metadata?.id ?? "")) !==
      request.sandboxIdentityFingerprint
    ) {
      return {
        kind: "failed",
        error: {
          kind: "transport",
          reason: "identity_mismatch",
          message: "OpenShell lifecycle response changed sandbox identity.",
        },
      };
    }
    if (action === "start") {
      const ready = await Promise.race([
        client.sandbox.waitReady(
          request.sandboxName,
          Math.max(1, Math.ceil((request.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS) / 1000)),
          { signal: controller.signal },
        ),
        aborted,
      ]);
      if (fingerprintOpenShellSandboxId(ready.id) !== request.sandboxIdentityFingerprint) {
        return {
          kind: "failed",
          error: {
            kind: "transport",
            reason: "identity_mismatch",
            message: "OpenShell readiness changed sandbox identity.",
          },
        };
      }
    } else {
      for (;;) {
        const stopped = await Promise.race([
          client.sandbox.get(request.sandboxName, { signal: controller.signal }),
          aborted,
        ]);
        if (fingerprintOpenShellSandboxId(stopped.id) !== request.sandboxIdentityFingerprint) {
          return {
            kind: "failed",
            error: {
              kind: "transport",
              reason: "identity_mismatch",
              message: "OpenShell stop observation changed sandbox identity.",
            },
          };
        }
        if (stopped.phase.toLowerCase() === "stopped") break;
        await Promise.race([waitForStopPoll(controller.signal), aborted]);
      }
    }
    return { kind: "accepted" };
  } catch (error) {
    return {
      kind: "failed",
      error: lifecycleError(error, controller.signal.aborted, action, observedPhase),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Use the pinned OpenShell SDK for standard sandbox lifecycle mutation. */
export function createSdkOpenShellSandboxStateLifecycle(
  deps: SdkOpenShellSandboxStateLifecycleDeps = {},
): OpenShellSandboxStateLifecycle {
  const connect =
    deps.connect ??
    (async (target, options) => {
      const { connectManagedOpenShellSdk } = require("./sdk") as typeof import("./sdk");
      return (await connectManagedOpenShellSdk(target, {
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        signal: options.signal,
        ...(deps.loadSdk
          ? {
              loadSdk: deps.loadSdk as import("./sdk").OpenShellSdkConnectionDeps["loadSdk"],
            }
          : {}),
      })) as SdkClient;
    });
  const waitForStopPoll =
    deps.waitForStopPoll ?? ((signal: AbortSignal) => delay(250, undefined, { signal }));
  return {
    startSandbox: (request) => mutate("start", request, connect, waitForStopPoll),
    stopSandbox: (request) => mutate("stop", request, connect, waitForStopPoll),
  };
}
