// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isSafeModelId } from "../../validation";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_LENGTH = 512;
const SAFE_PROVIDER = /^[A-Za-z0-9._:-]+$/u;

export type OpenShellInferenceRoute = Readonly<{
  provider: string;
  model: string;
}>;

export function isValidOpenShellInferenceRoute(route: OpenShellInferenceRoute): boolean {
  return (
    route.provider.length > 0 &&
    route.provider.length <= MAX_PROVIDER_LENGTH &&
    SAFE_PROVIDER.test(route.provider) &&
    route.model.length > 0 &&
    route.model.length <= MAX_MODEL_LENGTH &&
    isSafeModelId(route.model)
  );
}

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
  ): OpenShellInferenceRouteResult | Promise<OpenShellInferenceRouteResult>;
}

/** Observe one gateway inference route through a synchronous transport. */
export interface OpenShellSynchronousInferenceRouteObserver {
  observeInferenceRoute(
    request: ObserveOpenShellInferenceRouteRequest,
  ): OpenShellInferenceRouteResult;
}
