// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellInferenceRoute = Readonly<{
  provider: string;
  model: string;
}>;

export type OpenShellInferenceRouteObservation =
  | Readonly<{ state: "configured"; route: OpenShellInferenceRoute }>
  | Readonly<{ state: "unconfigured" }>;

export type OpenShellInferenceRouteError =
  | Readonly<{
      kind: "authentication" | "timeout" | "validation";
      message: string;
    }>
  | Readonly<{
      kind: "schema";
      reason: "malformed_output" | "partial_route" | "protocol_mismatch";
      message: string;
    }>
  | Readonly<{
      kind: "transport";
      reason: "identity_mismatch" | "process_start" | "unreachable";
      message: string;
    }>
  | Readonly<{
      kind: "command";
      reason: "failed" | "indeterminate" | "invalid_request";
      message: string;
    }>;

export type OpenShellInferenceRouteResult =
  | Readonly<{ ok: true; value: OpenShellInferenceRouteObservation }>
  | Readonly<{ ok: false; error: OpenShellInferenceRouteError }>;

export type ObserveOpenShellInferenceRouteRequest = Readonly<{
  target: OpenShellGatewayTarget;
  timeoutMs?: number;
}>;

/** Observe one gateway inference route without exposing transport details. */
export interface OpenShellInferenceRouteObserver {
  observeInferenceRoute(
    request: ObserveOpenShellInferenceRouteRequest,
  ): Promise<OpenShellInferenceRouteResult>;
}

/** Observe one gateway inference route through a synchronous transport. */
export interface OpenShellSynchronousInferenceRouteObserver {
  observeInferenceRoute(
    request: ObserveOpenShellInferenceRouteRequest,
  ): OpenShellInferenceRouteResult;
}
