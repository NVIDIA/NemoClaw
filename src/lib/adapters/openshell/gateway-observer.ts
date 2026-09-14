// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "./runtime-selection";
import type { OpenShellGatewayTarget, OpenShellSandboxError } from "./sandbox-observer";

export type OpenShellGatewayObservation = Readonly<{
  state:
    | "healthy_named"
    | "named_unreachable"
    | "named_unhealthy"
    | "connected_other"
    | "missing_named"
    | "observation_failed";
  activeGateway: string | null;
  recoveryBlocked: boolean;
  unavailable: boolean;
  diagnostic: string;
  error?: OpenShellSandboxError;
}>;

export type ObserveOpenShellGatewayRequest = Readonly<{
  target: Extract<OpenShellGatewayTarget, { kind: "named" }>;
  runtimeSelection?: OpenShellRuntimeSelection;
  timeoutMs?: number;
}>;

/** Observe the selected gateway and the requested gateway's identity without changing selection. */
export interface OpenShellGatewayObserver {
  observeGateway(request: ObserveOpenShellGatewayRequest): Promise<OpenShellGatewayObservation>;
}
