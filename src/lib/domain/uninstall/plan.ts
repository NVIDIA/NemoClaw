// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_GATEWAY_NAME,
  gatewayVolumeCandidates,
  NEMOCLAW_OLLAMA_MODELS,
  NEMOCLAW_PROVIDERS,
  type UninstallPaths,
  uninstallStatePaths,
} from "./paths";
import type { ShimClassification } from "./shims";

export interface UninstallPlanOptions {
  deleteModels: boolean;
  gatewayName?: string;
  keepOpenShell: boolean;
  shim?: ShimClassification;
}

export type UninstallPlanAction =
  | { kind: "delete-docker-volume"; name: string }
  | { kind: "delete-managed-swap" }
  | { kind: "delete-ollama-model"; name: string }
  | { kind: "delete-related-docker-containers" }
  | { kind: "delete-related-docker-images" }
  | { kind: "delete-openshell-binary"; path: string }
  | { kind: "delete-openshell-provider"; name: string }
  | { kind: "delete-path"; path: string }
  | { kind: "delete-runtime-glob"; pattern: string }
  | { kind: "delete-shim"; reason: string }
  | { kind: "destroy-openshell-gateway"; name: string }
  | { kind: "preserve-ollama-models"; names: string[] }
  | { kind: "preserve-openshell-binary"; paths: string[] }
  | { kind: "preserve-shim"; reason: string }
  | { kind: "stop-helper-services" }
  | { kind: "stop-ollama-auth-proxy" }
  | { kind: "stop-openshell-forward-processes" }
  | { kind: "stop-orphaned-openshell-processes" }
  | { kind: "uninstall-npm-package"; name: "nemoclaw" };

export interface UninstallPlanStep {
  actions: UninstallPlanAction[];
  name: string;
}

export interface UninstallPlan {
  gatewayName: string;
  steps: UninstallPlanStep[];
}

function cliActions(shim?: ShimClassification): UninstallPlanAction[] {
  const actions: UninstallPlanAction[] = [{ kind: "uninstall-npm-package", name: "nemoclaw" }];
  if (!shim) return actions;
  actions.push(shim.remove ? { kind: "delete-shim", reason: shim.reason } : { kind: "preserve-shim", reason: shim.reason });
  return actions;
}

export function buildUninstallPlan(paths: UninstallPaths, options: UninstallPlanOptions): UninstallPlan {
  const gatewayName = options.gatewayName || DEFAULT_GATEWAY_NAME;
  return {
    gatewayName,
    steps: [
      {
        name: "Stopping services",
        actions: [
          { kind: "stop-helper-services" },
          { kind: "delete-runtime-glob", pattern: paths.helperServiceGlob },
          { kind: "stop-openshell-forward-processes" },
          { kind: "stop-orphaned-openshell-processes" },
          { kind: "stop-ollama-auth-proxy" },
        ],
      },
      {
        name: "OpenShell resources",
        actions: [
          ...NEMOCLAW_PROVIDERS.map((name) => ({ kind: "delete-openshell-provider" as const, name })),
          { kind: "destroy-openshell-gateway", name: gatewayName },
        ],
      },
      {
        name: "NemoClaw CLI",
        actions: cliActions(options.shim),
      },
      {
        name: "Docker resources",
        actions: [
          { kind: "delete-related-docker-containers" },
          { kind: "delete-related-docker-images" },
          ...gatewayVolumeCandidates(gatewayName).map((name) => ({ kind: "delete-docker-volume" as const, name })),
        ],
      },
      {
        name: "Ollama models",
        actions: options.deleteModels
          ? NEMOCLAW_OLLAMA_MODELS.map((name) => ({ kind: "delete-ollama-model" as const, name }))
          : [{ kind: "preserve-ollama-models", names: [...NEMOCLAW_OLLAMA_MODELS] }],
      },
      {
        name: "State and binaries",
        actions: [
          { kind: "delete-managed-swap" },
          ...paths.runtimeTempGlobs.map((pattern) => ({ kind: "delete-runtime-glob" as const, pattern })),
          ...(options.keepOpenShell
            ? [{ kind: "preserve-openshell-binary" as const, paths: paths.openshellInstallPaths }]
            : paths.openshellInstallPaths.map((path) => ({ kind: "delete-openshell-binary" as const, path }))),
          ...uninstallStatePaths(paths).map((path) => ({ kind: "delete-path" as const, path })),
        ],
      },
    ],
  };
}

export function flattenUninstallPlan(plan: UninstallPlan): UninstallPlanAction[] {
  return plan.steps.flatMap((step) => step.actions);
}
