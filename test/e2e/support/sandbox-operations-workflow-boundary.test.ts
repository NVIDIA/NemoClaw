// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  readSandboxOperationsWorkflow,
  validateSandboxOperationsWorkflow,
} from "../../../tools/e2e/sandbox-operations-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";

const WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "e2e.yaml");

function validateCentralWorkflowMutation(mutate: (source: string) => string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-sandbox-operations-boundary-"));
  const workflowPath = join(directory, "workflow.yaml");
  try {
    writeFileSync(workflowPath, mutate(readFileSync(WORKFLOW_PATH, "utf8")));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function mutateSandboxOperationsJob(source: string, mutate: (jobSource: string) => string): string {
  const startMarker = "  sandbox-operations:\n";
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
    expect(validateE2eWorkflowBoundary()).toEqual([]);
    expect(inventory.targetToJob.get("sandbox-operations")).toBe("sandbox-operations");

    for (const selector of [{ targets: "sandbox-operations" }, { jobs: "sandbox-operations" }]) {
      expect(evaluateE2eWorkflowDispatchSelectors(selector)).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["sandbox-operations"],
      });
    }
    expect(evaluateE2eWorkflowDispatchSelectors({}).selectedFreeStandingJobs).toContain(
      "sandbox-operations",
    );
  });

  it("rejects workspace-scoped auth, unsanitized installs, and broad inference secrets", () => {
    const jobMarker = ['      E2E_JOB: "1"', '      E2E_TARGET_ID: "sandbox-operations"', ""].join(
      "\n",
    );
    expect(
      validateCentralWorkflowMutation((source) => {
        expect(source).toContain(jobMarker);
        return source.replace(
          jobMarker,
          `${jobMarker}      DOCKER_CONFIG: \${{ github.workspace }}/docker\n`,
        );
      }),
    ).toContain("sandbox-operations must not configure Docker auth at job scope");

    const workspaceAuth = readSandboxOperationsWorkflow();
    workspaceAuth.jobs["sandbox-operations"].env!.DOCKER_CONFIG = "${{ github.workspace }}/docker";
    expect(validateSandboxOperationsWorkflow(workspaceAuth)).toContain(
      "sandbox-operations must not configure Docker auth at job scope",
    );

    const unsanitizedInstall = readSandboxOperationsWorkflow();
    unsanitizedInstall.jobs["sandbox-operations"].steps!.find(
      (step) => step.name === "Install OpenShell CLI",
    )!.run = "bash scripts/install-openshell.sh";
    expect(validateSandboxOperationsWorkflow(unsanitizedInstall)).toContain(
      "sandbox-operations step 'Install OpenShell CLI' must run: -u DOCKER_CONFIG",
    );

    const broadInferenceSecret = readSandboxOperationsWorkflow();
    broadInferenceSecret.jobs["sandbox-operations"].steps!.find(
      (step) => step.name === "Build CLI",
    )!.env = { NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}" };
    expect(validateSandboxOperationsWorkflow(broadInferenceSecret)).toContain(
      "sandbox-operations exposes the inference key outside the live test step",
    );
  });

  it("keeps secret-bearing live jobs on manual dispatch with read-only contents", () => {
    expect(
      validateCentralWorkflowMutation((source) =>
        source.replace("  workflow_dispatch:", "  pull_request:\n  workflow_dispatch:"),
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
      expected: "sandbox-operations must use the stable bin/nemoclaw.js CLI launcher",
    },
    {
      label: "a missing CLI launcher preflight",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace('          test -x "${NEMOCLAW_CLI_BIN}"', "          true"),
        ),
      expected:
        "sandbox-operations step 'Verify CLI launcher' must run: test -x \"${NEMOCLAW_CLI_BIN}\"",
    },
    {
      label: "Docker credentials at job scope",
      mutate: (source: string) =>
        mutateSandboxOperationsJob(source, (jobSource) =>
          jobSource.replace(
            '      E2E_TARGET_ID: "sandbox-operations"',
            [
              '      E2E_TARGET_ID: "sandbox-operations"',
              "      DOCKERHUB_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}",
            ].join("\n"),
          ),
        ),
      expected: "sandbox-operations must not expose DOCKERHUB_TOKEN at job scope",
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
        "sandbox-operations exposes DOCKERHUB_USERNAME outside the Docker authentication step",
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
      expected: "sandbox-operations must not expose DOCKER_CONFIG through step 'Build CLI'",
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
      expected: "sandbox-operations step 'Build CLI' must not write persistent environment",
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
      expected: "sandbox-operations Docker auth directory must not use the checkout workspace",
    },
  ])("rejects $label", ({ expected, mutate }) => {
    expect(validateCentralWorkflowMutation(mutate)).toContain(expected);
  });
});
