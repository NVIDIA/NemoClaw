// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  HOSTED_PROVIDER_SMOKE_CASES,
  hostedProviderSmokeEnvironment,
} from "../../../tools/e2e/hosted-provider-smoke.mts";
import {
  catalogueTarget,
  E2E_TARGET_CATALOGUE,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";

const workflow = YAML.parse(readFileSync(".github/workflows/e2e.yaml", "utf8"));

describe.each(HOSTED_PROVIDER_SMOKE_CASES)("$label qualification selection", (selected) => {
  const id = `hosted-inference-${selected.selector}`;
  it("selects only the named provider in the existing smoke owner", () => {
    const target = catalogueTarget(id);
    expect(target.testFile).toBe("test/e2e/live/inference-routing-provider-smoke.test.ts");
    expect(
      new RegExp(target.selector!).test(
        `${selected.id} ${selected.label} answers through its native provider`,
      ),
    ).toBe(true);
    expect(new RegExp(target.selector!).test("TC-INF-05 real NVIDIA key is isolated")).toBe(false);
    expect(
      buildE2eWorkflowPlan({ targets: id }).catalogueMatrices["hosted-inference"].map(
        (row) => row.id,
      ),
    ).toEqual([id]);
  });
  it("passes only its approved key and model and refuses missing prerequisites", () => {
    expect(
      hostedProviderSmokeEnvironment(id, {
        HOSTED_INFERENCE_API_KEY: "selected-canary",
        HOSTED_INFERENCE_MODEL: "approved-model",
        NVIDIA_API_KEY: "other-canary",
      }),
    ).toEqual({ [selected.credential]: "selected-canary", [selected.modelEnv]: "approved-model" });
    expect(() =>
      hostedProviderSmokeEnvironment(id, { HOSTED_INFERENCE_MODEL: "approved-model" }),
    ).toThrow("requires");
    expect(() =>
      hostedProviderSmokeEnvironment(id, { HOSTED_INFERENCE_API_KEY: "selected-canary" }),
    ).toThrow("requires");
  });
});

it("never automatically spends hosted-provider quota on changed files or the default suite", () => {
  expect(
    catalogueTargetsForChangedFiles(["tools/e2e/target-catalogue.mts"]).filter(
      (target) => target.profile === "hosted-inference",
    ),
  ).toEqual([]);
  expect(buildE2eWorkflowPlan().catalogueMatrices["hosted-inference"]).toEqual([]);
});

it("retains the trusted controller credential and artifact boundary", () => {
  expect(validateStandardProfileWorkflowBoundary(workflow)).toEqual([]);
});

it("selects automatic catalogue targets when their shared installer changes", () => {
  expect(catalogueTargetsForChangedFiles(["scripts/install-openshell.sh"])).toEqual(
    E2E_TARGET_CATALOGUE.filter((target) => target.profile !== "hosted-inference"),
  );
});
