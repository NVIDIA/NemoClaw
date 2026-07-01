// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compatibility facade for rebuild target preflight. The implementation is
 * separated by concern so config resolution, runtime validation, and mutable
 * staging remain independently reviewable.
 */
export { printRebuildPreflightFailure } from "./rebuild-preflight-error";
export {
  prepareRebuildTargetConfig,
  type RebuildTargetConfig,
} from "./rebuild-target-config";
export {
  preflightAuthoritativeOnboardRuntime,
  preflightRebuildTargetRuntime,
} from "./rebuild-target-runtime";
export {
  hydrateMessagingConfigForRebuild,
  prepareRebuildRecreateOptions,
  stageRebuildHermesDashboardConfig,
} from "./rebuild-target-staging";
