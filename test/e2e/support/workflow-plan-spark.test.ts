// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  renderE2eWorkflowPlanSummary,
  selectedWorkflowJobs,
  validateE2eWorkflowPlan,
} from "../../../tools/e2e/workflow-plan.mts";

it("keeps Spark qualification explicit and records its own hardware coverage", () => {
  const plan = buildE2eWorkflowPlan({ jobs: "spark-vllm-extra-arguments" });
  expect(validateE2eWorkflowPlan(plan)).toEqual(plan);
  expect(selectedWorkflowJobs(plan)).toEqual(["spark-vllm-extra-arguments"]);
  expect(Object.values(plan.catalogueMatrices).flat()).toEqual([]);
  expect(plan.explicitOnlyJobs).toContain("spark-vllm-extra-arguments");
  expect(releaseRequiredWorkflowJobs()).not.toContain("spark-vllm-extra-arguments");
  expect(renderE2eWorkflowPlanSummary(plan)).toContain("spark-vllm-extra-arguments");
});
