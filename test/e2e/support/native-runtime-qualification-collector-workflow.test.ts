// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type CollectorWorkflow = Workflow & {
  readonly on: { readonly workflow_dispatch: { readonly inputs: Record<string, unknown> } };
  readonly permissions: Record<string, string>;
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COLLECTOR_ENTRYPOINT = "tools/e2e/native-runtime-qualification-collector.mts";

function resolveLocalModule(importer: string, specifier: string): string {
  const unresolved = normalize(join(dirname(importer), specifier));
  const candidates =
    extname(unresolved).length > 0
      ? [unresolved]
      : [`${unresolved}.ts`, `${unresolved}.mts`, join(unresolved, "index.ts")];
  const resolved = candidates.find((candidate) => existsSync(join(REPO_ROOT, candidate)));
  expect(resolved, `cannot resolve '${specifier}' imported by '${importer}'`).toBeDefined();
  return resolved!;
}

function localImportClosure(entrypoint: string): string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const modulePath = pending[index]!;
    const imports = visited.has(modulePath)
      ? []
      : [
          ...readRepoText(modulePath).matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/gu),
        ].map((match) => resolveLocalModule(modulePath, match[1]!));
    visited.add(modulePath);
    pending.push(...imports.filter((candidate) => !visited.has(candidate)));
  }
  return [...visited].sort();
}

function workflow(): CollectorWorkflow {
  return readYaml(
    ".github/workflows/native-runtime-qualification-collector.yaml",
  ) as CollectorWorkflow;
}

function collectorJob(): WorkflowJob {
  const job = workflow().jobs["collect-protected-evidence"];
  expect(job).toBeDefined();
  return job!;
}

function namedStep(name: string): WorkflowStep {
  const step = collectorJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing native qualification collector step '${name}'`).toBeDefined();
  return step!;
}

describe("native runtime qualification collector workflow", () => {
  it("is a dispatch-only trusted-main collector with least-privilege permissions", () => {
    const parsed = workflow();
    const job = collectorJob();

    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(parsed.on.workflow_dispatch.inputs).sort()).toEqual([
      "base_sha",
      "evidence_artifact_name",
      "evidence_job_name",
      "evidence_run_id",
      "evidence_workflow",
      "head_sha",
      "pr_number",
      "provider_id",
    ]);
    expect(parsed.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(job.if).toBe(
      "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main'",
    );
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(10);
    expect(
      readRepoText(".github/workflows/native-runtime-qualification-collector.yaml"),
    ).not.toMatch(/\$\{\{\s*secrets\./u);
  });

  it("checks out the exact trusted import closure and never executes candidate code", () => {
    const checkout = namedStep("Check out trusted collector revision");
    const collect = namedStep("Authenticate and consume protected qualification evidence");
    const steps = collectorJob().steps ?? [];
    const tokenSteps = steps.filter((step) =>
      JSON.stringify(step.env ?? {}).includes("${{ github.token }}"),
    );

    expect(checkout.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: "trusted",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    expect(String(checkout.with?.["sparse-checkout"]).trim().split(/\s+/u).sort()).toEqual(
      localImportClosure(COLLECTOR_ENTRYPOINT),
    );
    expect(
      (collect as WorkflowStep & { readonly "working-directory"?: string })["working-directory"],
    ).toBe("trusted");
    expect(collect.run).toContain(
      "node --experimental-strip-types --no-warnings tools/e2e/native-runtime-qualification-collector.mts",
    );
    expect(tokenSteps.map((step) => step.name)).toEqual([
      "Authenticate and consume protected qualification evidence",
    ]);
    expect(JSON.stringify(steps)).not.toContain("github.event.pull_request.head");
    expect(JSON.stringify(steps)).not.toContain("actions/checkout/merge");
  });

  it("binds controller inputs into the executable canonical evidence consumer", () => {
    const collect = namedStep("Authenticate and consume protected qualification evidence");
    const source = readRepoText("tools/e2e/native-runtime-qualification-collector.mts");

    expect(collect.env).toMatchObject({
      GITHUB_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      EXPECTED_PROVIDER_ID: "${{ inputs.provider_id }}",
      EXPECTED_PR_NUMBER: "${{ inputs.pr_number }}",
      EXPECTED_HEAD_SHA: "${{ inputs.head_sha }}",
      EXPECTED_BASE_SHA: "${{ inputs.base_sha }}",
      EVIDENCE_WORKFLOW: "${{ inputs.evidence_workflow }}",
      EVIDENCE_RUN_ID: "${{ inputs.evidence_run_id }}",
      EVIDENCE_JOB_NAME: "${{ inputs.evidence_job_name }}",
      EVIDENCE_ARTIFACT_NAME: "${{ inputs.evidence_artifact_name }}",
    });
    expect(source).not.toMatch(/node:child_process|execFile|spawn\(/u);
  });
});
