// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildE2eWorkflowPlan,
  renderE2eWorkflowPlanSummary,
} from "../../../tools/e2e/workflow-plan.mts";

const BOTH_RUNTIMES = { gatewayRuntimes: ["docker", "podman"] as const };

describe("E2E runtime matrix", () => {
  it("expands one managed target across runtimes without duplicating single-run contracts", () => {
    const managed = buildE2eWorkflowPlan({ jobs: "cloud-inference" }, BOTH_RUNTIMES);
    const dockerOnly = buildE2eWorkflowPlan({ jobs: "gateway-guard-recovery" }, BOTH_RUNTIMES);
    const runtimeAgnostic = buildE2eWorkflowPlan({ jobs: "spark-install" }, BOTH_RUNTIMES);
    const managedRows = managed.catalogueMatrices["nvidia-inference"];

    expect(managedRows).toEqual([
      expect.objectContaining({
        id: "cloud-inference",
        execution_id: "cloud-inference-default-docker",
        runtime_provider: "docker",
        coverage_variant: "default-docker",
      }),
      expect.objectContaining({
        id: "cloud-inference",
        execution_id: "cloud-inference-default-podman",
        runtime_provider: "podman",
        coverage_variant: "default-podman",
      }),
    ]);
    expect(dockerOnly.catalogueMatrices["nvidia-inference"]).toEqual([
      expect.objectContaining({ id: "gateway-guard-recovery", runtime_provider: "docker" }),
    ]);
    expect(runtimeAgnostic.catalogueMatrices["nvidia-inference"]).toEqual([
      expect.objectContaining({ id: "spark-install", runtime_provider: "none" }),
    ]);
    expect(managed.coverageMatrix.map((row) => row.variant)).toEqual([
      "default-docker",
      "default-podman",
    ]);
    expect(renderE2eWorkflowPlanSummary(dockerOnly)).toContain(
      "| `gateway-guard-recovery` | podman | docker |",
    );
    expect(renderE2eWorkflowPlanSummary(runtimeAgnostic)).not.toContain(
      "| `spark-install` | podman |",
    );
  });

  it.each([
    "bootstrap-install-smoke",
    "concurrent-gateway-ports",
    "llama-cpp-generic-gpu",
    "rebuild-hermes-stale-base",
  ])("keeps the explicit Docker contract %s out of Podman fanout", (target) => {
    const plan = buildE2eWorkflowPlan({ jobs: target }, BOTH_RUNTIMES);
    const rows = Object.values(plan.catalogueMatrices).flat();

    expect(rows).toEqual([expect.objectContaining({ id: target, runtime_provider: "docker" })]);
    expect(renderE2eWorkflowPlanSummary(plan)).toContain(`| \`${target}\` | podman | docker |`);
  });
});
