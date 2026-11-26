// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildE2eWorkflowPlan,
  validateE2eWorkflowPlan,
  writeE2eWorkflowPlanCiOutput,
} from "../../../tools/e2e/workflow-plan.mts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { validateHermesGpuStartupWorkflow } from "../../../tools/e2e/hermes-gpu-startup-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type DiagnosticWorkflow = {
  on: { workflow_dispatch: { inputs: Record<string, { default: boolean }> } };
  jobs: Record<
    string,
    {
      strategy: { matrix: Record<string, unknown> };
      outputs: Record<string, string>;
      steps: Array<{ name: string; env: Record<string, string>; run: string }>;
    }
  >;
};

function readDiagnosticWorkflow(): DiagnosticWorkflow {
  return readWorkflow() as unknown as DiagnosticWorkflow;
}

const jobs = "hermes-gpu-startup";

describe("native Hermes GPU diagnostic selection", () => {
  it("retains Docker's three scenarios and Podman's native scenario by default", () => {
    const plan = buildE2eWorkflowPlan({ jobs }, { gatewayRuntimes: ["docker", "podman"] });
    expect(plan.coverageMatrix.map((row) => `${row.id}:${row.variant}`).sort()).toEqual([
      "hermes-gpu-startup:compatibility-only-docker",
      "hermes-gpu-startup:fallback-docker",
      "hermes-gpu-startup:native-docker",
      "hermes-gpu-startup:native-podman",
    ]);
    expect(
      buildE2eWorkflowPlan(
        { jobs, nativeHermesGpuDiagnostic: false },
        {
          gatewayRuntimes: ["docker", "podman"],
        },
      ),
    ).toEqual(plan);
    expect(plan).not.toHaveProperty("nativeHermesGpuDiagnostic");
  });

  it("selects native Docker coverage and rejects forged diagnostic coverage", () => {
    const plan = buildE2eWorkflowPlan({ jobs, nativeHermesGpuDiagnostic: true });
    expect(plan.coverageMatrix.map((row) => `${row.id}:${row.variant}`)).toEqual([
      "hermes-gpu-startup:native-docker",
    ]);
    expect(validateE2eWorkflowPlan(plan)).toEqual(plan);
    expect(() => validateE2eWorkflowPlan({ ...plan, nativeHermesGpuDiagnostic: false })).toThrow();
    expect(() => validateE2eWorkflowPlan({ ...plan, coverageMatrix: [] })).toThrow();
    expect(() =>
      validateE2eWorkflowPlan({ ...buildE2eWorkflowPlan(), nativeHermesGpuDiagnostic: true }),
    ).toThrow();
  });

  it.each([
    {},
    { jobs: "" },
    { jobs: "hermes-e2e" },
    { jobs: "hermes-gpu-startup,hermes-e2e" },
    { jobs, targets: "ubuntu-repo-cloud-openclaw" },
    { targets: jobs },
  ])("rejects diagnostic selectors outside the sole GPU job: %j", (selectors) => {
    expect(() => buildE2eWorkflowPlan({ ...selectors, nativeHermesGpuDiagnostic: true })).toThrow();
  });

  it("rejects a nonboolean diagnostic selector", () => {
    expect(() =>
      buildE2eWorkflowPlan({ jobs, nativeHermesGpuDiagnostic: "true" as unknown as boolean }),
    ).toThrow("must be boolean");
  });

  it.each([false, true])(
    "emits the trusted CI axis with matching coverage when diagnostic=%s",
    (diagnostic) => {
      const directory = mkdtempSync(path.join(tmpdir(), "hermes-gpu-diagnostic-"));
      try {
        const output = path.join(directory, "output");
        writeE2eWorkflowPlanCiOutput(
          { jobs },
          {
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
            INFERENCE_MODE: "mock",
            EVENT_NAME: "workflow_dispatch",
            NEMOCLAW_E2E_NATIVE_HERMES_GPU_DIAGNOSTIC: String(diagnostic),
          },
        );
        const line = readFileSync(output, "utf8")
          .split("\n")
          .find((value) => value.startsWith("hermes_gpu_native_diagnostic_matrix="))!;
        const axis = JSON.parse(line.slice(line.indexOf("=") + 1)) as boolean[];
        expect(axis).toEqual([diagnostic]);
        expect(
          readFileSync(path.join(directory, "summary"), "utf8").includes(
            "**Scope:** Native Hermes GPU diagnostic only. Fallback and compatibility-only remain unqualified.",
          ),
        ).toBe(diagnostic);
        const plan = buildE2eWorkflowPlan({ jobs, nativeHermesGpuDiagnostic: axis[0] });
        expect(plan.coverageMatrix.map((row) => row.variant).sort()).toEqual(
          diagnostic
            ? ["native-docker"]
            : ["compatibility-only-docker", "fallback-docker", "native-docker"],
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["push", "pull_request"])("rejects diagnostic CI input for %s", (EVENT_NAME) => {
    expect(() =>
      writeE2eWorkflowPlanCiOutput(
        { jobs },
        {
          EVENT_NAME,
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_NATIVE_HERMES_GPU_DIAGNOSTIC: "true",
        },
      ),
    ).toThrow("workflow_dispatch");
  });

  it("rejects invalid environment input and selector bypasses in CI", () => {
    expect(() =>
      writeE2eWorkflowPlanCiOutput(
        { jobs },
        {
          INFERENCE_MODE: "mock",
          NEMOCLAW_E2E_NATIVE_HERMES_GPU_DIAGNOSTIC: "1",
        },
      ),
    ).toThrow("must be true or false");
    expect(() =>
      writeE2eWorkflowPlanCiOutput(
        { jobs, nativeHermesGpuDiagnostic: true },
        { INFERENCE_MODE: "mock" },
      ),
    ).toThrow("environment input");
  });

  it.each([
    [
      "forced matrix axis",
      (matrix: Record<string, unknown>) => {
        matrix.native_diagnostic = [true];
      },
    ],
    [
      "missing exclusions",
      (matrix: Record<string, unknown>) => {
        matrix.exclude = [];
      },
    ],
    [
      "reduced default scenarios",
      (matrix: Record<string, unknown>) => {
        matrix.scenario = ["native"];
      },
    ],
  ] as const)("rejects %s", (_label, mutation) => {
    const workflow = readDiagnosticWorkflow();
    mutation(workflow.jobs[jobs].strategy.matrix);
    expect(validateHermesGpuStartupWorkflow(workflow)).toContain(
      "hermes-gpu-startup must expand reviewed GPU scenarios by supported runtime",
    );
  });

  it("rejects an enabled default input and missing planner output binding", () => {
    const workflow = readDiagnosticWorkflow();
    workflow.on.workflow_dispatch.inputs.native_hermes_gpu_diagnostic.default = true;
    delete workflow.jobs["generate-matrix"].outputs.hermes_gpu_native_diagnostic_matrix;
    const errors = validateE2eWorkflow(workflow);
    expect(errors).toContain("native_hermes_gpu_diagnostic must be boolean and default to false");
    expect(errors).toContain(
      "native Hermes GPU diagnostics must use the trusted planner matrix output",
    );
  });
});

it.each([false, true])(
  "records diagnostic=%s in the actual dispatch receipt command",
  (diagnostic) => {
    const directory = mkdtempSync(path.join(tmpdir(), "hermes-gpu-receipt-"));
    try {
      const step = readDiagnosticWorkflow().jobs["generate-matrix"].steps.find(
        (entry: { name?: string }) => entry.name === "Record trusted E2E dispatch receipt",
      );
      const env = Object.fromEntries(Object.keys(step!.env).map((key) => [key, "fixture"]));
      Object.assign(env, {
        PATH: process.env.PATH,
        DISPATCH_RECEIPT_DIR: directory,
        DISPATCH_JOBS: "hermes-gpu-startup",
        DISPATCH_TARGETS: "",
        PR_NUMBER: "12603",
        RUN_ATTEMPT: "1",
        ALLOW_JETSON_DISPATCH: "false",
        ALLOW_DGX_SPARK_RUNNER_QUEUE: "false",
        ALLOW_JETSON_RUNNER_QUEUE: "false",
        INCLUDE_STAGING_BREV_LAUNCHABLE: "false",
        NATIVE_HERMES_GPU_DIAGNOSTIC: String(diagnostic),
      });
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step!.run], {
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(readFileSync(path.join(directory, "dispatch.json"), "utf8"));
      expect(receipt.jobs).toBe("hermes-gpu-startup");
      expect(receipt.emptySelectors).toBe(false);
      expect(Object.hasOwn(receipt, "nativeHermesGpuDiagnostic")).toBe(diagnostic);
      expect(receipt.nativeHermesGpuDiagnostic).toBe(diagnostic ? true : undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
