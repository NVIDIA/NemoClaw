// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { log } from "../../cli/logger";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "./timeouts";
import {
  createGrpcOpenShellSandboxControlForGateway,
  OpenShellGrpcEdgeTunnelRequiredError,
} from "./grpc-gateway-config";
import {
  createCliOpenShellSandboxControl,
  type OpenShellSandboxControl,
  type SandboxExecRequest,
  type SandboxExecResult,
} from "./sandbox-control";
import {
  type GrpcOpenShellSandboxControl,
  OpenShellGrpcOutputLimitError,
  OpenShellGrpcPreDispatchError,
} from "./grpc-sandbox-control";

export interface ReadOnlyRoutingDependencies {
  cli: OpenShellSandboxControl;
  createGrpc: (gatewayName: string) => GrpcOpenShellSandboxControl;
  debug: (message: string, context: unknown) => void;
}

const defaultDependencies: ReadOnlyRoutingDependencies = {
  cli: createCliOpenShellSandboxControl(),
  createGrpc: createGrpcOpenShellSandboxControlForGateway,
  debug: (message, context) => log.debug(message, context),
};

export interface OpenShellMutationControlSelection {
  control: OpenShellSandboxControl;
  transport: "grpc" | "cli-edge-tunnel";
  close(): void;
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
      close: () => {
        try {
          grpc.close();
        } catch (error) {
          dependencies.debug("OpenShell direct gRPC client close failed", error);
        }
      },
    };
  } catch (error) {
    if (!(error instanceof OpenShellGrpcEdgeTunnelRequiredError)) throw error;
    return {
      control: dependencies.cli,
      transport: "cli-edge-tunnel",
      close: () => {},
    };
  }
}

/**
 * Prefer direct gRPC for a read-only sandbox exec and retry through the
 * OpenShell CLI when gateway resolution or transport fails. This retry policy
 * is intentionally restricted to read-only commands: a failed mutation may
 * have committed remotely and must never be replayed automatically.
 */
export async function execSandboxReadOnlyWithGrpcFallback(
  gatewayName: string,
  request: SandboxExecRequest,
  dependencies: ReadOnlyRoutingDependencies = defaultDependencies,
): Promise<SandboxExecResult> {
  let grpc: GrpcOpenShellSandboxControl | undefined;
  try {
    grpc = dependencies.createGrpc(gatewayName);
    const result = await grpc.exec({
      ...request,
      timeoutMs: request.timeoutMs ?? OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    if (!result.error || result.error instanceof OpenShellGrpcOutputLimitError) return result;
    const context =
      result.error instanceof OpenShellGrpcPreDispatchError ? result.error.cause : result.error;
    dependencies.debug(
      result.error instanceof OpenShellGrpcPreDispatchError
        ? "OpenShell direct gRPC lookup failed before dispatch; retrying through the CLI"
        : "OpenShell direct gRPC read-only exec failed; retrying through the CLI",
      context,
    );
  } catch (error) {
    dependencies.debug(
      "OpenShell direct gRPC configuration failed; retrying through the CLI",
      error,
    );
  } finally {
    try {
      grpc?.close();
    } catch (error) {
      dependencies.debug("OpenShell direct gRPC client close failed", error);
    }
  }
  return dependencies.cli.exec(request);
}
