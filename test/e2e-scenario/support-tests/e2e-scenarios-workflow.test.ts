// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function generateMatrixForDispatch(env: {
  JOBS: string;
  SCENARIOS: string;
}): Record<string, string> {
  const workflow = readWorkflow();
  const jobs = workflow.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>;
  const generateStep = jobs["generate-matrix"]?.steps?.find(
    (step) => step.name === "Generate Vitest scenario matrix",
  );
  expect(generateStep?.run).toEqual(expect.any(String));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-matrix-"));
  const outputPath = path.join(tmp, "github-output");
  const summaryPath = path.join(tmp, "github-summary");
  try {
    const result = spawnSync("bash", ["-c", generateStep?.run as string], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        JOBS: env.JOBS,
        SCENARIOS: env.SCENARIOS,
      },
    });
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return Object.fromEntries(
      fs
        .readFileSync(outputPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("e2e-vitest-scenarios workflow boundary", () => {
  it("keeps the live Vitest scenario workflow manual, pinned, and artifact-safe", () => {
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
  });

  it("evaluates high-risk dispatch selector behavior before secret-bearing jobs run", () => {
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "network-policy,../escape" }),
    ).toMatchObject({
      valid: false,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        jobs: "network-policy-vitest",
        scenarios: "network-policy",
      }),
    ).toMatchObject({
      valid: false,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "network-policy" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["network-policy-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        scenarios: "network-policy,ubuntu-repo-cloud-openclaw",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: true,
      selectedFreeStandingJobs: ["network-policy-vitest"],
      registryScenarios: ["ubuntu-repo-cloud-openclaw"],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "openshell-version-pin" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["openshell-version-pin-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "runtime-overrides-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["runtime-overrides-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "runtime-overrides" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["runtime-overrides-vitest"],
      registryScenarios: [],
    });
    expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "hermes-e2e" })).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["hermes-e2e-vitest"],
      registryScenarios: [],
    });
  });

  it("keeps jobs-only dispatches from selecting the Hermes secret-bearing job", () => {
    expect(
      generateMatrixForDispatch({ JOBS: "openshell-version-pin-vitest", SCENARIOS: "" }),
    ).toMatchObject({
      hermes_selected: "false",
      matrix: "[]",
    });
    expect(generateMatrixForDispatch({ JOBS: "hermes-e2e-vitest", SCENARIOS: "" })).toMatchObject({
      hermes_selected: "true",
      matrix: "[]",
    });
    expect(
      generateMatrixForDispatch({ JOBS: "network-policy-vitest", SCENARIOS: "" }),
    ).toMatchObject({
      hermes_selected: "false",
      matrix: "[]",
    });
    expect(
      generateMatrixForDispatch({ JOBS: "runtime-overrides-vitest", SCENARIOS: "" }),
    ).toMatchObject({
      hermes_selected: "false",
      matrix: "[]",
    });
    expect(generateMatrixForDispatch({ JOBS: "", SCENARIOS: "runtime-overrides" })).toMatchObject({
      hermes_selected: "false",
      matrix: "[]",
    });
    expect(generateMatrixForDispatch({ JOBS: "", SCENARIOS: "hermes-e2e" })).toMatchObject({
      hermes_selected: "true",
      matrix: "[]",
    });
  });

  it("flags direct dispatch-input interpolation and unsafe artifact upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    fs.writeFileSync(
      workflowPath,
      `
"on":
  workflow_dispatch:
    inputs:
      test_filter:
        required: false
permissions:
  contents: read
jobs:
  validate-jobs:
    runs-on: macos-latest
    steps:
      - name: Validate free-standing job selector
        env:
          JOBS: bad
        run: |
          echo "::error::Invalid jobs input: \${JOBS}"
  report-to-pr:
    runs-on: ubuntu-latest
    needs: [generate-matrix]
    steps:
      - name: Post Vitest scenario results to PR
        env:
          JOBS: bad
        run: echo "\${{ inputs.pr_number }} \${{ inputs.scenarios }}"
  live-scenarios:
    runs-on: ubuntu-latest
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/vitest
      NEMOCLAW_RUN_E2E_SCENARIOS: "1"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      - name: Run Vitest live E2E scenarios
        env:
          TEST_FILTER: \${{ inputs.test_filter }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Summarize artifacts
        run: echo "\${{ github.event.inputs['test_filter'] }}"
      - name: Upload Vitest E2E artifacts
        uses: actions/upload-artifact@v4
        with:
          name: e2e-vitest-scenarios
          path: .e2e/vitest/
          include-hidden-files: true
          if-no-files-found: ignore
  openshell-version-pin-vitest:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.scenarios != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/openshell-version-pin
      NEMOCLAW_RUN_E2E_SCENARIOS: "0"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Run OpenShell version-pin live test
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Upload OpenShell version-pin artifacts
        uses: actions/upload-artifact@v4
        with:
          name: openshell-version-pin
          path: .e2e/openshell-version-pin/
          include-hidden-files: true
          if-no-files-found: error
  onboard-negative-paths-vitest:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.scenarios != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/onboard-negative-paths
      NEMOCLAW_RUN_E2E_SCENARIOS: "0"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Run onboard negative-paths live test
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Upload onboard negative-paths artifacts
        uses: actions/upload-artifact@v4
        with:
          name: onboard-negative-paths
          path: .e2e/onboard-negative-paths/
          include-hidden-files: true
          if-no-files-found: error
  network-policy-vitest:
    runs-on: macos-latest
    needs: generate-matrix
    if: \${{ inputs.scenarios != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/network-policy
      NEMOCLAW_CLI_BIN: bin/not-nemoclaw.js
      NEMOCLAW_RUN_E2E_SCENARIOS: "0"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      DOCKERHUB_USERNAME: \${{ secrets.DOCKERHUB_USERNAME }}
      DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
      GITHUB_TOKEN: \${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Authenticate to Docker Hub
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: echo "\${{ inputs.jobs }}"
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Build CLI
        run: echo skip
      - name: Install OpenShell
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: echo install
      - name: Run network-policy live test
        env:
          NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Upload network-policy artifacts
        uses: actions/upload-artifact@v4
        with:
          name: network-policy
          path: .e2e/network-policy/
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1
`,
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow_dispatch missing input: scenarios",
          "workflow_dispatch missing input: jobs",
          "workflow_dispatch must not expose legacy test_filter input",
          "validate-jobs job must run on ubuntu-latest",
          "validate-jobs step must pass jobs through JOBS env",
          "validate-jobs step must pass scenarios through SCENARIOS env",
          "step 'Validate free-standing job selector' run script must include Use either scenarios or jobs, not both",
          "step 'Validate free-standing job selector' run script must include Invalid scenario input; use comma-separated scenario ids",
          "step 'Validate free-standing job selector' run script must include allowed_jobs=",
          "step 'Validate free-standing job selector' run script must include runtime-overrides-vitest",
          "step 'Validate free-standing job selector' run script must include hermes-e2e-vitest",
          "step 'Validate free-standing job selector' run script must include Invalid jobs input; use comma-separated job ids",
          "step 'Validate free-standing job selector' run script must not include Invalid jobs input: ${JOBS}",
          "step 'Validate free-standing job selector' run script must include Unknown free-standing Vitest job",
          "workflow missing generate-matrix job",
          "generate-matrix job must expose hermes_selected output",
          "generate-matrix job must run on ubuntu-latest",
          "live-scenarios job must run on the matrix runner",
          "live-scenarios job must depend on generate-matrix",
          "live-scenarios job must not run when a free-standing jobs selector is supplied",
          "live-scenarios strategy.fail-fast must be false",
          "live-scenarios matrix.include must come from generate-matrix output",
          "live-scenarios job must write artifacts under e2e-artifacts/vitest",
          "live-scenarios job must point NEMOCLAW_CLI_BIN at the repo CLI",
          "live-scenarios job env must not include NVIDIA_API_KEY",
          "checkout action must be pinned to a full commit SHA",
          "checkout step must set persist-credentials=false",
          "step 'Set up Node' env must not include NVIDIA_API_KEY",
          "setup-node action must be pinned to a full commit SHA",
          "run-scenario job missing step: Build CLI",
          "Vitest step must pass matrix.id through SCENARIO_ID env",
          "Vitest step must receive NVIDIA_API_KEY from secrets",
          "step 'Run Vitest live E2E scenarios' run script must not interpolate dispatch inputs directly",
          "step 'Run Vitest live E2E scenarios' run script must include test/e2e-scenario/live/registry-scenarios.test.ts",
          "step 'Run Vitest live E2E scenarios' run script must include \"^${SCENARIO_ID}$\"",
          "step 'Summarize artifacts' run script must not interpolate dispatch inputs directly",
          "summary step must pass matrix.id through SCENARIO_ID env",
          "summary step must pass matrix.label through SCENARIO_LABEL env",
          "step 'Summarize artifacts' run script must include run-plan.json",
          'step \'Summarize artifacts\' run script must include Path(os.environ["E2E_ARTIFACT_DIR"]) / os.environ["SCENARIO_ID"]',
          "step 'Summarize artifacts' run script must include | Scenario | Manifest | Expected state | Suites | Phases |",
          "artifact upload must set include-hidden-files: false",
          "artifact upload name must include matrix.id",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/run-plan.json",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/scenario.json",
          "artifact upload path must include e2e-artifacts/vitest/${{ matrix.id }}/shell/",
          "artifact upload retention-days must be 14",
          "upload-artifact action must be pinned to a full commit SHA",
          "openshell-version-pin-vitest job must depend on validate-jobs and generate-matrix",
          "openshell-version-pin-vitest job must use the shared jobs selector condition",
          "openshell-version-pin-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
          "openshell-version-pin-vitest job must write artifacts under e2e-artifacts/vitest/openshell-version-pin",
          "openshell-version-pin-vitest job env must not include NVIDIA_API_KEY",
          "openshell-version-pin-vitest checkout action must be pinned to a full commit SHA",
          "openshell-version-pin-vitest checkout step must set persist-credentials=false",
          "openshell-version-pin-vitest step 'Set up Node' env must not include NVIDIA_API_KEY",
          "openshell-version-pin-vitest setup-node action must be pinned to a full commit SHA",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "openshell-version-pin-vitest step 'Run OpenShell version-pin live test' env must not include NVIDIA_API_KEY",
          "step 'Run OpenShell version-pin live test' run script must not interpolate dispatch inputs directly",
          "step 'Run OpenShell version-pin live test' run script must include test/e2e-scenario/live/openshell-version-pin.test.ts",
          "openshell-version-pin-vitest upload-artifact action must be pinned to a full commit SHA",
          "openshell-version-pin-vitest artifact upload name must be stable",
          "artifact upload path must include e2e-artifacts/vitest/openshell-version-pin/",
          "openshell-version-pin-vitest artifact upload must set include-hidden-files: false",
          "openshell-version-pin-vitest artifact upload must ignore missing fixture artifacts",
          "openshell-version-pin-vitest artifact upload retention-days must be 14",
          "onboard-negative-paths-vitest job must depend on validate-jobs and generate-matrix",
          "onboard-negative-paths-vitest job must use the shared jobs selector condition",
          "network-policy-vitest job must run on ubuntu-latest",
          "network-policy-vitest job must depend on validate-jobs and generate-matrix",
          "network-policy-vitest job must map scenarios=network-policy to the network-policy job",
          "network-policy-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
          "network-policy-vitest job must write artifacts under e2e-artifacts/vitest/network-policy",
          "network-policy-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
          "network-policy-vitest job must force OPENSHELL_GATEWAY=nemoclaw",
          "network-policy-vitest job env must not include NVIDIA_API_KEY",
          "network-policy-vitest job env must not include DOCKERHUB_USERNAME",
          "network-policy-vitest job env must not include DOCKERHUB_TOKEN",
          "network-policy-vitest job env must not include GITHUB_TOKEN",
          "onboard-negative-paths-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
          "onboard-negative-paths-vitest job must write artifacts under e2e-artifacts/vitest/onboard-negative-paths",
          "onboard-negative-paths-vitest job env must not include NVIDIA_API_KEY",
          "onboard-negative-paths-vitest checkout action must be pinned to a full commit SHA",
          "onboard-negative-paths-vitest checkout step must set persist-credentials=false",
          "onboard-negative-paths-vitest step 'Set up Node' env must not include NVIDIA_API_KEY",
          "onboard-negative-paths-vitest setup-node action must be pinned to a full commit SHA",
          "onboard-negative-paths-vitest job missing step: Build CLI",
          "onboard-negative-paths-vitest step 'Run onboard negative-paths live test' env must not include NVIDIA_API_KEY",
          "step 'Run onboard negative-paths live test' run script must not interpolate dispatch inputs directly",
          "step 'Run onboard negative-paths live test' run script must include test/e2e-scenario/live/onboard-negative-paths.test.ts",
          "onboard-negative-paths-vitest upload-artifact action must be pinned to a full commit SHA",
          "onboard-negative-paths-vitest artifact upload name must be stable",
          "artifact upload path must include e2e-artifacts/vitest/onboard-negative-paths/",
          "onboard-negative-paths-vitest artifact upload must set include-hidden-files: false",
          "onboard-negative-paths-vitest artifact upload must ignore missing fixture artifacts",
          "onboard-negative-paths-vitest artifact upload retention-days must be 14",
          "credential-migration-vitest job must depend on validate-jobs",
          "credential-migration-vitest job must use the shared jobs selector condition",
          "workflow missing runtime-overrides-vitest job",
          "network-policy-vitest checkout action must be pinned to a full commit SHA",
          "network-policy-vitest checkout step must set persist-credentials=false",
          "network-policy-vitest must not include unused Docker Hub authentication",
          "network-policy-vitest step 'Set up Node' env must not include NVIDIA_API_KEY",
          "network-policy-vitest setup-node action must be pinned to a full commit SHA",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "step 'Build CLI' run script must include npm run build:cli",
          "network-policy-vitest step 'Install OpenShell' env must not include GITHUB_TOKEN",
          "step 'Install OpenShell' run script must include bash scripts/install-openshell.sh",
          "step 'Install OpenShell' run script must include env -u DOCKER_CONFIG",
          "step 'Install OpenShell' run script must include -u DOCKERHUB_USERNAME",
          "step 'Install OpenShell' run script must include -u DOCKERHUB_TOKEN",
          "step 'Install OpenShell' run script must include -u NVIDIA_API_KEY",
          "step 'Install OpenShell' run script must include -u GITHUB_TOKEN",
          "step 'Run network-policy live test' run script must not interpolate dispatch inputs directly",
          "step 'Run network-policy live test' run script must include test/e2e-scenario/live/network-policy.test.ts",
          "network-policy-vitest upload-artifact action must be pinned to a full commit SHA",
          "network-policy-vitest artifact upload name must be stable",
          "artifact upload path must include e2e-artifacts/vitest/network-policy/",
          "network-policy-vitest artifact upload must set include-hidden-files: false",
          "network-policy-vitest artifact upload must ignore missing fixture artifacts",
          "network-policy-vitest artifact upload retention-days must be 14",
          "report-to-pr job must wait for credential-migration-vitest",
          "report-to-pr job must wait for runtime-overrides-vitest",
          "report-to-pr job must wait for network-policy-vitest",
          "workflow missing hermes-e2e-vitest job",
          "report-to-pr job must wait for hermes-e2e-vitest",
          "openclaw-tui-chat-correlation-vitest job must depend on validate-jobs and generate-matrix",
          "openclaw-tui-chat-correlation-vitest job must use the shared jobs selector condition",
          "gateway-guard-recovery job must depend on validate-jobs",
          "gateway-guard-recovery job must use the shared jobs selector condition",
          "report-to-pr job must wait for validate-jobs",
          "report-to-pr job must wait for live-scenarios",
          "report-to-pr step must pass pr_number through JOB_PR_NUMBER env",
          "report-to-pr step must pass scenarios through JOB_SCENARIOS env",
          "step 'Post Vitest scenario results to PR' run script must include process.env.JOBS",
          "step 'Post Vitest scenario results to PR' run script must include process.env.JOB_SCENARIOS",
          "step 'Post Vitest scenario results to PR' run script must check validate-jobs before echoing selectors",
          "step 'Post Vitest scenario results to PR' run script must omit rejected job selectors",
          "step 'Post Vitest scenario results to PR' run script must omit rejected scenario selectors",
          "step 'Post Vitest scenario results to PR' run script must include **Requested jobs:**",
          "step 'Post Vitest scenario results to PR' run script must include **Requested scenarios:**",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires runtime-overrides literals in selector allowlists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow
        .replace(/runtime-overrides-vitest/g, "runtime-overrides-missing")
        .replace(/runtime-overrides/g, "runtime-overrides-missing"),
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "step 'Validate free-standing job selector' run script must include runtime-overrides-vitest",
          "step 'Generate Vitest scenario matrix' run script must include runtime-overrides-vitest",
          "workflow missing runtime-overrides-vitest job",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects Docker Hub auth and inline secrets in runtime-overrides run steps", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "npx vitest run --project e2e-scenarios-live \\\n            test/e2e-scenario/live/runtime-overrides.test.ts \\",
        "docker login docker.io --username user --password ${{ secrets.DOCKERHUB_TOKEN }}\n          npx vitest run --project e2e-scenarios-live \\\n            test/e2e-scenario/live/runtime-overrides.test.ts \\",
      ),
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toContain(
        "runtime-overrides-vitest step 'Run runtime overrides live test' run script must not use docker login or inline secret interpolation",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects raw jobs selector echo from matrix generation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        'echo "::error::Invalid jobs input; use comma-separated job ids" >&2',
        'echo "::error::Invalid jobs input: ${JOBS}" >&2',
      ),
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "step 'Generate Vitest scenario matrix' run script must include Invalid jobs input; use comma-separated job ids",
          "step 'Generate Vitest scenario matrix' run script must not include Invalid jobs input: ${JOBS}",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
