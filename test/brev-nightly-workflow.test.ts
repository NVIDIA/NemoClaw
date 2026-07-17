// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BREV_WORKFLOW_OWNERSHIP_ENV } from "../tools/e2e/brev-remote-vitest.mts";
import { readYaml } from "./helpers/e2e-workflow-contract";

type ReusableCallerJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "timeout-minutes"?: number;
  steps?: Array<{
    env?: Record<string, unknown>;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
  }>;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  strategy?: {
    matrix?: {
      test_suite?: string[];
    };
  };
};

type Workflow = {
  concurrency?: { group?: string };
  permissions?: Record<string, string>;
  on?: {
    workflow_call?: {
      inputs?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    };
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
  jobs?: Record<string, ReusableCallerJob>;
};

const TESTED_SHA = "a".repeat(40);

function runReporter(script: string, jobResponse: unknown, failJobLookup = false) {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-brev-reporter-"));
  const binDirectory = join(directory, "bin");
  const fakeGh = join(binDirectory, "gh");
  const checkArgsPath = join(directory, "check-args");
  const commentPath = join(directory, "comment.md");
  const runUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
  try {
    mkdirSync(binDirectory);
    writeFileSync(
      fakeGh,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "$1" == "pr" && "$2" == "view" ]]; then',
        `  printf '%s\\n' '{"headRefName":"feature/test","headRefOid":"${TESTED_SHA}"}'`,
        'elif [[ "$1" == "api" && "$2" == *"/actions/runs/123/attempts/2/jobs?per_page=100" ]]; then',
        '  [[ "${FAKE_JOBS_FAIL:-0}" != "1" ]] || exit 1',
        "  printf '%s' \"$FAKE_JOBS_JSON\"",
        'elif [[ "$1" == "api" && "$2" == "repos/$GITHUB_REPOSITORY/check-runs" ]]; then',
        '  printf \'%s\\0\' "$@" > "$FAKE_CHECK_ARGS"',
        'elif [[ "$1" == "pr" && "$2" == "comment" ]]; then',
        "  shift 2",
        '  while [[ "$#" -gt 0 ]]; do',
        '    if [[ "$1" == "--body-file" ]]; then',
        '      cp "$2" "$FAKE_COMMENT"',
        "      exit 0",
        "    fi",
        "    shift",
        "  done",
        "  exit 1",
        "else",
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(fakeGh, 0o700);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        FAKE_CHECK_ARGS: checkArgsPath,
        FAKE_COMMENT: commentPath,
        FAKE_JOBS_FAIL: failJobLookup ? "1" : "0",
        FAKE_JOBS_JSON: JSON.stringify(jobResponse),
        GH_TOKEN: "token",
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        INSTANCE_NAME: "e2e-42-full-123-2",
        KEEP_ALIVE: "false",
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        PR_NUMBER: "42",
        RUN_ATTEMPT: "2",
        RUN_ID: "123",
        RUN_URL: runUrl,
        TESTED_SHA,
        TEST_SUITE: "full",
        VALIDATION_RESULT: "failure",
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return {
      checkArgs: readFileSync(checkArgsPath, "utf8").split("\0").filter(Boolean),
      comment: readFileSync(commentPath, "utf8"),
      runUrl,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe("Brev nightly workflow contract", () => {
  const nightly = readYaml<Workflow>(".github/workflows/brev-nightly-e2e.yaml");
  const branchValidation = readYaml<Workflow>(".github/workflows/e2e-branch-validation.yaml");

  // source-shape-contract: compatibility -- Caller arguments must remain within the reusable branch-validation interface
  it("passes only declared inputs and secrets to branch validation", () => {
    const declaredInputs = new Set(Object.keys(branchValidation.on?.workflow_call?.inputs ?? {}));
    const declaredSecrets = new Set(Object.keys(branchValidation.on?.workflow_call?.secrets ?? {}));
    const callerJobs = Object.entries(nightly.jobs ?? {}).filter(
      ([, job]) => job.uses === "./.github/workflows/e2e-branch-validation.yaml",
    );

    expect(callerJobs.length).toBeGreaterThan(0);
    for (const [jobName, job] of callerJobs) {
      const unknownInputs = Object.keys(job.with ?? {}).filter((name) => !declaredInputs.has(name));
      const unknownSecrets = Object.keys(job.secrets ?? {}).filter(
        (name) => !declaredSecrets.has(name),
      );

      expect(unknownInputs, `${jobName} passes unsupported reusable workflow inputs`).toEqual([]);
      expect(unknownSecrets, `${jobName} passes unsupported reusable workflow secrets`).toEqual([]);
    }
  });

  // source-shape-contract: security -- Caller permissions must equal the reviewed reusable-workflow write ceiling
  it("grants the reusable workflow permission ceiling so GitHub can start the run", () => {
    expect(nightly.permissions).toEqual(branchValidation.permissions);
    expect(nightly.permissions).toEqual({
      actions: "read",
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
  });

  // source-shape-contract: security -- Secret-bearing validation stays read-only while reporting writes remain isolated
  it("keeps write permissions out of the secret-bearing target-branch job", () => {
    const caller = nightly.jobs?.["brev-nightly-e2e"];
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const reporter = branchValidation.jobs?.["report-pr"];
    const checkout = validation?.steps?.find((step) => step.name === "Checkout target branch");
    const resolveBranch = validation?.steps?.find(
      (step) => step.name === "Resolve branch from PR number",
    );
    const recordRevision = validation?.steps?.find(
      (step) => step.name === "Record exact tested revision",
    );

    expect(nightly.on?.workflow_dispatch?.inputs).not.toHaveProperty("branch");
    expect(caller?.with?.branch).toBe("${{ github.ref_name }}");
    expect(validation?.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(resolveBranch?.env?.PR_NUMBER).toBe("${{ inputs.pr_number }}");
    expect(resolveBranch?.run).not.toContain("gh pr view ${{");
    expect(validation?.outputs?.tested_sha).toBe("${{ steps.tested-ref.outputs.sha }}");
    expect(recordRevision?.run).toContain("git rev-parse HEAD");
    expect(validation?.env?.BREV_E2E_INSTANCE_NAME).toContain("inputs.test_suite");
    expect(reporter?.permissions).toEqual({
      actions: "read",
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
    expect(reporter?.if).toContain("inputs.pr_number != ''");
    const publish = reporter?.steps?.find(
      (step) => step.name === "Publish completed check and PR comment",
    );
    expect(publish?.env?.TESTED_SHA).toBe("${{ needs.e2e-branch-validation.outputs.tested_sha }}");
    expect(publish?.env?.INSTANCE_NAME).toContain("inputs.test_suite");
    expect(publish?.env?.RUN_ID).toBe("${{ github.run_id }}");
    expect(publish?.env?.RUN_ATTEMPT).toBe("${{ github.run_attempt }}");
    // The publisher runs from the trusted helper; stale-SHA rejection, PR-number
    // validation, and job-link resolution are covered by
    // test/e2e/support/brev-lifecycle.test.ts.
    expect(publish?.run).toContain("tools/e2e/brev-lifecycle.mts report-pr");

    // The reporter checks out only the trusted workflow revision, never target
    // code, and pins every action it uses.
    const reporterCheckout = reporter?.steps?.find((step) => step.uses?.includes("checkout"));
    expect(reporterCheckout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(reporterCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(reporterCheckout?.with?.path).toBeUndefined();
    for (const step of reporter?.steps ?? []) {
      if (step.uses)
        expect(step.uses, `${step.name} must pin its action`).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(JSON.stringify(reporter)).not.toContain("inputs.branch");
    expect(JSON.stringify(reporter)).not.toMatch(/BREV_|NVIDIA_INFERENCE_API_KEY/);
  });

  // source-shape-contract: compatibility -- The check must still deep-link the validated job (#6978)
  it("gives the reporter the run identity it needs to link the validated job", () => {
    const publish = branchValidation.jobs?.["report-pr"]?.steps?.find(
      (step) => step.name === "Publish completed check and PR comment",
    );

    // resolveValidationJobUrl consumes these; its matching rules and run-URL
    // fallback are covered directly in test/e2e/support/brev-lifecycle.test.ts.
    expect(publish?.env?.RUN_ID).toBe("${{ github.run_id }}");
    expect(publish?.env?.RUN_ATTEMPT).toBe("${{ github.run_attempt }}");
    expect(publish?.env?.RUN_URL).toBe(
      "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    );
    expect(branchValidation.jobs?.["report-pr"]?.permissions?.actions).toBe("read");
  });

  // source-shape-contract: security -- Suite validation must reject unsupported input before any target checkout
  it("fails closed on unsupported reusable test-suite values before checkout", () => {
    const steps = branchValidation.jobs?.["e2e-branch-validation"]?.steps ?? [];
    const validation = steps.find((step) => step.name === "Validate test suite");
    const checkout = steps.find((step) => step.name === "Checkout target branch");

    expect(validation?.env?.TEST_SUITE).toBe("${{ inputs.test_suite }}");
    expect(validation?.run).toContain(
      "full|credential-sanitization|telegram-injection|messaging-providers|messaging-compatible-endpoint|dashboard-remote-bind|gpu|all",
    );
    expect(validation?.run).toContain("exit 1");
    expect(steps.indexOf(validation as NonNullable<typeof validation>)).toBeLessThan(
      steps.indexOf(checkout as NonNullable<typeof checkout>),
    );
  });

  // source-shape-contract: security -- Ownership and keep-alive guards prevent deleting contributor-managed Brev instances
  it("keeps instance deletion inside the workflow ownership boundary", () => {
    const steps = branchValidation.jobs?.["e2e-branch-validation"]?.steps ?? [];
    const run = steps.find((step) => step.name === "Run ephemeral Brev E2E");
    const cleanupJob = branchValidation.jobs?.["cleanup-brev-instance"];
    const cleanup = cleanupJob?.steps?.find((step) => step.name === "Delete Brev instance");

    expect(branchValidation.on?.workflow_call?.inputs?.keep_alive).toMatchObject({
      default: false,
    });
    expect(run?.env?.[BREV_WORKFLOW_OWNERSHIP_ENV]).toBe("1");

    // Teardown runs in its own job, after target code has executed, so it must
    // not live in the validation workspace at all.
    expect(steps.some((step) => step.name === "Delete Brev instance")).toBe(false);
    expect(cleanupJob?.if).toBe("always() && !inputs.keep_alive");
    expect(cleanupJob?.needs).toBe("e2e-branch-validation");
    expect(cleanup?.env?.INSTANCE_NAME).toBe("${{ env.BREV_E2E_INSTANCE_NAME }}");
    expect(cleanup?.run).toContain("tools/e2e/brev-lifecycle.mts delete-instance");

    // The cleanup job checks out only the trusted revision and never target code.
    const cleanupCheckout = cleanupJob?.steps?.find((step) => step.uses?.includes("checkout"));
    expect(cleanupCheckout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(cleanupCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(JSON.stringify(cleanupJob)).not.toContain("inputs.branch");
    expect(cleanupJob?.permissions).toEqual({ contents: "read" });
  });

  // source-shape-contract: security -- Brev credentials must originate only from repository secrets
  it("keeps manual dispatch inputs out of the Brev credential boundary", () => {
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const install = validation?.steps?.find((step) => step.name === "Install Brev CLI");
    const run = validation?.steps?.find((step) => step.name === "Run ephemeral Brev E2E");

    expect(branchValidation.on?.workflow_dispatch?.inputs).not.toHaveProperty("brev_token");
    expect(install?.env?.BREV_API_TOKEN).toBe("${{ secrets.BREV_API_TOKEN }}");
    expect(run?.env?.BREV_API_TOKEN).toBe("${{ secrets.BREV_API_TOKEN }}");
    expect(JSON.stringify(validation)).not.toContain("inputs.brev_token");
  });

  // source-shape-contract: security -- Exact Brev archive integrity must be verified before executable extraction
  it("verifies the pinned Brev CLI digest before extracting it", () => {
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const install = validation?.steps?.find((step) => step.name === "Install Brev CLI");
    const script = install?.run ?? "";

    expect(install?.env?.BREV_CLI_VERSION).toBe("0.6.324");
    expect(install?.env?.BREV_CLI_SHA256).toBe(
      "c7056c17d4810134e3fe7194c233619b1b888a640df1929ea7c6f69c0425e58c",
    );
    expect(script).toContain("releases/download/v${BREV_CLI_VERSION}");
    expect(script).toContain("brev-cli_${BREV_CLI_VERSION}_linux_amd64.tar.gz");
    expect(script).toContain("sha256sum -c -");
    expect(script.indexOf("sha256sum -c -")).toBeGreaterThan(script.indexOf("curl -fsSL"));
    expect(script.indexOf("tar -xzf")).toBeGreaterThan(script.indexOf("sha256sum -c -"));
  });

  // source-shape-contract: security -- Removed launchable inputs must not restore remote setup-script execution
  it("does not expose stale published-launchable controls", () => {
    const dispatchInputs = Object.keys(nightly.on?.workflow_dispatch?.inputs ?? {});
    const reusableInputs = Object.keys(branchValidation.on?.workflow_call?.inputs ?? {});
    const callerInputs = Object.values(nightly.jobs ?? {}).flatMap((job) =>
      Object.keys(job.with ?? {}),
    );
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const run = validation?.steps?.find((step) => step.name === "Run ephemeral Brev E2E");

    expect(dispatchInputs).not.toContain("launchable_id");
    expect(reusableInputs).not.toContain("setup_script_url");
    expect(callerInputs).not.toContain("launchable_id");
    expect(callerInputs).not.toContain("use_published_launchable");
    expect(run?.env).not.toHaveProperty("LAUNCHABLE_SETUP_SCRIPT");
  });
});
