// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ObserveOpenShellGatewayRequest } from "./gateway-observer";
import type { OpenShellSandboxError } from "./sandbox-observer";
import type { GatewayReuseState } from "../../domain/gateway-reuse";

export type OpenShellGatewayReuseObservation = Readonly<{
  gatewayReuseState: GatewayReuseState;
  healthy: boolean;
  namedMetadata: boolean;
  shouldSelect: boolean;
  endpoints: readonly (string | null)[];
  endpointBinding: "match" | "mismatch" | "unknown";
  error?: OpenShellSandboxError;
}>;

export interface OpenShellGatewayReuseObserver {
  observeGatewayReuse(
    request: ObserveOpenShellGatewayRequest & { expectedGatewayPort?: number },
  ): Promise<OpenShellGatewayReuseObservation>;
}
