// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Inference provider setup modules.
//
// `setupInference` in `src/lib/onboard.ts` is the orchestrator: it owns the
// step banner, the shared verify + registry-update finalization, and the
// "unsupported provider" error path. Each provider-specific branch lives in
// its own module here so the flows can be read, reviewed, and tested in
// isolation. See issue #767 for the broader provider extraction plan.

export { setupHermesProviderInference } from "./hermes";
export { setupOllamaLocalInference } from "./ollama-local";
export { setupRemoteProviderInference } from "./remote";
export { setupRoutedInference } from "./routed";
export { setupVllmLocalInference } from "./vllm-local";
export {
  isRemoteProviderName,
  REMOTE_PROVIDER_NAMES,
} from "./types";
export type {
  CommonDeps,
  HermesDeps,
  OllamaDeps,
  RemoteProviderDeps,
  RemoteProviderName,
  RoutedDeps,
  SetupInferenceResult,
  VllmDeps,
} from "./types";
