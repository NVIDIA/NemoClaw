// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { installManagedLlamaCpp } from "../../inference/llama-cpp/managed-installer";
import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import { createLocalModelProfileOnboarder, type LocalModelProfileOnboarderDeps } from "./onboarder";
import { resolveLocalModelProfilePlan } from "./plan";

export type { LocalModelProfileHostState } from "./onboarder";
export type { LocalModelProfilePlan } from "./plan";

type IntegrationDeps = Omit<LocalModelProfileOnboarderDeps, "installLlamaCpp">;

/** Wire the catalog resolver and the one dedicated local-model onboarder. */
export function createLocalModelProfileIntegration(deps: IntegrationDeps) {
  return {
    resolvePlan: () => resolveLocalModelProfilePlan(loadServingCatalog()),
    onboard: createLocalModelProfileOnboarder({
      ...deps,
      installLlamaCpp: installManagedLlamaCpp,
    }),
  };
}
