// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { catalogueTarget } from "../../../tools/e2e/target-catalogue.mts";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
  selectedWorkflowJobs,
  validateE2eWorkflowPlan,
  withoutUnavailableOptionalCredentialTargets,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";

vi.setConfig({ maxConcurrency: 4, testTimeout: 35_000 });

describe("web-search E2E workflow planning", () => {
  it.each(["openclaw", "hermes"])(
    "selects the explicit %s Tavily Docker target without requiring it for release (#12138)",
    (agent) => {
      const id = `tavily-export-${agent}`;
      const plan = buildE2eWorkflowPlan({ jobs: id });
      expect(plan.catalogueMatrices["tavily-nvidia-inference"]).toEqual([
        expect.objectContaining({ id, agent_runtime: agent, runtime_provider: "docker" }),
      ]);
      expect(selectedWorkflowJobs(plan)).toEqual(["catalogue-tavily-nvidia-inference"]);
      expect(buildE2eWorkflowPlan().catalogueMatrices["tavily-nvidia-inference"]).toEqual([]);
      expect(releaseRequiredWorkflowJobs()).not.toContain("catalogue-tavily-nvidia-inference");
      expect(() => buildE2eWorkflowPlan({ jobs: id }, { gatewayRuntimes: ["podman"] })).toThrow(
        "does not support requested gateway runtimes",
      );
      expect(catalogueTarget(id)).toMatchObject({
        releaseRequired: false,
        requiredOptionalCredentials: ["TAVILY_API_KEY"],
        selector: `^${agent}.Tavily.export.+$`,
      });
    },
  );

  it.each([
    "src/lib/domain/config/export-document.ts",
    "src/lib/domain/config/v1alpha1-runtime-defaults.ts",
    "src/lib/adapters/config/live-export-source.ts",
    "src/lib/adapters/openshell/sdk-read-schema.ts",
    "test/support/v1-config-consumer.ts",
    "test/e2e/live/brave-search.test.ts",
    "test/e2e/fixtures/tavily-export-source.ts",
    "test/e2e/fixtures/phases/config-export-validation.ts",
    ".github/workflows/e2e.yaml",
  ])("selects both Tavily exporters when %s changes (#12138)", (changedFile) => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [changedFile] });
    expect(plan.catalogueMatrices["tavily-nvidia-inference"].map((row) => row.id)).toEqual([
      "tavily-export-openclaw",
      "tavily-export-hermes",
    ]);
    expect(selectedWorkflowJobs(plan)).toContain("catalogue-tavily-nvidia-inference");
    expect(() => validateE2eWorkflowPlan(plan)).not.toThrow();
    expect(
      withoutUnavailableOptionalCredentialTargets(plan, new Set(["BRAVE_API_KEY"]))
        .catalogueMatrices["tavily-nvidia-inference"],
    ).toEqual([]);
  });

  it.each(["openclaw", "hermes"])(
    "selects only the %s Tavily exporter when its manifest changes (#12138)",
    (agent) => {
      const plan = buildE2eWorkflowPlan(
        {},
        { changedFiles: [`test/e2e/manifests/${agent}-nvidia-tavily.yaml`] },
      );
      expect(plan.catalogueMatrices["tavily-nvidia-inference"].map((row) => row.id)).toEqual([
        `tavily-export-${agent}`,
      ]);
    },
  );

  it("does not select Tavily for unrelated changes or Podman-only planning (#12138)", () => {
    expect(
      buildE2eWorkflowPlan({}, { changedFiles: ["test/e2e/live/snapshot-commands.test.ts"] })
        .catalogueMatrices["tavily-nvidia-inference"],
    ).toEqual([]);
    expect(
      buildE2eWorkflowPlan(
        {},
        {
          changedFiles: ["test/e2e/live/brave-search.test.ts"],
          gatewayRuntimes: ["podman"],
        },
      ).catalogueMatrices["tavily-nvidia-inference"],
    ).toEqual([]);
  });

  it.for([
    ["automatic without a key", {}, "false", 0],
    ["automatic with a key", {}, "true", 2],
    ["explicit without a key", { jobs: "tavily-export-openclaw" }, "false", 1],
  ] as const)(
    "preserves Tavily credential rules for %s selection (#12138)",
    ([_name, selectors, available, count], { onTestFinished }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "tavily-plan-"));
      onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
      const output = path.join(directory, "output");
      writeE2eWorkflowPlanCiOutput(selectors, {
        EVENT_NAME: "push",
        CHANGED_FILES: "test/e2e/live/brave-search.test.ts",
        INFERENCE_MODE: "mock",
        NEMOCLAW_E2E_BRAVE_API_KEY_AVAILABLE: "true",
        NEMOCLAW_E2E_TAVILY_API_KEY_AVAILABLE: available,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
      });
      const matrix = readFileSync(output, "utf8")
        .split("\n")
        .find((line) => line.startsWith("catalogue_tavily_nvidia_inference_matrix="))!;
      expect(JSON.parse(matrix.slice(matrix.indexOf("=") + 1))).toHaveLength(count);
    },
  );

  it("keeps the Brave job from selecting the Tavily cases in its shared test file (#12138)", () => {
    const brave = catalogueTarget("brave-search");
    const selector = new RegExp(brave.selector!);
    expect(selector.test("Brave search exports stable configuration")).toBe(true);
    expect(selector.test("openclaw Tavily export preserves source intent")).toBe(false);
    expect(selector.test("hermes Tavily export preserves source intent")).toBe(false);
  });
});
