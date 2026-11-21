// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";

it.each(["jobs", "targets"] as const)("rejects premature Spark dispatch through %s", (selector) => {
  expect(() => buildE2eWorkflowPlan({ [selector]: "spark-vllm-extra-arguments" })).toThrow(
    /Unknown.*spark-vllm-extra-arguments/,
  );
  const plan = buildE2eWorkflowPlan();
  expect(selectedWorkflowJobs(plan)).not.toContain("spark-vllm-extra-arguments");
  expect(plan.explicitOnlyJobs).not.toContain("spark-vllm-extra-arguments");
  expect(releaseRequiredWorkflowJobs()).not.toContain("spark-vllm-extra-arguments");
});
