// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";

export type MutateOpenShellSandboxRequest = Readonly<{
  sandboxName: string;
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
type SdkClient = Readonly<{
  sandbox: Readonly<{
    waitReady(name: string, timeoutSecs: number, options: CallOptions): Promise<unknown>;
  }>;
  raw: Readonly<{
    startSandbox(
      request: Readonly<{ name: string; workspace: string }>,
      options: CallOptions,
    ): Promise<unknown>;
    stopSandbox(
      request: Readonly<{ name: string; workspace: string }>,
      options: CallOptions,
    ): Promise<unknown>;
  }>;
}>;

export type SdkOpenShellSandboxStateLifecycleDeps = Readonly<{
  connect?: (target: OpenShellGatewayTarget) => Promise<SdkClient>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  loadSdk?: () => Promise<unknown>;
}>;

const DEFAULT_MUTATION_TIMEOUT_MS = 75_000;

function lifecycleError(error: unknown, timedOut: boolean): OpenShellSandboxError {
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
  connect: (target: OpenShellGatewayTarget) => Promise<SdkClient>,
): Promise<OpenShellSandboxMutationSubmission> {
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
  try {
    const client = await Promise.race([connect(request.target), aborted]);
    const operation = action === "start" ? client.raw.startSandbox : client.raw.stopSandbox;
    await operation(
      { name: request.sandboxName, workspace: "default" },
      { signal: controller.signal },
    );
    if (action === "start") {
      await client.sandbox.waitReady(
        request.sandboxName,
        Math.max(1, Math.ceil((request.timeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS) / 1000)),
        { signal: controller.signal },
      );
    }
    return { kind: "accepted" };
  } catch (error) {
    return { kind: "failed", error: lifecycleError(error, controller.signal.aborted) };
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
    (async (target) => {
      const { connectManagedOpenShellSdk } = require("./sdk") as typeof import("./sdk");
      return (await connectManagedOpenShellSdk(target, {
        ...(deps.env ? { env: deps.env } : {}),
        ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
        ...(deps.loadSdk
          ? {
              loadSdk: deps.loadSdk as import("./sdk").OpenShellSdkConnectionDeps["loadSdk"],
            }
          : {}),
      })) as SdkClient;
    });
  return {
    startSandbox: (request) => mutate("start", request, connect),
    stopSandbox: (request) => mutate("stop", request, connect),
  };
}
