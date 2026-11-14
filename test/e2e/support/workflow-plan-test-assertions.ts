// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";
import { requiresManagedImages } from "../../../tools/e2e/workflow-prerequisites.mts";

export function expectedWorkflowPlanCiOutput(
  plan: ReturnType<typeof buildE2eWorkflowPlan>,
): string {
  return [
    `matrix=${JSON.stringify(plan.matrix)}`,
    `test_matrix=${JSON.stringify(plan.testMatrix)}`,
    `catalogue_standard_matrix=${JSON.stringify(plan.catalogueMatrices.standard)}`,
    `catalogue_nvidia_api_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-api"])}`,
    `catalogue_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-inference"])}`,
    `catalogue_hosted_inference_matrix=${JSON.stringify(plan.catalogueMatrices["hosted-inference"])}`,
    `catalogue_github_read_matrix=${JSON.stringify(plan.catalogueMatrices["github-read"])}`,
    `gateway_runtimes=${JSON.stringify(plan.gatewayRuntimes)}`,
    `runtime_providers_by_job=${JSON.stringify(plan.runtimeProvidersByJob)}`,
    `selected_jobs=${JSON.stringify(plan.selectedJobs)}`,
    `selected_workflow_jobs=${JSON.stringify(selectedWorkflowJobs(plan))}`,
    `managed_image_required=${requiresManagedImages(selectedWorkflowJobs(plan))}`,
    `hermes_selected=${plan.hermesSelected}`,
    `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
    `release_required_jobs=${JSON.stringify(releaseRequiredWorkflowJobs())}`,
    "",
  ].join("\n");
}

export const expectedScopePatchExecutionIds = [
  "agent-turn-latency-default-docker",
  "agent-turn-latency-default-podman",
  "full-e2e-default-docker",
  "full-e2e-default-podman",
  "llama-cpp-generic-gpu-default-docker",
  "messaging-compatible-endpoint-default-docker",
  "messaging-compatible-endpoint-default-podman",
  "openclaw-compatible-anthropic-inference-switch-anthropic-docker",
  "openclaw-compatible-anthropic-inference-switch-anthropic-podman",
  "openclaw-inference-switch-default-docker",
  "openclaw-inference-switch-default-podman",
  "openclaw-registered-provider-inference-switch-registered-provider-docker",
  "openclaw-registered-provider-inference-switch-registered-provider-podman",
  "openclaw-skill-cli-default-docker",
  "openclaw-skill-cli-default-podman",
];
