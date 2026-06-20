// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  shouldRunBranchValidationE2E,
  shouldRunInstallerIntegration,
  shouldRunLiveE2EScenarios,
} from "../fixtures/live-project-gate.ts";
import config from "../../../vitest.config.ts";
import { resolveE2ERetryCount } from "../../helpers/e2e-retries.ts";
import { readYaml, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

interface ProjectConfig {
  test?: {
    name?: string;
    include?: string[];
    retry?: number;
  };
}

interface RootConfig {
  test?: {
    projects?: ProjectConfig[];
  };
}

const INSTALLER_INTEGRATION_TESTS = [
  "test/install-preflight.test.ts",
  "test/install-preflight-docker-bootstrap.test.ts",
  "test/install-openshell-version-check.test.ts",
];
const LIVE_E2E_SCENARIO_TESTS = ["test/e2e-scenario/live/**/*.test.ts"];
const BRANCH_VALIDATION_E2E_TESTS = ["test/e2e/brev-e2e.test.ts"];

type BranchValidationWorkflow = {
  jobs?: {
    "e2e-branch-validation"?: {
      steps?: WorkflowStep[];
    };
  };
};

function projectConfig(name: string): ProjectConfig {
  const projects = (config as RootConfig).test?.projects ?? [];
  const project = projects.find((entry) => entry.test?.name === name);
  if (!project) {
    throw new Error(`missing ${name} Vitest project`);
  }
  return project;
}

describe("gated E2E Vitest projects", () => {
  it("selects gated project includes from the current process environment", () => {
    expect(projectConfig("installer-integration").test?.include).toEqual(
      shouldRunInstallerIntegration() ? INSTALLER_INTEGRATION_TESTS : [],
    );
    expect(projectConfig("e2e-scenarios-live").test?.include).toEqual(
      shouldRunLiveE2EScenarios() ? LIVE_E2E_SCENARIO_TESTS : [],
    );
    expect(projectConfig("e2e-branch-validation").test?.include).toEqual(
      shouldRunBranchValidationE2E() ? BRANCH_VALIDATION_E2E_TESTS : [],
    );
  });

  it("enables installer integration only in CI or with the installer opt-in env var", () => {
    expect(shouldRunInstallerIntegration({})).toBe(false);
    expect(shouldRunInstallerIntegration({ CI: "0" })).toBe(false);
    expect(shouldRunInstallerIntegration({ CI: "1" })).toBe(true);
    expect(shouldRunInstallerIntegration({ CI: "true" })).toBe(true);
    expect(shouldRunInstallerIntegration({ NEMOCLAW_RUN_INSTALLER_TESTS: "1" })).toBe(true);
  });

  it("enables live scenarios only by the explicit live scenario opt-in env var", () => {
    expect(shouldRunLiveE2EScenarios({})).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "0" })).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "yes" })).toBe(false);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "1" })).toBe(true);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: "true" })).toBe(true);
    expect(shouldRunLiveE2EScenarios({ NEMOCLAW_RUN_E2E_SCENARIOS: " TRUE " })).toBe(true);
  });

  it("enables branch validation from the workflow sentinel or Brev auth env", () => {
    expect(shouldRunBranchValidationE2E({})).toBe(false);
    expect(shouldRunBranchValidationE2E({ BREV_API_KEY: "key" })).toBe(false);
    expect(shouldRunBranchValidationE2E({ BREV_API_KEY: "key", BREV_ORG_ID: "org" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ BREV_API_TOKEN: "token" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "true" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "1" })).toBe(true);
  });

  it("configures automatic retries only for live E2E Vitest projects", () => {
    const expectedRetries = resolveE2ERetryCount();

    expect(projectConfig("cli").test?.retry).toBeUndefined();
    expect(projectConfig("e2e-vitest-support").test?.retry).toBeUndefined();
    expect(projectConfig("e2e-scenarios-live").test?.retry).toBe(expectedRetries);
    expect(projectConfig("e2e-branch-validation").test?.retry).toBe(expectedRetries);
  });

  it("defaults live E2E retries to CI only and supports explicit overrides", () => {
    expect(resolveE2ERetryCount({})).toBe(0);
    expect(resolveE2ERetryCount({ CI: "0" })).toBe(0);
    expect(resolveE2ERetryCount({ CI: "1" })).toBe(2);
    expect(resolveE2ERetryCount({ CI: "true" })).toBe(2);
    expect(resolveE2ERetryCount({ GITHUB_ACTIONS: "true" })).toBe(2);
    expect(resolveE2ERetryCount({ CI: "1", NEMOCLAW_E2E_RETRIES: "0" })).toBe(0);
    expect(resolveE2ERetryCount({ NEMOCLAW_E2E_RETRIES: "3" })).toBe(3);
    expect(resolveE2ERetryCount({ NEMOCLAW_E2E_RETRIES: "5" })).toBe(5);
    expect(resolveE2ERetryCount({ NEMOCLAW_E2E_RETRIES: "6" })).toBe(5);
    expect(resolveE2ERetryCount({ NEMOCLAW_E2E_RETRIES: "999999" })).toBe(5);
    expect(resolveE2ERetryCount({ CI: "1", NEMOCLAW_E2E_RETRIES: "-1" })).toBe(2);
    expect(resolveE2ERetryCount({ CI: "1", NEMOCLAW_E2E_RETRIES: "1.5" })).toBe(2);
    expect(resolveE2ERetryCount({ CI: "1", NEMOCLAW_E2E_RETRIES: "invalid" })).toBe(2);
  });

  it("sets the branch-validation sentinel in the reusable workflow Vitest step", () => {
    const workflow = readYaml<BranchValidationWorkflow>(
      ".github/workflows/e2e-branch-validation.yaml",
    );
    const runStep = workflow.jobs?.["e2e-branch-validation"]?.steps?.find(
      (step) => step.name === "Run ephemeral Brev E2E",
    );

    expect(runStep?.run).toContain("npx vitest run --project e2e-branch-validation");
    expect(runStep?.env?.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E).toBe("1");
  });
});
