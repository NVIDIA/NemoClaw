// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ObserveOpenShellGatewayRequest } from "./gateway-observer";
import type { OpenShellSandboxError } from "./sandbox-observer";

export type OpenShellGatewayMutationResult =
  | Readonly<{ ok: true; state: "completed" | "absent" }>
  | Readonly<{
      ok: false;
      error: OpenShellSandboxError;
      unsupported: boolean;
      ambiguous: boolean;
    }>;

export type OpenShellGatewayRegistryResult =
  | Readonly<{ ok: true; names: readonly string[] }>
  | Readonly<{ ok: false; error: OpenShellSandboxError }>;

/** Gateway registry mutations never retry. Ownership policy stays with the caller. */
export interface OpenShellGatewayLifecycle {
  supportsLegacyLifecycle(request: ObserveOpenShellGatewayRequest): Promise<boolean>;
  selectGateway(request: ObserveOpenShellGatewayRequest): Promise<OpenShellGatewayMutationResult>;
  registerGateway(
    request: ObserveOpenShellGatewayRequest & Readonly<{ endpoint: string }>,
  ): Promise<OpenShellGatewayMutationResult>;
  removeGateway(request: ObserveOpenShellGatewayRequest): Promise<OpenShellGatewayMutationResult>;
  destroyGateway(request: ObserveOpenShellGatewayRequest): Promise<OpenShellGatewayMutationResult>;
  listGateways(request: ObserveOpenShellGatewayRequest): Promise<OpenShellGatewayRegistryResult>;
}
