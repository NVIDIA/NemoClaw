// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  readSandboxOperationsWorkflow,
  validateSandboxOperationsWorkflow,
} from "../../../tools/e2e-scenarios/sandbox-operations-workflow-boundary.mts";
import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "e2e-vitest-scenarios.yaml");

function validateCentralWorkflowMutation(mutate: (source: string) => string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-sandbox-operations-boundary-"));
  const workflowPath = join(directory, "workflow.yaml");
  try {
    writeFileSync(workflowPath, mutate(readFileSync(WORKFLOW_PATH, "utf8")));
    return validateE2eVitestScenariosWorkflowBoundary(workflowPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function mutateSandboxOperationsJob(source: string, mutate: (jobSource: string) => string): string {
  const startMarker = "  sandbox-operations-vitest:\n";
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + startMarker.length);
  const nextJob = /^  [A-Za-z0-9_-]+:\n/m.exec(rest);
  const end = nextJob ? start + startMarker.length + nextJob.index : source.length;
  expect(end).toBeGreaterThan(start + startMarker.length);
  const jobSource = source.slice(start, end);
  const mutated = mutate(jobSource);
  expect(mutated).not.toBe(jobSource);
  return `${source.slice(0, start)}${mutated}${source.slice(end)}`;
}

describe("sandbox operations workflow boundary", () => {
  it("runs by default and through either selective dispatch input", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateE2eVitestScenariosWorkflowBoundary()).toEqual([]);
    expect(inventory.scenarioToJob.get("sandbox-operations")).toBe("sandbox-operations-vitest");

    for (const selector of [
      { scenarios: "sandbox-operations" },
      { jobs: "sandbox-operations-vitest" },
    ]) {
      expect(evaluateE2eVitestWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveScenariosRuns: false,
        selectedFreeStandingJobs: ["sandbox-operations-vitest"],
      });
    }
    expect(evaluateE2eVitestWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "sandbox-operations-vitest",
    );
  });

  it("rejects workspace-scoped auth, unsanitized installs, and broad inference secrets", () => {
    const jobMarker = [
      '      FREE_STANDING_VITEST_JOB: "1"',
      '      FREE_STANDING_SCENARIO_ID: "sandbox-operations"',
      "",
    ].join("\n");
    expect(
      validateCentralWorkflowMutation((source) => {
        expect(source).toContain(jobMarker);
        return source.replace(
          jobMarker,
          `${jobMarker}      DOCKER_CONFIG: \${{ github.workspace }}/docker\n`,
        );
      }),
    ).toContain("sandbox-operations-vitest must not configure Docker auth at job scope");

    const workspaceAuth = readSandboxOperationsWorkflow();
    workspaceAuth.jobs["sandbox-operations-vitest"].env!.DOCKER_CONFIG =
      "${{ github.workspace }}/docker";
    expect(validateSandboxOperationsWorkflow(workspaceAuth)).toContain(
      "sandbox-operations-vitest must not configure Docker auth at job scope",
    );

    const unsanitizedInstall = readSandboxOperationsWorkflow();
    unsanitizedInstall.jobs["sandbox-operations-vitest"].steps!.find(
      (step) => step.name === "Install OpenShell CLI",
    )!.run = "bash scripts/install-openshell.sh";
    expect(validateSandboxOperationsWorkflow(unsanitizedInstall)).toContain(
      "sandbox-operations-vitest step 'Install OpenShell CLI' must run: -u DOCKER_CONFIG",
    );

    const broadInferenceSecret = readSandboxOperationsWorkflow();
    broadInferenceSecret.jobs["sandbox-operations-vitest"].steps!.find(
      (step) => step.name === "Build CLI",
    )!.env = { NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}" };
    expect(validateSandboxOperationsWorkflow(broadInferenceSecret)).toContain(
      "sandbox-operations-vitest exposes the inference key outside the live test step",
    );
  });

  it("keeps secret-bearing live jobs on manual dispatch with read-only contents", () => {
    expect(
      validateCentralWorkflowMutation((source) =>
        source.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"),
      ),
    ).toContain("workflow must not run on pull_request");

    expect(
      validateCentralWorkflowMutation((source) =>
        source.replace("permissions:\n  contents: read", "permissions:\n  contents: write"),
      ),
    ).toContain("workflow permissions.contents must be read");
  });

  it.each([
    {
      label: "a non-launcher CLI path",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            "      NEMOCLAW_CLI_BIN: ${{ github.workspace }}/bin/nemoclaw.js",
            "      NEMOCLAW_CLI_BIN: ${{ github.workspace }}/dist/nemoclaw.js",
          ),
        ),
      expected: "sandbox-operations-vitest must use the stable bin/nemoclaw.js CLI launcher",
    },
    {
      label: "a missing CLI launcher preflight",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace('          test -x "${NEMOCLAW_CLI_BIN}"', "          true"),
        ),
      expected:
        "sandbox-operations-vitest step 'Verify CLI launcher' must run: test -x \"${NEMOCLAW_CLI_BIN}\"",
    },
    {
      label: "Docker credentials at job scope",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            '      FREE_STANDING_SCENARIO_ID: "sandbox-operations"',
            [
              '      FREE_STANDING_SCENARIO_ID: "sandbox-operations"',
              "      DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}",
            ].join("\n"),
          ),
        ),
      expected: "sandbox-operations-vitest must not expose DOCKERHUB_TOKEN at job scope",
    },
    {
      label: "Docker credentials on another step",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            "      - name: Build CLI\n        run: npm run build:cli",
            [
              "      - name: Build CLI",
              "        env:",
              "          DOCKERHUB_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}",
              "        run: npm run build:cli",
            ].join("\n"),
          ),
        ),
      expected:
        "sandbox-operations-vitest exposes DOCKERHUB_USERNAME outside the Docker authentication step",
    },
    {
      label: "step-scoped Docker config",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            "      - name: Build CLI\n        run: npm run build:cli",
            [
              "      - name: Build CLI",
              "        env:",
              '          DOCKER_CONFIG: "${{ runner.temp }}/docker"',
              "        run: npm run build:cli",
            ].join("\n"),
          ),
        ),
      expected: "sandbox-operations-vitest must not expose DOCKER_CONFIG through step 'Build CLI'",
    },
    {
      label: "persistent environment write outside the configure step",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            "      - name: Build CLI\n        run: npm run build:cli",
            [
              "      - name: Build CLI",
              "        run: |",
              "          npm run build:cli",
              '          echo "DOCKER_CONFIG=${{ github.workspace }}/docker" >> "$GITHUB_ENV"',
            ].join("\n"),
          ),
        ),
      expected: "sandbox-operations-vitest step 'Build CLI' must not write persistent environment",
    },
    {
      label: "workspace override in the configure step",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            '        run: echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-sandbox-operations" >> "$GITHUB_ENV"',
            [
              "        run: |",
              '          echo "DOCKER_CONFIG=${RUNNER_TEMP}/docker-config-sandbox-operations" >> "$GITHUB_ENV"',
              '          echo "DOCKER_CONFIG=${{ github.workspace }}/docker" >> "$GITHUB_ENV"',
            ].join("\n"),
          ),
        ),
      expected:
        "sandbox-operations-vitest Docker auth directory must not use the checkout workspace",
    },
  ])("rejects $label", ({ expected, mutate }) => {
    expect(validateCentralWorkflowMutation(mutate)).toContain(expected);
  });
});
