// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import { createGrpcOpenShellSandboxControlForGateway } from "./grpc-gateway-config";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";
import {
  createGatewayScopedCliOpenShellSandboxControl,
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  type SandboxExecResult,
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

/**
 * Prefer direct gRPC for a read-only sandbox exec and retry through the
 * gateway-scoped OpenShell CLI only when client configuration or sandbox
 * lookup fails before dispatch. A rejected execution has an unknown outcome
 * and must not be replayed automatically.
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

  let grpc: GrpcOpenShellSandboxControl;
  try {
    grpc = dependencies.createGrpc(gatewayName);
  } catch (error) {
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
    try {
      grpc.close();
    } catch (error) {
      dependencies.debug("OpenShell direct gRPC client close failed", error);
    }
  }

  dependencies.debug(
    "OpenShell direct gRPC lookup failed before dispatch; retrying through the CLI",
    preDispatchError.cause,
  );
  return dependencies.createCli(gatewayName).exec(routedRequest);
}
