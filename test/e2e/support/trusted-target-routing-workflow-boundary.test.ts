// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { requireFixture } from "./require-fixture";

type ControllerWorkflow = {
  jobs: Record<
    string,
    { steps: Array<{ env?: Record<string, string>; id?: string; name?: string; run?: string }> }
  >;
};

const EXPECTED_ERROR = "trusted controller matrix must pin typed target runner to ubuntu-latest";
const CONTROLLER_CASE = 'case "${JOBS}:${TARGETS}" in';
const TRUSTED_MAPPING =
  '{"id":"ubuntu-repo-docker-post-reboot-recovery","runner":"ubuntu-latest","label":"ubuntu-repo-docker-post-reboot-recovery"}';

function fixture() {
  const workflow = readWorkflow() as ControllerWorkflow;
  const controllerMatrix = workflow.jobs["generate-matrix"]!.steps.find(
    (step) => step.id === "controller_matrix",
  )!;
  return { controllerMatrix, workflow };
}

describe("trusted E2E target routing boundary (#7824)", () => {
  it("rejects trusted target mappings outside their exact case branch", () => {
    const { controllerMatrix, workflow } = fixture();
    expect(validateE2eWorkflow(workflow)).not.toContain(EXPECTED_ERROR);
    requireFixture(
      controllerMatrix.run?.includes(TRUSTED_MAPPING),
      "trusted target fixture mapping is missing",
    );

    controllerMatrix.run = controllerMatrix
      .run!.replace(TRUSTED_MAPPING, TRUSTED_MAPPING.replace("ubuntu-latest", "self-hosted"))
      .concat(`\n# ${TRUSTED_MAPPING}\n`);

    expect(validateE2eWorkflow(workflow)).toContain(EXPECTED_ERROR);
  });

  it("rejects a dead approved case block before unsafe target routing", () => {
    const { controllerMatrix, workflow } = fixture();
    const run = controllerMatrix.run!;
    const caseStart = run.indexOf(CONTROLLER_CASE);
    const caseEnd = run.indexOf("\nesac", caseStart) + "\nesac".length;
    requireFixture(caseStart >= 0, "trusted target fixture case is missing");
    requireFixture(caseEnd > caseStart, "trusted target fixture case terminator is missing");
    const deadApprovedCase = run.slice(caseStart, caseEnd);
    const unsafeRouting = run.replace(
      TRUSTED_MAPPING,
      TRUSTED_MAPPING.replace("ubuntu-latest", "self-hosted"),
    );
    controllerMatrix.run = `${deadApprovedCase}\n${unsafeRouting}`;

    expect(validateE2eWorkflow(workflow)).toContain(EXPECTED_ERROR);
  });

  it("rejects an executable wildcard before approved target routing", () => {
    const { controllerMatrix, workflow } = fixture();
    const unsafeWildcard = [
      "*)",
      'matrix=\'[{"id":"untrusted","runner":"self-hosted","label":"untrusted"}]\'',
      ";;",
    ].join("\n");
    requireFixture(
      controllerMatrix.run?.includes(CONTROLLER_CASE),
      "trusted target fixture case is missing",
    );

    controllerMatrix.run = controllerMatrix.run!.replace(
      CONTROLLER_CASE,
      `${CONTROLLER_CASE}\n${unsafeWildcard}`,
    );

    expect(validateE2eWorkflow(workflow)).toContain(EXPECTED_ERROR);
  });

  it("rejects a matrix override after approved target routing", () => {
    const { controllerMatrix, workflow } = fixture();
    expect(validateE2eWorkflow(workflow)).not.toContain(EXPECTED_ERROR);
    const output = `printf 'matrix=%s\\n' "\${matrix}" >> "\${GITHUB_OUTPUT}"`;
    requireFixture(
      controllerMatrix.run?.includes(output),
      "trusted target fixture output is missing",
    );
    const unsafeOverride =
      'matrix=\'[{"id":"untrusted","runner":"self-hosted","label":"untrusted"}]\'';
    controllerMatrix.run = controllerMatrix.run!.replace(output, `${unsafeOverride}\n${output}`);

    expect(validateE2eWorkflow(workflow)).toContain(EXPECTED_ERROR);
  });

  it("rejects an inference credential exposed to an unauthorized PR candidate", () => {
    const { workflow } = fixture();
    const run = workflow.jobs.live!.steps.find((step) => step.name === "Run live E2E tests")!;
    const validationError =
      "live E2E step must guard NVIDIA_INFERENCE_API_KEY behind a trusted main run or an authorized NVIDIA-owned PR dispatch";

    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);
    run.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });
});
