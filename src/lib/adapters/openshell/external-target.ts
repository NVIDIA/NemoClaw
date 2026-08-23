// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/openshell-external-target-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// wrapper is compiled. The root CLI and direct Blueprint Runner therefore use
// one target contract while the broader typed OpenShell adapter is still being
// established by #9803.
export {
  buildSanitizedExternalOpenShellTargetPlan,
  isExternalOpenShellTarget,
  type ExternalOpenShellAuthentication,
  type ExternalOpenShellTarget,
  type ExternalOpenShellTargetPlanDependencies,
  type OpenShellCompatibilityRange,
  type SanitizedExternalOpenShellTargetPlan,
} from "../../../../nemoclaw/dist/shared/openshell-external-target-boundary.cjs";
