// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

function workflow(): Workflow {
  return readYaml(".github/workflows/e2e.yaml") as Workflow;
}

function job(name: string): WorkflowJob {
  const value = workflow().jobs[name];
  expect(value, `missing workflow job '${name}'`).toBeDefined();
  return value!;
}

function step(owner: WorkflowJob, name: string): WorkflowStep {
  const value = owner.steps?.find((entry) => entry.name === name);
  expect(value, `missing workflow step '${name}'`).toBeDefined();
  return value!;
}

describe("native runtime qualification producer workflow", () => {
  it("keeps candidate execution out of the authenticated controller", () => {
    const generate = job("generate-matrix");
    const checkout = generate.steps?.find((entry) => entry.uses?.startsWith("actions/checkout@"));

    expect(checkout?.if).toContain("inputs.jobs != 'native-runtime-qualification-producer'");
    expect(step(generate, "Validate manual PR checkout").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Authorize E2E credentials").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Prepare E2E workspace").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Package exact-commit CLI").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Generate E2E target matrix").run).toContain(
      'selected_jobs=["native-runtime-qualification-producer"]',
    );
  });

  it("compiles the matrix only from authenticated source and repository-owned runner policy", () => {
    const plan = job("native-runtime-qualification-producer-plan");
    const authenticate = step(plan, "Authenticate the candidate and dispatch artifact");
    const compile = step(plan, "Compile the trusted qualification producer matrix");

    expect(plan.if).toContain("github.ref == 'refs/heads/main'");
    expect(plan.if).toContain("inputs.jobs == 'native-runtime-qualification-producer'");
    expect(plan.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(authenticate.run).toContain('"$CANDIDATE_REPOSITORY" == "NVIDIA/NemoClaw"');
    expect(authenticate.run).toContain('"$BASE_SHA" == "$WORKFLOW_SHA"');
    expect(authenticate.run).toContain(".head.sha == $candidateSha");
    expect(authenticate.run).toContain(".base.sha == $baseSha");
    expect(authenticate.run).toContain(".total_count == 1");
    expect(authenticate.run).toContain(".size_in_bytes <= 1048576");
    expect(authenticate.run).toContain("sha256sum .candidate-source/scripts/install.sh");
    expect(compile.env?.NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL).toBe(
      "${{ vars.NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL }}",
    );
    expect(compile.run).toContain("native-runtime-qualification-producer-plan.mts --ci-output");
    expect(JSON.stringify(plan)).not.toContain("linux-arm64-gpu-dgx-spark-gb10-protected-1");
  });

  it("runs each candidate case in an isolated account and emits one trusted artifact", () => {
    const producer = job("native-runtime-qualification-producer");
    const boundary = step(
      producer,
      "Prepare the credential-free execution account and disable Docker",
    );
    const installer = step(producer, "Run the authenticated installer qualification");
    const execute = step(producer, "Execute the candidate qualification case without credentials");
    const validate = step(producer, "Validate receipts and emit bounded evidence");
    const upload = step(producer, "Upload the qualification case evidence");
    const cleanup = step(producer, "Remove qualification resources");
    const source = JSON.stringify(producer);
    const boundaryRun = boundary.run ?? "";
    const installerRun = installer.run ?? "";

    expect(producer.name).toBe("${{ matrix.jobName }}");
    expect(producer["runs-on"]).toBe("${{ matrix.runner }}");
    expect(producer.permissions).toEqual({ contents: "read" });
    expect(producer.strategy).toMatchObject({ "fail-fast": false });
    expect(source).not.toMatch(/NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|DOCKERHUB_TOKEN/u);
    expect(boundary.run).toContain("mask --runtime docker.service docker.socket");
    expect(boundary.run).toContain("useradd --create-home --shell /usr/sbin/nologin");
    expect(boundaryRun.indexOf("printf 'account=%s")).toBeLessThan(
      boundaryRun.indexOf("useradd --create-home"),
    );
    expect(installer.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(installer.run).toContain("run-native-runtime-installer-qualification.sh");
    expect(installerRun.indexOf("pkill -KILL -u")).toBeLessThan(
      installerRun.indexOf("chown -R -h root:root"),
    );
    expect(installer.run).toContain('[[ -d "$INSTALLER_RECEIPT_PARENT/receipts" && ! -L');
    expect(execute.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(execute.run).toContain("native-runtime-qualification-case.test.ts");
    expect(execute.run).not.toContain("GITHUB_TOKEN");
    expect(execute.run).not.toContain("GH_TOKEN");
    expect(validate.run).toContain("native-runtime-qualification-producer-evidence.mts");
    expect(upload.with).toMatchObject({
      name: "${{ matrix.artifactName }}",
      path: "${{ runner.temp }}/native-runtime-evidence/evidence.json",
    });
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain('account="${ACCOUNT:-nemoclawq}"');
    expect(cleanup.run).toContain("pkill -KILL -u");
    expect(cleanup.run).toContain("userdel --remove");
    expect(cleanup.run).toContain("Qualification account still exists after cleanup");
  });
});
