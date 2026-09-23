// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";

export function expectedWorkflowPlanCiOutput(
  plan: ReturnType<typeof buildE2eWorkflowPlan>,
): string {
  return [
    `matrix=${JSON.stringify(plan.matrix)}`,
    `test_matrix=${JSON.stringify(plan.testMatrix)}`,
    `catalogue_standard_matrix=${JSON.stringify(plan.catalogueMatrices.standard)}`,
    `catalogue_nvidia_api_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-api"])}`,
    `catalogue_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["nvidia-inference"])}`,
    `catalogue_github_read_matrix=${JSON.stringify(plan.catalogueMatrices["github-read"])}`,
    `catalogue_brave_nvidia_inference_matrix=${JSON.stringify(plan.catalogueMatrices["brave-nvidia-inference"])}`,
    `gateway_runtimes=${JSON.stringify(plan.gatewayRuntimes)}`,
    `runtime_providers_by_job=${JSON.stringify(plan.runtimeProvidersByJob)}`,
    `selected_jobs=${JSON.stringify(plan.selectedJobs)}`,
    `selected_workflow_jobs=${JSON.stringify(selectedWorkflowJobs(plan))}`,
    `hermes_selected=${plan.hermesSelected}`,
    `explicit_only_jobs=${plan.explicitOnlyJobs.join(",")}`,
    `release_required_jobs=${JSON.stringify(releaseRequiredWorkflowJobs())}`,
    "",
  ].join("\n");
}
