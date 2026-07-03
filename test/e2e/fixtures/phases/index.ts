// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  EnvironmentPhaseFixture,
  type DockerRuntimeExpectation,
  type DockerRuntimeReady,
  type EnvironmentReady,
} from "./environment.ts";
export {
  LifecyclePhaseFixture,
  type LifecycleCleanup,
  type LifecycleProfile,
  type LifecycleResult,
  type PostRebootMode,
  type PostRebootOptions,
} from "./lifecycle.ts";
export {
  OnboardingPhaseFixture,
  type NemoClawInstance,
  type OnboardingExpectedFailure,
  type OnboardingOptions,
  type OnboardingSecrets,
} from "./onboarding.ts";
export {
  inferenceRouteUrl,
  RuntimePhaseFixture,
  type InferenceRoute,
  type InferenceRuntimeChatOptions,
  type InferenceRuntimeProbeResult,
  type InferenceRuntimeRequestOptions,
  type InferenceRuntimeRouteOptions,
  type InferenceRuntimeStatusOptions,
  type ProviderRuntimeRequestOptions,
} from "./runtime.ts";
export {
  StateValidationPhaseFixture,
  type StateValidationProbeResult,
  type StateValidationResult,
} from "./state-validation.ts";
