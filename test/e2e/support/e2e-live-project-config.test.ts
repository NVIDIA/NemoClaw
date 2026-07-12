// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import config from "../../../vitest.config.ts";
import { readYaml, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";
import {
  shouldRunBranchValidationE2E,
  shouldRunInstallerIntegration,
  shouldRunLiveE2E,
} from "../fixtures/live-project-gate.ts";

interface ProjectConfig {
  test?: {
    env?: Record<string, string>;
    fileParallelism?: boolean;
    name?: string;
    include?: string[];
    retry?: number;
  };
}

interface RootConfig {
  test?: {
    env?: Record<string, string>;
    projects?: ProjectConfig[];
  };
}

const INSTALLER_INTEGRATION_TESTS = [
  "test/install-express-prompt.test.ts",
  "test/install-build-dependency-preflight.test.ts",
  "test/install-preflight.test.ts",
  "test/install-preflight-docker-bootstrap.test.ts",
  "test/install-openshell-version-check.test.ts",
];
const LIVE_E2E_TARGET_TESTS = ["test/e2e/live/**/*.test.ts"];
const BRANCH_VALIDATION_E2E_TESTS = ["test/e2e/brev-e2e.test.ts"];
const DRIFT_PREFLIGHT_BYPASS = "NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT";
const NON_LIVE_PROJECTS = [
  "cli",
  "integration",
  "installer-integration",
  "package-contract",
  "plugin",
  "e2e-support",
];
const LIVE_PROJECTS = ["e2e-live", "e2e-branch-validation"];

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
  it("keeps installer membership static and selects live includes from the environment", () => {
    expect(projectConfig("installer-integration").test?.include).toEqual(
      INSTALLER_INTEGRATION_TESTS,
    );
    expect(projectConfig("e2e-live").test?.include).toEqual(
      shouldRunLiveE2E() ? LIVE_E2E_TARGET_TESTS : [],
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

  it("enables live targets only by the explicit live target opt-in env var", () => {
    expect(shouldRunLiveE2E({})).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "0" })).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "yes" })).toBe(false);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "1" })).toBe(true);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: "true" })).toBe(true);
    expect(shouldRunLiveE2E({ NEMOCLAW_RUN_LIVE_E2E: " TRUE " })).toBe(true);
  });

  it("enables branch validation from the workflow sentinel or Brev auth env", () => {
    expect(shouldRunBranchValidationE2E({})).toBe(false);
    expect(shouldRunBranchValidationE2E({ BREV_API_KEY: "key" })).toBe(false);
    expect(shouldRunBranchValidationE2E({ BREV_API_KEY: "key", BREV_ORG_ID: "org" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ BREV_API_TOKEN: "token" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "true" })).toBe(true);
    expect(shouldRunBranchValidationE2E({ NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: "1" })).toBe(true);
  });

  it("keeps stateful E2E retries disabled and aggregate live files serial (#6692)", () => {
    expect(projectConfig("cli").test?.retry).toBeUndefined();
    expect(projectConfig("e2e-support").test?.retry).toBeUndefined();
    expect(projectConfig("e2e-live").test?.retry).toBe(0);
    expect(projectConfig("e2e-live").test?.fileParallelism).toBe(false);
    expect(projectConfig("e2e-branch-validation").test?.retry).toBe(0);
  });

  it("keeps the drift-preflight bypass out of live projects (#6692)", () => {
    expect((config as RootConfig).test?.env?.[DRIFT_PREFLIGHT_BYPASS]).toBeUndefined();
    for (const name of NON_LIVE_PROJECTS) {
      expect(projectConfig(name).test?.env?.[DRIFT_PREFLIGHT_BYPASS], name).toBe("1");
    }
    for (const name of LIVE_PROJECTS) {
      expect(projectConfig(name).test?.env?.[DRIFT_PREFLIGHT_BYPASS], name).toBeUndefined();
    }
  });

  it("cleans and rebuilds the CLI before aggregate live E2E execution (#6692)", () => {
    const npmCli = process.env.npm_execpath ?? "";
    expect(npmCli).not.toBe("");

    const fixtureRoot = mkdtempSync(join(tmpdir(), "nemoclaw-live-e2e-script-"));
    const fakeBin = join(fixtureRoot, "bin");
    const commandLog = join(fixtureRoot, "commands.log");
    const scriptShell = join(fixtureRoot, "script-shell");
    const npmStub = join(fakeBin, "npm");
    const vitestStub = join(fakeBin, "vitest");

    try {
      mkdirSync(fakeBin);
      writeFileSync(
        scriptShell,
        `#!/bin/sh\nPATH="$FAKE_BIN:${dirname(process.execPath)}:/usr/bin:/bin"\nexport PATH\nexec /bin/sh "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(npmStub, '#!/bin/sh\nprintf \'npm %s\\n\' "$*" >> "$COMMAND_LOG"\n', {
        mode: 0o755,
      });
      writeFileSync(
        vitestStub,
        '#!/bin/sh\nprintf \'vitest %s | live=%s\\n\' "$*" "$NEMOCLAW_RUN_LIVE_E2E" >> "$COMMAND_LOG"\n',
        { mode: 0o755 },
      );
      chmodSync(scriptShell, 0o755);
      chmodSync(npmStub, 0o755);
      chmodSync(vitestStub, 0o755);

      const result = spawnSync(process.execPath, [npmCli, "run", "test:live-e2e"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          COMMAND_LOG: commandLog,
          FAKE_BIN: fakeBin,
          npm_config_script_shell: scriptShell,
        },
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
        "npm run clean:cli",
        "npm run build:cli",
        "vitest run --project e2e-live | live=1",
      ]);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("sets the branch-validation sentinel in the reusable workflow live E2E step", () => {
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
