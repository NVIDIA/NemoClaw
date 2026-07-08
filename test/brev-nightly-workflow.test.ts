// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BREV_WORKFLOW_OWNERSHIP_ENV } from "../tools/e2e/brev-remote-vitest.mts";
import { readYaml } from "./helpers/e2e-workflow-contract";

type ReusableCallerJob = {
  env?: Record<string, unknown>;
  if?: string;
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

describe("Brev nightly workflow contract", () => {
  const nightly = readYaml<Workflow>(".github/workflows/brev-nightly-e2e.yaml");
  const branchValidation = readYaml<Workflow>(".github/workflows/e2e-branch-validation.yaml");

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

  it("grants the reusable workflow permission ceiling so GitHub can start the run", () => {
    expect(nightly.permissions).toEqual(branchValidation.permissions);
    expect(nightly.permissions).toEqual({
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
  });

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
      contents: "read",
      checks: "write",
      "pull-requests": "write",
    });
    expect(reporter?.if).toContain("inputs.pr_number != ''");
    expect(reporter?.steps?.[0]?.env?.TESTED_SHA).toBe(
      "${{ needs.e2e-branch-validation.outputs.tested_sha }}",
    );
    expect(reporter?.steps?.[0]?.env?.INSTANCE_NAME).toContain("inputs.test_suite");
    expect(reporter?.steps?.[0]?.run).toContain(
      "PR head moved after Brev validation; refusing to report stale evidence",
    );
    expect(reporter?.steps?.some((step) => step.uses?.includes("checkout"))).toBe(false);
    expect(JSON.stringify(reporter)).not.toMatch(/BREV_|NVIDIA_INFERENCE_API_KEY/);
  });

  it("keeps every suite in the nightly matrix in a distinct concurrency group", () => {
    expect(branchValidation.concurrency?.group).toContain("inputs.test_suite");
  });

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

  it("runs stateful messaging targets on separate fresh instances", () => {
    expect(nightly.jobs?.["brev-nightly-e2e"]?.strategy?.matrix?.test_suite).toEqual([
      "all",
      "messaging-providers",
      "messaging-compatible-endpoint",
      "full",
    ]);
    expect(branchValidation.jobs?.["e2e-branch-validation"]?.["timeout-minutes"]).toBe(130);
  });

  it("keeps failure diagnostics ahead of workflow-owned instance deletion", () => {
    const steps = branchValidation.jobs?.["e2e-branch-validation"]?.steps ?? [];
    const run = steps.find((step) => step.name === "Run ephemeral Brev E2E");
    const collect = steps.find((step) => step.name === "Collect Brev debug bundle on failure");
    const uploadDebug = steps.find((step) => step.name === "Upload Brev debug bundle on failure");
    const uploadLogs = steps.find((step) => step.name === "Upload test logs");
    const cleanup = steps.find((step) => step.name === "Delete Brev instance");

    expect(branchValidation.on?.workflow_call?.inputs?.keep_alive).toMatchObject({
      default: false,
    });
    expect(run?.env?.[BREV_WORKFLOW_OWNERSHIP_ENV]).toBe("1");
    expect(cleanup?.if).toBe("always() && !inputs.keep_alive");
    expect(cleanup?.env?.INSTANCE).toBe("${{ env.BREV_E2E_INSTANCE_NAME }}");
    expect(uploadDebug?.with?.name).toBe(
      "brev-debug-bundle-${{ inputs.test_suite }}-${{ github.run_attempt }}",
    );
    expect(uploadLogs?.with?.name).toBe(
      "e2e-branch-validation-logs-${{ inputs.test_suite }}-${{ github.run_attempt }}",
    );
    expect(cleanup?.run).toContain("for attempt in 1 2 3");
    expect(cleanup?.run).toContain('timeout 30s brev delete "$INSTANCE"');
    expect(cleanup?.run).toContain("timeout 30s brev ls --json");
    expect(cleanup?.run).toContain("timeout 30s brev refresh");
    expect(cleanup?.run).not.toMatch(/grep.*not found/);
    expect(steps.indexOf(cleanup as NonNullable<typeof cleanup>)).toBeGreaterThan(
      steps.indexOf(collect as NonNullable<typeof collect>),
    );
    expect(steps.indexOf(cleanup as NonNullable<typeof cleanup>)).toBeGreaterThan(
      steps.indexOf(uploadDebug as NonNullable<typeof uploadDebug>),
    );
    expect(steps.indexOf(cleanup as NonNullable<typeof cleanup>)).toBeGreaterThan(
      steps.indexOf(uploadLogs as NonNullable<typeof uploadLogs>),
    );
  });

  it("keeps manual dispatch inputs out of the Brev credential boundary", () => {
    const validation = branchValidation.jobs?.["e2e-branch-validation"];
    const install = validation?.steps?.find((step) => step.name === "Install Brev CLI");
    const run = validation?.steps?.find((step) => step.name === "Run ephemeral Brev E2E");

    expect(branchValidation.on?.workflow_dispatch?.inputs).not.toHaveProperty("brev_token");
    expect(install?.env?.BREV_API_TOKEN).toBe("${{ secrets.BREV_API_TOKEN }}");
    expect(run?.env?.BREV_API_TOKEN).toBe("${{ secrets.BREV_API_TOKEN }}");
    expect(JSON.stringify(validation)).not.toContain("inputs.brev_token");
  });

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
