// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

describe("hosted inference workflow env", () => {
  it("uses the shared export action instead of duplicated run-step hosted env", () => {
    const jobs = (readWorkflow().jobs ?? {}) as Record<
      string,
      { steps?: Array<Record<string, unknown>> }
    >;
    const hostedKeys =
      /^(NVIDIA_INFERENCE_API_KEY|COMPATIBLE_API_KEY|NEMOCLAW_(E2E_USE_HOSTED_INFERENCE|PROVIDER|ENDPOINT_URL|MODEL|COMPAT_MODEL|PREFERRED_API))$/u;
    const steps = Object.entries(jobs).flatMap(([jobName, job]) =>
      (job.steps ?? []).map((step) => ({ jobName, step })),
    );

    expect(
      steps.filter(({ step }) => step.uses === "./.github/actions/export-e2e-hosted-inference")
        .length,
    ).toBeGreaterThan(0);
    for (const { jobName, step } of steps.filter(({ step }) =>
      String(step.run).includes("npx vitest run"),
    )) {
      expect(
        Object.keys((step.env ?? {}) as Record<string, unknown>).filter((key) =>
          hostedKeys.test(key),
        ),
        `${jobName} ${String(step.name)}`,
      ).toEqual([]);
    }
  });
});
