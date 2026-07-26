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
    setupFiles?: string[];
  };
}

interface RootConfig {
  test?: {
    env?: Record<string, string>;
    projects?: ProjectConfig[];
  };
}

type BranchValidationWorkflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

const DRIFT_PREFLIGHT_BYPASS = "NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT";
const FIXTURE_UMASK_SETUP = "test/helpers/normalize-fixture-umask.ts";

function projectConfigs(): ProjectConfig[] {
  return (config as RootConfig).test?.projects ?? [];
}

describe("gated E2E Vitest projects", () => {
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

  it("keeps stateful E2E project retries disabled and aggregate live files serial (#6692)", () => {
    const statefulProjects = projectConfigs().filter(
      (project) => !project.test?.setupFiles?.includes(FIXTURE_UMASK_SETUP),
    );
    const deterministicProjects = projectConfigs().filter((project) =>
      project.test?.setupFiles?.includes(FIXTURE_UMASK_SETUP),
    );

    expect(statefulProjects.length).toBeGreaterThan(0);
    expect(statefulProjects.every((project) => project.test?.retry === 0)).toBe(true);
    expect(statefulProjects.some((project) => project.test?.fileParallelism === false)).toBe(true);
    expect(deterministicProjects.every((project) => project.test?.retry === undefined)).toBe(true);
  });

  // source-shape-contract: security -- Live projects must not inherit the deterministic drift-preflight bypass
  it("keeps the drift-preflight bypass out of live projects (#6692)", () => {
    const statefulProjects = projectConfigs().filter(
      (project) => !project.test?.setupFiles?.includes(FIXTURE_UMASK_SETUP),
    );
    const deterministicProjects = projectConfigs().filter((project) =>
      project.test?.setupFiles?.includes(FIXTURE_UMASK_SETUP),
    );

    expect((config as RootConfig).test?.env?.[DRIFT_PREFLIGHT_BYPASS]).toBeUndefined();
    for (const project of deterministicProjects) {
      expect(project.test?.env?.[DRIFT_PREFLIGHT_BYPASS], project.test?.name).toBe("1");
    }
    for (const project of statefulProjects) {
      expect(project.test?.env?.[DRIFT_PREFLIGHT_BYPASS], project.test?.name).toBeUndefined();
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

  it("uses the reusable workflow sentinel to collect branch validation tests", () => {
    const workflow = readYaml<BranchValidationWorkflow>(
      ".github/workflows/e2e-branch-validation.yaml",
    );
    const workflowSentinel = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.env?.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E !== undefined)
      ?.env?.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E;
    const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
    const listBranchValidation = (sentinel: string | undefined) =>
      spawnSync(
        process.execPath,
        [vitest, "list", "--project", "e2e-branch-validation", "--filesOnly", "--passWithNoTests"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            BREV_API_KEY: undefined,
            BREV_API_TOKEN: undefined,
            BREV_ORG_ID: undefined,
            NEMOCLAW_RUN_BRANCH_VALIDATION_E2E: sentinel,
          },
        },
      );

    const enabled = listBranchValidation(workflowSentinel);
    const disabled = listBranchValidation(undefined);
    expect(enabled.status, enabled.stderr || enabled.stdout).toBe(0);
    expect(enabled.stdout).toContain("[e2e-branch-validation]");
    expect(disabled.status, disabled.stderr || disabled.stdout).toBe(0);
    expect(disabled.stdout).not.toContain("[e2e-branch-validation]");
  });
});
