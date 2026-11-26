// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";

const target = "spark-vllm-extra-arguments";

it.each([
  ["jobs", target],
  ["targets", target],
  ["jobs", "spark-vllm-receipt"],
  ["targets", "spark-vllm-receipt"],
])("rejects %s selector %s for hosted qualification", (selector, id) => {
  expect(() => buildE2eWorkflowPlan({ [selector]: id })).toThrow();
});

it.each([target, "spark-vllm-receipt"])("does not publish %s by default or for release", (id) => {
  expect(selectedWorkflowJobs(buildE2eWorkflowPlan())).not.toContain(id);
  expect(releaseRequiredWorkflowJobs()).not.toContain(id);
});
