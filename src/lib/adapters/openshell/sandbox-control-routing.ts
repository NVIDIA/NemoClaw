// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  createGrpcOpenShellSandboxControlForGateway,
  OpenShellGrpcEdgeTunnelRequiredError,
} from "./grpc-gateway-config";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
  type OpenShellSandboxDescriptor,
} from "./grpc-sandbox-control";
import {
  createGatewayScopedCliOpenShellSandboxControl,
  OpenShellExecRequestValidationError,
  type OpenShellSandboxControl,
  openShellExecRequestValidationFailure,
  type SandboxExecRequest,
  type SandboxExecResult,
  validateOpenShellExecRequest,
} from "./sandbox-control";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";

export interface ReadOnlyRoutingDependencies {
  createCli: (gatewayName: string) => OpenShellSandboxControl;
  createGrpc: (gatewayName: string) => GrpcOpenShellSandboxControl;
  debug: (message: string, context: unknown) => void;
}

const defaultDependencies: ReadOnlyRoutingDependencies = {
  createCli: createGatewayScopedCliOpenShellSandboxControl,
  createGrpc: createGrpcOpenShellSandboxControlForGateway,
  debug: (message, context) => log.debug(message, context),
};

export interface OpenShellMutationControlSelection {
  control: OpenShellSandboxControl;
  transport: "grpc" | "cli-edge-tunnel";
  close(): void;
}

function closeGrpc(
  grpc: GrpcOpenShellSandboxControl | undefined,
  dependencies: ReadOnlyRoutingDependencies,
): void {
  try {
    grpc?.close();
  } catch (error) {
    dependencies.debug("OpenShell direct gRPC client close failed", error);
  }
}

export async function getOpenShellSandboxDescriptor(
  gatewayName: string,
  sandboxName: string,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): Promise<OpenShellSandboxDescriptor> {
  assertNoOpenShellGatewayEndpointOverride();
  const grpc = dependencies.createGrpc(gatewayName);
  try {
    return await grpc.getSandboxDescriptor(sandboxName);
  } finally {
    closeGrpc(grpc, dependencies);
  }
}

/**
 * Select one transport before a mutating workflow starts. Direct gRPC is the
 * default. The CLI is selected only for the explicit Cloudflare edge-tunnel
 * mode that a direct client cannot traverse. This function never retries an
 * operation after dispatch.
 */
export function selectOpenShellSandboxControlForMutation(
  gatewayName: string,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): OpenShellMutationControlSelection {
  try {
    const grpc = dependencies.createGrpc(gatewayName);
    return {
      control: grpc,
      transport: "grpc",
      close: () => closeGrpc(grpc, dependencies),
    };
  } catch (error) {
    if (!(error instanceof OpenShellGrpcEdgeTunnelRequiredError)) throw error;
    return {
      control: dependencies.createCli(gatewayName),
      transport: "cli-edge-tunnel",
      close: () => {},
    };
  }
}

/**
 * Prefer direct gRPC for explicitly reviewed read-only probes and retry through
 * the OpenShell CLI only when configuration or sandbox lookup fails before
 * Exec is dispatched. OpenShell v0.0.72 can persist
 * `auth_mode: "cloudflare_jwt"`; only its CLI can establish that
 * OpenShell-owned edge tunnel and manage the associated credential lifecycle,
 * so NemoClaw cannot replace that path here.
 *
 * This migration contract is limited to the reviewed read-only callers (the
 * session list, rebuild file probe, debug diagnostic probes, version probe,
 * and state backup probes, audits, and reads at this slice), not a general
 * routing policy.
 * Remove the CLI fallback when OpenShell's public client or bindings support
 * the edge-tunnel auth and credential-refresh lifecycle. Every added caller
 * requires a replay-semantics review; mutations must select one transport
 * before dispatch and must never be replayed automatically.
 */
export async function execSandboxReadOnlyWithGrpcFallback(
  gatewayName: string,
  request: SandboxExecRequest,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): Promise<SandboxExecResult> {
  const routedRequest = {
    ...request,
    timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
  };
  const validationError = validateOpenShellExecRequest(routedRequest);
  if (validationError) return openShellExecRequestValidationFailure(validationError);

  let grpc: GrpcOpenShellSandboxControl;
  try {
    grpc = dependencies.createGrpc(gatewayName);
  } catch (error) {
    if (error instanceof OpenShellExecRequestValidationError) {
      return openShellExecRequestValidationFailure(error);
    }
    dependencies.debug(
      "OpenShell direct gRPC configuration failed; retrying through the CLI",
      error,
    );
    return dependencies.createCli(gatewayName).exec(routedRequest);
  }

  let preDispatchError: OpenShellGrpcPreDispatchError | undefined;
  try {
    const result = await grpc.exec(routedRequest);
    if (!(result.error instanceof OpenShellGrpcPreDispatchError)) return result;
    preDispatchError = result.error;
  } catch (error) {
    if (error instanceof OpenShellGrpcPreDispatchError) {
      preDispatchError = error;
    } else {
      const cause = error instanceof Error ? error : new Error(String(error));
      return { status: null, stdout: "", stderr: "", error: cause };
    }
  } finally {
    closeGrpc(grpc, dependencies);
  }

  dependencies.debug(
    "OpenShell direct gRPC lookup failed before dispatch; retrying through the CLI",
    preDispatchError.cause,
  );
  return dependencies.createCli(gatewayName).exec(routedRequest);
}
