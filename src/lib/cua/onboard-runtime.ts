// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveLiveInferenceGatewayName as resolveSandboxGatewayName } from "../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import type { CuaBuildIdentity } from "./build-identity";
import type { CuaRuntimeReadiness } from "./contract";
import { isCuaQualificationEnabled } from "./feature";
import {
  type CuaLiveInferenceObservation,
  observeCuaLiveAppliedPolicy,
  observeCuaLiveInference,
} from "./lifecycle-readiness";
import { requireCurrentCuaRuntimeReadiness } from "./runtime-readiness";

/**
 * CUA runtime dependencies used while onboarding an agent sandbox.
 *
 * Keeping this boundary explicit lets the generic agent onboarding flow
 * depend on one CUA surface instead of coupling it to each lifecycle module.
 */
export {
  type CuaBuildIdentity,
  type CuaLiveInferenceObservation,
  type CuaRuntimeReadiness,
  isCuaQualificationEnabled,
  observeCuaLiveInference,
  observeCuaLiveAppliedPolicy,
  requireCurrentCuaRuntimeReadiness,
  resolveSandboxGatewayName,
  withGatewayRouteMutationLock,
};
