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
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
  validateFreeStandingJobsEnvContent,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

function generateMatrixScript(): string {
  const workflow = readWorkflow();
  const jobs = workflow.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>;
  const generateStep = jobs["generate-matrix"]?.steps?.find(
    (step) => step.name === "Generate Vitest scenario matrix",
  );
  expect(generateStep?.run).toEqual(expect.any(String));
  return generateStep?.run as string;
}

function generateMatrixForDispatch(env: {
  JOBS: string;
  SCENARIOS: string;
}): Record<string, string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-matrix-"));
  const outputPath = path.join(tmp, "github-output");
  const summaryPath = path.join(tmp, "github-summary");
  try {
    const result = spawnSync("bash", ["-c", generateMatrixScript()], {
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
    expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "skill-agent" })).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["skill-agent-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "skill-agent-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["skill-agent-vitest"],
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
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "inference-routing" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["inference-routing-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "inference-routing-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["inference-routing-vitest"],
      registryScenarios: [],
    });
    expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "hermes-e2e" })).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["hermes-e2e-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "hermes-root-entrypoint-smoke" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["hermes-root-entrypoint-smoke-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "hermes-root-entrypoint-smoke-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["hermes-root-entrypoint-smoke-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "shields-config" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["shields-config-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "shields-config-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["shields-config-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: "rebuild-openclaw" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["rebuild-openclaw-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({ jobs: "rebuild-openclaw-vitest" }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["rebuild-openclaw-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        scenarios: "model-router-provider-routed-inference",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["model-router-provider-routed-inference-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        jobs: "model-router-provider-routed-inference-vitest",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["model-router-provider-routed-inference-vitest"],
      registryScenarios: [],
    });
  });

  it("keeps the free-standing inventory internally consistent and data-only", () => {
    const inventory = fs.readFileSync(
      path.join(process.cwd(), "tools/e2e-scenarios/free-standing-jobs.env"),
      "utf-8",
    );
    expect(validateFreeStandingJobsEnvContent(inventory)).toEqual([]);
    expect(
      validateFreeStandingJobsEnvContent(
        [
          "allowed_jobs=openshell-version-pin-vitest",
          "free_standing_scenarios_csv=openshell-version-pin",
          "free_standing_scenario_jobs_csv=openshell-version-pin:missing-vitest",
        ].join("\n"),
      ),
    ).toContain("free-standing inventory maps openshell-version-pin to unknown job missing-vitest");
    expect(
      validateFreeStandingJobsEnvContent(
        [
          "allowed_jobs=openshell-version-pin-vitest",
          "free_standing_scenarios_csv=openshell-version-pin,extra-scenario",
          "free_standing_scenario_jobs_csv=openshell-version-pin:openshell-version-pin-vitest",
        ].join("\n"),
      ),
    ).toContain(
      "free_standing_scenarios_csv must exactly match free_standing_scenario_jobs_csv keys",
    );
    expect(
      validateFreeStandingJobsEnvContent(
        [
          "allowed_jobs=openshell-version-pin-vitest",
          "free_standing_scenarios_csv=openshell-version-pin",
          "free_standing_scenario_jobs_csv=openshell-version-pin:openshell-version-pin-vitest",
          "export injected=true",
          "allowed_jobs=$(touch /tmp/nope)",
        ].join("\n"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "free-standing jobs inventory line 4 must be data-only key=value",
        "free-standing jobs inventory line 5 must be data-only key=value",
      ]),
    );
  });

  it("rejects malformed inventory in the workflow runtime before matrix generation", () => {
    const malformedInventories = [
      [
        "allowed_jobs=openshell-version-pin-vitest",
        "allowed_jobs=onboard-negative-paths-vitest",
        "free_standing_scenarios_csv=openshell-version-pin",
        "free_standing_scenario_jobs_csv=openshell-version-pin:openshell-version-pin-vitest",
      ],
      [
        "allowed_jobs=openshell-version-pin-vitest,openshell-version-pin-vitest",
        "free_standing_scenarios_csv=openshell-version-pin",
        "free_standing_scenario_jobs_csv=openshell-version-pin:openshell-version-pin-vitest",
      ],
      [
        "allowed_jobs=bad:job",
        "free_standing_scenarios_csv=openshell-version-pin",
        "free_standing_scenario_jobs_csv=openshell-version-pin:bad:job",
      ],
      [
        "allowed_jobs=openshell-version-pin-vitest",
        "free_standing_scenarios_csv=openshell-version-pin",
        "free_standing_scenario_jobs_csv=openshell-version-pin:openshell-version-pin-vitest,openshell-version-pin:openshell-version-pin-vitest",
      ],
    ];

    for (const inventory of malformedInventories) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-bad-inventory-"));
      try {
        fs.mkdirSync(path.join(tmp, "tools", "e2e-scenarios"), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, "tools", "e2e-scenarios", "free-standing-jobs.env"),
          `${inventory.join("\n")}\n`,
        );
        const result = spawnSync("bash", ["-c", generateMatrixScript()], {
          cwd: tmp,
          encoding: "utf-8",
          timeout: 10_000,
          killSignal: "SIGKILL",
          env: {
            ...process.env,
            GITHUB_OUTPUT: path.join(tmp, "github-output"),
            GITHUB_STEP_SUMMARY: path.join(tmp, "github-summary"),
            JOBS: "",
            SCENARIOS: "",
          },
        });
        expect(result.signal).toBeNull();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("::error::");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("keeps each free-standing scenario out of the registry matrix", () => {
    const inventory = readFreeStandingJobsInventory();
    for (const job of inventory.allowedJobs) {
      expect(generateMatrixForDispatch({ JOBS: job, SCENARIOS: "" })).toMatchObject({
        hermes_selected: job === "hermes-e2e-vitest" ? "true" : "false",
        matrix: "[]",
      });
    }
    for (const [scenario, job] of inventory.scenarioToJob) {
      expect(generateMatrixForDispatch({ JOBS: "", SCENARIOS: scenario })).toMatchObject({
        hermes_selected: scenario === "hermes-e2e" ? "true" : "false",
        matrix: "[]",
      });
      expect(evaluateE2eVitestWorkflowDispatchSelectors({ scenarios: scenario })).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: [job],
        registryScenarios: [],
      });
    }
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
  double-onboard-vitest:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.scenarios != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/double-onboard
      NEMOCLAW_CLI_BIN: ./bad-cli.js
      NEMOCLAW_RUN_E2E_SCENARIOS: "0"
      NVIDIA_API_KEY: \${{ secrets.NVIDIA_API_KEY }}
      DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Authenticate to Docker Hub
        env:
          DOCKERHUB_USERNAME: plain-user
          DOCKERHUB_TOKEN: plain-token
        run: echo no docker login
      - name: Set up Node
        uses: actions/setup-node@v4
      - name: Install root dependencies
        run: npm install
      - name: Build CLI
        run: echo skip build
      - name: Install OpenShell CLI
        run: echo skip install
      - name: Run double-onboard live Vitest test
        env:
          DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
        run: npx vitest run --project e2e-scenarios-live "\${{ inputs.test_filter }}"
      - name: Upload double-onboard Vitest artifacts
        uses: actions/upload-artifact@v4
        with:
          name: double-onboard
          path: .e2e/double-onboard/
          include-hidden-files: true
          if-no-files-found: error

`,
    );

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow_dispatch missing input: scenarios",
          "workflow_dispatch missing input: jobs",
          "workflow_dispatch must not expose legacy test_filter input",
          "workflow missing generate-matrix job",
          "live-scenarios job must run on the matrix runner",
          "live-scenarios job env must not include NVIDIA_API_KEY",
          "step 'Run Vitest live E2E scenarios' run script must not interpolate dispatch inputs directly",
          "Vitest step must receive NVIDIA_API_KEY from secrets",
          "artifact upload must set include-hidden-files: false",
          "upload-artifact action must be pinned to a full commit SHA",
          "openshell-version-pin-vitest job must use the shared jobs selector condition",
          "network-policy-vitest job env must not include NVIDIA_API_KEY",
          "network-policy-vitest step 'Install OpenShell' env must not include GITHUB_TOKEN",
          "double-onboard-vitest job env must not include DOCKERHUB_TOKEN",
          "step 'Run double-onboard live Vitest test' run script must not interpolate dispatch inputs directly",
          "workflow missing hermes-e2e-vitest job",
          "workflow missing skill-agent-vitest job",
          "workflow missing model-router-provider-routed-inference-vitest job",
          "report-to-pr job must wait for live-scenarios",
          "report-to-pr step must pass jobs through JOBS env",
          "step 'Post Vitest scenario results to PR' run script must check selector validation before echoing selectors",
          "step 'Post Vitest scenario results to PR' run script must omit rejected job selectors",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects workflow selector drift from the free-standing inventory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow.replace(" || contains(format(',{0},', inputs.scenarios), ',sandbox-rebuild,')", ""),
    );

    try {
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toContain(
        "free-standing inventory mapping sandbox-rebuild:sandbox-rebuild-vitest must match the workflow job selector",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires runtime-overrides workflow and report coverage", () => {
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
          "workflow missing runtime-overrides-vitest job",
          "report-to-pr job must wait for runtime-overrides-vitest",
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

  it("rejects Docker Hub auth in the Hermes root-entrypoint smoke job", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    const steps = workflow.jobs["hermes-root-entrypoint-smoke-vitest"]?.steps;
    expect(steps).toEqual(expect.any(Array));
    const setupNodeIndex = steps.findIndex((step) => step.name === "Set up Node");
    expect(setupNodeIndex).toBeGreaterThan(0);
    steps.splice(setupNodeIndex, 0, {
      name: "Authenticate to Docker Hub",
      env: {
        DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
        DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
      },
      run: "docker login docker.io --username user --password ${{ secrets.DOCKERHUB_TOKEN }}",
    });
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eVitestScenariosWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "hermes-root-entrypoint-smoke-vitest must not authenticate to Docker Hub before branch-controlled test code runs",
          "hermes-root-entrypoint-smoke-vitest step 'Authenticate to Docker Hub' env must not include DOCKERHUB_USERNAME",
          "hermes-root-entrypoint-smoke-vitest step 'Authenticate to Docker Hub' env must not include DOCKERHUB_TOKEN",
          "hermes-root-entrypoint-smoke-vitest step 'Authenticate to Docker Hub' run script must not use docker login or inline secret interpolation",
        ]),
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
