// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validatePrReviewAdvisorWorkflowBoundary } from "../tools/pr-review-advisor/workflow-boundary.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/pr-review-advisor.yaml");
const OPENSHELL_POLICY_PATH = path.join(
  ROOT,
  "tools",
  "pr-review-advisor",
  "openshell-policy.yaml",
);
function workflowSource(): string {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

function mutateWorkflowSource(
  source: string,
  mutate: (workflow: Record<string, any>) => void,
): string {
  const workflow = YAML.parse(source) as Record<string, any>;
  mutate(workflow);
  return YAML.stringify(workflow);
}

function validateMutation(mutate: (source: string) => string): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-boundary-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  fs.writeFileSync(workflowPath, mutate(workflowSource()));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function validatePolicyMutation(mutate: (policy: Record<string, any>) => void): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-advisor-policy-"));
  const policyPath = path.join(tmp, "openshell-policy.yaml");
  const policy = YAML.parse(fs.readFileSync(OPENSHELL_POLICY_PATH, "utf8")) as Record<string, any>;
  mutate(policy);
  fs.writeFileSync(policyPath, YAML.stringify(policy));
  try {
    return validatePrReviewAdvisorWorkflowBoundary(
      WORKFLOW_PATH,
      path.join(ROOT, "package-lock.json"),
      policyPath,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("PR review advisor OpenShell workflow boundary", () => {
  // source-shape-contract: compatibility -- The selected target identity must reach host metadata preparation and the credential-free sandbox
  it("binds host-prepared GitHub context to the selected repository and pull request", () => {
    const workflow = YAML.parse(workflowSource()) as Record<string, any>;
    expect(workflow.jobs.review.env.TARGET_REPO).toBe(
      "${{ github.event_name == 'pull_request_target' && github.repository || inputs.target_repo || github.repository }}",
    );
    expect(workflow.jobs.review.env.PR_NUMBER).toBe(
      "${{ github.event.pull_request.number || inputs.target_pr }}",
    );

    const missingIdentity = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        delete mutated.jobs.review.env.TARGET_REPO;
        delete mutated.jobs.review.env.PR_NUMBER;
      }),
    );
    expect(missingIdentity).toEqual(
      expect.arrayContaining([
        "review job env.TARGET_REPO must be ${{ github.event_name == 'pull_request_target' && github.repository || inputs.target_repo || github.repository }}",
        "review job env.PR_NUMBER must be ${{ github.event.pull_request.number || inputs.target_pr }}",
      ]),
    );
  });

  // source-shape-contract: security -- Executed and mounted trusted code plus the fallback PR worktree must stay on their pinned checkout paths
  it("pins trusted helper and bind sources to their checkout directories", () => {
    const workflow = YAML.parse(workflowSource()) as Record<string, any>;
    const defaultWorkdir = workflow.jobs.review.steps.find(
      (step: { name?: string }) => step.name === "Set default advisor workdir",
    );
    expect(workflow.jobs.review.env.ADVISOR_DIR).toBe("${{ github.workspace }}/advisor");
    expect(workflow.jobs.publish.env.ADVISOR_DIR).toBe("${{ github.workspace }}/advisor");
    expect(defaultWorkdir).toMatchObject({
      if: "${{ github.event_name == 'workflow_dispatch' && inputs.target_repo == '' && inputs.target_pr == '' }}",
      run: 'echo "ADVISOR_WORKDIR=$GITHUB_WORKSPACE/pr-workdir" >> "$GITHUB_ENV"',
    });

    const detachedSources = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        mutated.jobs.review.env.ADVISOR_DIR = "${{ github.workspace }}/pr-workdir/advisor";
        mutated.jobs.publish.env.ADVISOR_DIR = "${{ github.workspace }}/publish-artifacts/advisor";
        const defaultWorkdir = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Set default advisor workdir",
        );
        defaultWorkdir.if = "${{ always() }}";
        defaultWorkdir.run = 'echo "ADVISOR_WORKDIR=$GITHUB_WORKSPACE/advisor" >> "$GITHUB_ENV"';
      }),
    );
    expect(detachedSources).toEqual(
      expect.arrayContaining([
        "review job env.ADVISOR_DIR must be ${{ github.workspace }}/advisor",
        "publish job env.ADVISOR_DIR must be ${{ github.workspace }}/advisor",
        "Set default advisor workdir must use the canonical dispatch-only condition",
        "Set default advisor workdir must bind ADVISOR_WORKDIR to the fixed pr-workdir checkout",
      ]),
    );
  });

  // source-shape-contract: security -- GitHub and model credentials must remain confined to distinct trusted host steps
  it("keeps GitHub and upstream model credentials in separate host-only steps", () => {
    const workflow = YAML.parse(workflowSource()) as Record<string, any>;
    const steps = workflow.jobs.review.steps as Array<Record<string, any>>;
    const prepareInputs = steps.find((step) => step.name === "Prepare advisor sandbox inputs");
    const configure = steps.find((step) => step.name === "Configure OpenShell inference");
    const install = steps.find((step) => step.name === "Install OpenShell");
    const unavailable = steps.find((step) => step.name === "Write unavailable advisor artifacts");
    expect(prepareInputs?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(configure?.id).toBe("configure-openshell");
    expect(configure?.["continue-on-error"]).toBe(true);
    expect(install?.if).toBe("${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS == '1' }}");
    expect(configure?.if).toBe("${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS == '1' }}");
    expect(configure?.env).toEqual({
      OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    });
    expect(unavailable).toMatchObject({
      id: "unavailable-analysis",
      if: "${{ always() && steps.configure-openshell.outcome != 'success' }}",
      env: {
        BASE_REF: expect.any(String),
        HEAD_REF: expect.any(String),
        PR_REVIEW_ADVISOR_UNAVAILABLE_REASON:
          "${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS == '0' && 'PR_REVIEW_ADVISOR_RUN_ANALYSIS=0' || 'OpenShell inference configuration failed or the advisor credential is unavailable' }}",
      },
      run: 'node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" unavailable',
    });
    for (const name of [
      "Write unavailable advisor artifacts",
      "Create credential-free advisor sandbox",
      "Run PR review advisor",
      "Download advisor artifacts from sandbox",
      "Delete advisor sandbox",
    ]) {
      const serialized = JSON.stringify(steps.find((step) => step.name === name));
      expect(serialized, name).not.toContain("${{ github.token }}");
      expect(serialized, name).not.toContain("${{ secrets.");
    }

    const inheritedCredentials = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        mutated.jobs.review.env.GH_TOKEN = "${{ github.token }}";
        mutated.jobs.review.env.PR_REVIEW_ADVISOR_API_KEY =
          "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}";
      }),
    );
    expect(inheritedCredentials).toContain(
      "review job-level environment must not expose GitHub or model credentials",
    );

    const duplicateGitHubToken = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        const create = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Create credential-free advisor sandbox",
        );
        create.env = { GH_TOKEN: "${{ github.token }}" };
      }),
    );
    expect(duplicateGitHubToken).toEqual(
      expect.arrayContaining([
        "only advisor sandbox input preparation may receive github.token",
        "step 'Create credential-free advisor sandbox' must remain credential-free after OpenShell configuration",
      ]),
    );

    const indirectCredential = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        const create = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Create credential-free advisor sandbox",
        );
        create.env = { GH_TOKEN: "${{ env.FORWARDED_TOKEN }}" };
      }),
    );
    expect(indirectCredential).toContain(
      "step 'Create credential-free advisor sandbox' must remain credential-free after OpenShell configuration",
    );

    const bracketTokenExpression = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        const create = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Create credential-free advisor sandbox",
        );
        create.env = { FORWARDED_TOKEN: "${{ github['token'] }}" };
      }),
    );
    expect(bracketTokenExpression).toEqual(
      expect.arrayContaining([
        "only advisor sandbox input preparation may receive github.token",
        "step 'Create credential-free advisor sandbox' must remain credential-free after OpenShell configuration",
      ]),
    );

    const duplicateModelSecret = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        const download = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Download advisor artifacts from sandbox",
        );
        download.env = {
          OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
        };
      }),
    );
    expect(duplicateModelSecret).toEqual(
      expect.arrayContaining([
        "only OpenShell provider configuration may receive the advisor model credential",
        "step 'Download advisor artifacts from sandbox' must remain credential-free after OpenShell configuration",
      ]),
    );

    const combinedSecrets = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        const configureStep = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Configure OpenShell inference",
        );
        configureStep.env.GH_TOKEN = "${{ github.token }}";
        const prepareStep = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Prepare advisor sandbox inputs",
        );
        prepareStep.env.OPENAI_API_KEY = "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}";
      }),
    );
    expect(combinedSecrets).toEqual(
      expect.arrayContaining([
        "Prepare advisor sandbox inputs must receive only github.token",
        "Configure OpenShell inference must receive only secrets.PR_REVIEW_ADVISOR_API_KEY as OPENAI_API_KEY",
        "only OpenShell provider configuration may receive the advisor model credential",
        "only advisor sandbox input preparation may receive github.token",
      ]),
    );
  });

  // source-shape-contract: compatibility -- Manual dry runs must skip inference setup while retaining an auditable unavailable artifact
  it("preserves credential-free unavailable artifacts for manual dry runs", () => {
    const workflow = YAML.parse(workflowSource()) as Record<string, any>;
    expect(workflow.jobs.review.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.run_analysis == false && '0' || '1' }}",
    );

    const verify = workflow.jobs.review.steps.find(
      (step: { name?: string }) => step.name === "Verify advisor analysis outcome",
    );
    expect(verify.env.ANALYSIS_REQUESTED).toBe("${{ env.PR_REVIEW_ADVISOR_RUN_ANALYSIS }}");
    expect(verify.run).toContain('if [ "$ANALYSIS_REQUESTED" = "0" ]');

    const weakenedDryRun = validateMutation((source) =>
      mutateWorkflowSource(source, (mutated) => {
        mutated.jobs.review.env.PR_REVIEW_ADVISOR_RUN_ANALYSIS = "1";
        const install = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Install OpenShell",
        );
        const configure = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Configure OpenShell inference",
        );
        const unavailable = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Write unavailable advisor artifacts",
        );
        const outcome = mutated.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Verify advisor analysis outcome",
        );
        delete install.if;
        delete configure.if;
        unavailable.if = "${{ steps.configure-openshell.outcome != 'success' }}";
        unavailable.env.PR_REVIEW_ADVISOR_UNAVAILABLE_REASON = "configuration failed";
        outcome.env.ANALYSIS_REQUESTED = "1";
        outcome.run = outcome.run.replace(
          'if [ "$ANALYSIS_REQUESTED" = "0" ]; then',
          'if [ "$ANALYSIS_REQUESTED" = "1" ]; then',
        );
      }),
    );
    expect(weakenedDryRun).toEqual(
      expect.arrayContaining([
        "review job env.PR_REVIEW_ADVISOR_RUN_ANALYSIS must be ${{ github.event_name == 'workflow_dispatch' && inputs.run_analysis == false && '0' || '1' }}",
        "Install OpenShell must run only when advisor analysis is requested",
        "Configure OpenShell inference must run only when advisor analysis is requested",
        "Write unavailable advisor artifacts must run after skipped or failed configuration",
        "Write unavailable advisor artifacts must receive only refs and the canonical unavailable reason",
        'step \'Verify advisor analysis outcome\' run script must include if [ "$ANALYSIS_REQUESTED" = "0" ]',
        "Verify advisor analysis outcome must use the trusted analysis request selector",
      ]),
    );
  });

  it("pins the OpenShell image, loopback gateway, and per-lane sandbox identity", () => {
    const errors = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        workflow.jobs.review.env.OPENSHELL_GATEWAY_ENDPOINT = "http://gateway.example:8080";
        workflow.jobs.review.env.PI_IMAGE =
          "ghcr.io/nvidia/openshell-community/sandboxes/pi:latest";
        workflow.jobs.review.env.SANDBOX_NAME = "pr-advisor";
        workflow.jobs.review.strategy.matrix.advisor[0].artifact_dir = "../../advisor";
        const prepare = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Prepare isolated analysis workspace",
        );
        prepare.env.TARGET_DIR = "/tmp/pr-workdir";
      }),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        "review job env.OPENSHELL_GATEWAY_ENDPOINT must be http://127.0.0.1:8080",
        "review job env.PI_IMAGE must be ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd",
        "review job env.SANDBOX_NAME must be pr-advisor-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.advisor.id }}",
        "advisor matrix entry 1 artifact_dir must be a simple directory name",
        "Prepare isolated analysis workspace must use the fixed pr-workdir upload directory",
      ]),
    );
  });

  it("downloads sandbox artifacts before upload and always deletes the sandbox", () => {
    const weakenedDownload = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const download = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Download advisor artifacts from sandbox",
        );
        download.id = "untrusted-download";
        download.if = "success()";
        download["continue-on-error"] = false;
        download.run =
          'node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" run';
      }),
    );
    expect(weakenedDownload).toEqual(
      expect.arrayContaining([
        "Download advisor artifacts from sandbox id must be download-analysis",
        "Download advisor artifacts from sandbox must run after every configured sandbox analysis",
        "Download advisor artifacts from sandbox must continue-on-error until artifacts are uploaded",
        "step 'Download advisor artifacts from sandbox' must use the canonical trusted OpenShell helper command",
      ]),
    );

    const weakenedCleanup = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const cleanup = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Delete advisor sandbox",
        );
        cleanup.if = "success()";
        cleanup.run =
          'node --experimental-strip-types --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/openshell.mts" create';
      }),
    );
    expect(weakenedCleanup).toEqual(
      expect.arrayContaining([
        "Delete advisor sandbox must run always",
        "step 'Delete advisor sandbox' must use the canonical trusted OpenShell helper command",
      ]),
    );

    const detachedOutcome = validateMutation((source) =>
      mutateWorkflowSource(source, (workflow) => {
        const verify = workflow.jobs.review.steps.find(
          (step: { name?: string }) => step.name === "Verify advisor analysis outcome",
        );
        verify.env.DOWNLOAD_OUTCOME = "${{ steps.analysis.outcome }}";
        verify.env.CONFIGURE_OUTCOME = "${{ steps.analysis.outcome }}";
        verify.env.UNAVAILABLE_OUTCOME = "${{ steps.analysis.outcome }}";
      }),
    );
    expect(detachedOutcome).toEqual(
      expect.arrayContaining([
        "Verify advisor analysis outcome must use the trusted sandbox download outcome",
        "Verify advisor analysis outcome must use the trusted configuration step outcome",
        "Verify advisor analysis outcome must use the trusted unavailable step outcome",
      ]),
    );
  });

  // source-shape-contract: security -- The no-egress hard-Landlock policy must keep mounted inputs immutable and isolate runtime writes
  it("fails closed around the credential-free OpenShell filesystem and network boundary", () => {
    const network = validatePolicyMutation((policy) => {
      policy.network_policies = {
        internet: { endpoints: ["https://example.com"] },
      };
    });
    expect(network).toContain("advisor OpenShell policy must not allow direct network egress");

    const writableTrustedInputs = validatePolicyMutation((policy) => {
      policy.filesystem_policy.read_write = ["/dev", "/advisor", "/pr-workdir"];
    });
    expect(writableTrustedInputs).toEqual(
      expect.arrayContaining([
        "advisor OpenShell policy must retain only its writable runtime subtree",
        "advisor OpenShell policy must not grant write access to /advisor",
        "advisor OpenShell policy must not grant write access to /pr-workdir",
      ]),
    );

    const extraWritablePath = validatePolicyMutation((policy) => {
      policy.filesystem_policy.read_write.push("/sandbox");
    });
    expect(extraWritablePath).toContain(
      "advisor OpenShell policy must not grant write access to /sandbox",
    );

    const broadReadPath = validatePolicyMutation((policy) => {
      policy.filesystem_policy.read_only.push("/");
    });
    expect(broadReadPath).toContain("advisor OpenShell policy must not grant read access to /");

    const missingInputAndRuntimeOrLandlock = validatePolicyMutation((policy) => {
      policy.filesystem_policy.read_only = policy.filesystem_policy.read_only.filter(
        (entry: string) => entry !== "/advisor",
      );
      policy.filesystem_policy.read_write = policy.filesystem_policy.read_write.filter(
        (entry: string) => entry !== "/sandbox/pr-review-advisor-runtime",
      );
      policy.landlock.compatibility = "best_effort";
    });
    expect(missingInputAndRuntimeOrLandlock).toEqual(
      expect.arrayContaining([
        "advisor OpenShell policy must grant read-only access to /advisor",
        "advisor OpenShell policy must retain only its writable runtime subtree",
        "advisor OpenShell policy must fail closed when Landlock is unavailable",
      ]),
    );
  });
});
