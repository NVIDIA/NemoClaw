// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  shouldRunBranchValidationE2E,
  shouldRunInstallerIntegration,
  shouldRunLiveE2EScenarios,
} from "../framework/live-project-gate.ts";
import config from "../../../vitest.config.ts";
import { readYaml, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

interface ProjectConfig {
  test?: {
    name?: string;
    include?: string[];
  };
}

interface RootConfig {
  test?: {
    projects?: ProjectConfig[];
  };
}

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
  it("keeps opt-in projects present but empty by default", () => {
    expect(projectConfig("installer-integration").test?.include).toEqual([]);
    expect(projectConfig("e2e-scenarios-live").test?.include).toEqual([]);
    expect(projectConfig("e2e-branch-validation").test?.include).toEqual([]);
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

  it("sets the branch-validation sentinel in the reusable workflow Vitest step", () => {
    const workflow = readYaml<BranchValidationWorkflow>(".github/workflows/e2e-branch-validation.yaml");
    const runStep = workflow.jobs?.["e2e-branch-validation"]?.steps?.find(
      (step) => step.name === "Run ephemeral Brev E2E",
    );

    expect(runStep?.run).toContain("npx vitest run --project e2e-branch-validation");
    expect(runStep?.env?.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E).toBe("1");
  });
});
