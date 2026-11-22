// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";

const target = "spark-vllm-extra-arguments";

it.each(["jobs", "targets"] as const)(
  "selects only the physical Spark scenario through %s",
  (selector) => {
    const plan = buildE2eWorkflowPlan({ [selector]: target });
    expect(selectedWorkflowJobs(plan)).toEqual([target]);
    expect(plan.explicitOnlyJobs).toContain(target);
    expect(selectedWorkflowJobs(buildE2eWorkflowPlan())).not.toContain(target);
    expect(releaseRequiredWorkflowJobs()).not.toContain(target);
  },
);

it.each([
  { jobs: `${target},cloud-onboard` },
  { targets: `${target},dgx-station-express` },
  { jobs: target, targets: target },
  { jobs: `${target},${target}` },
])("rejects mixed or repeated Spark dispatch %j", (selectors) => {
  expect(() => buildE2eWorkflowPlan(selectors)).toThrow(/must be selected by itself|Duplicate/);
});
