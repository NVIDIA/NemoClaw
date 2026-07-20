// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
} from "../../helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/brev-launchable-qualification.yaml";
const E2E_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const CONTROLLER_PATH = "tools/e2e/exact-image-qualification-controller.mts";
const RUNTIME_PATH = "tools/e2e/brev-launchable-runtime.sh";
const FULL_E2E_PATH = "test/e2e/live/full-e2e.test.ts";
const ACTIVATION_VARIABLE = "NEMOCLAW_BREV_LAUNCHABLE_QUALIFICATION_ENABLED";

type QualificationWorkflow = Workflow & {
  name: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
};

function strings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const value = workflow.jobs[name];
  expect(value, `missing ${name} job`).toBeDefined();
  return value!;
}

// source-shape-contract: security -- Exact-image qualification must remain manual/reusable, protected, fixed-target, least-privilege, identity-gated, and cleanup-verifying
it("keeps exact-image Launchable qualification protected, reusable, and fail-closed", () => {
  const workflow = readYaml<QualificationWorkflow>(WORKFLOW_PATH);
  const e2eWorkflow = readYaml<Workflow>(E2E_WORKFLOW_PATH);
  const source = readRepoText(WORKFLOW_PATH);
  const controller = readRepoText(CONTROLLER_PATH);
  const runtime = readRepoText(RUNTIME_PATH);
  const fullE2e = readRepoText(FULL_E2E_PATH);
  const preflight = job(workflow, "preflight");
  const qualify = job(workflow, "qualify");
  const caller = job(e2eWorkflow, "staging-brev-launchable");
  const workflowStrings = strings(workflow);
  const steps = qualify.steps ?? [];
  const redactIndex = steps.findIndex((step) => step.name === "Redact runtime evidence");
  const uploadIndex = steps.findIndex(
    (step) => step.name === "Upload exact staging Launchable evidence",
  );

  expect(redactIndex).toBeGreaterThanOrEqual(0);
  expect(uploadIndex).toBeGreaterThan(redactIndex);
  const redact = steps[redactIndex]!;
  const upload = steps[uploadIndex]!;
  expect(redact.if).toBe("${{ always() && steps.workspace.outputs.work_dir != '' }}");
  expect(redact.env).toEqual({
    NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    WORK_DIR: "${{ steps.workspace.outputs.work_dir }}",
  });
  expect(redact.run).toContain('content.replace(secret, b"[REDACTED]")');
  expect(redact.run).toContain("os.scandir(directory)");
  expect(redact.run).toContain("child.is_symlink()");
  expect(redact.run).toContain("MAX_TOTAL_BYTES");
  expect(upload.if).toBe(
    "${{ always() && steps.workspace.outputs.work_dir != '' && steps.redact-runtime-evidence.outcome == 'success' }}",
  );
  for (const path of ["brev-launchable-e2e.log", "brev-launchable-cloud-openclaw"]) {
    expect(String(upload.with?.path), `retained evidence must include ${path}`).toContain(
      `/${path}`,
    );
  }

  expect(workflow.name).toBe("E2E / Exact Staging Brev Launchable");
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch", "workflow_call"]);
  expect(source).not.toMatch(/^\s+(?:push|schedule|workflow_run|pull_request):/mu);
  expect(Object.keys((workflow.on.workflow_dispatch as { inputs: object }).inputs)).toEqual([
    "candidate_sha",
    "reason",
  ]);
  expect(Object.keys((workflow.on.workflow_call as { inputs: object }).inputs)).toEqual([
    "candidate_sha",
    "reason",
  ]);
  expect((workflow.on.workflow_call as { secrets?: object }).secrets).toBeUndefined();
  expect(JSON.stringify(workflow.on)).not.toContain(ACTIVATION_VARIABLE);
  expect(workflow.permissions).toEqual({});
  expect(caller.secrets).toBeUndefined();
  expect(caller.if).toBe(
    `\${{ vars.${ACTIVATION_VARIABLE} == 'true' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha == '' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}`,
  );
  expect(caller.with?.candidate_sha).toBe("${{ github.sha }}");
  expect(workflow.concurrency).toEqual({
    group: "brev-launchable-qualification-staging-cpu",
    "cancel-in-progress": false,
  });

  expect(preflight.permissions).toEqual({ contents: "read" });
  expect(preflight.if).toBeUndefined();
  expect(preflight.environment).toBeUndefined();
  const activation = preflight.steps?.[0];
  expect(activation?.name).toBe("Require explicit repository activation");
  expect(activation?.uses).toBeUndefined();
  expect(activation?.env).toEqual({
    QUALIFICATION_ENABLED: `\${{ vars.${ACTIVATION_VARIABLE} }}`,
  });
  expect(activation?.run).toContain('[[ "$QUALIFICATION_ENABLED" != "true" ]]');
  expect(activation?.run).toContain(`${ACTIVATION_VARIABLE}=true`);
  expect(activation?.run).toContain("exit 1");
  expect(qualify.permissions).toEqual({ contents: "read" });
  expect(qualify.if).toBe(
    `\${{ vars.${ACTIVATION_VARIABLE} == 'true' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' }}`,
  );
  expect(qualify.environment).toEqual({
    name: "approve-brev-launchable-qualification",
    deployment: false,
  });
  const environmentJobs = Object.values(workflow.jobs).filter(
    (workflowJob) => workflowJob.environment !== undefined,
  );
  expect(environmentJobs).toEqual([qualify]);
  for (const environmentJob of environmentJobs) {
    expect(environmentJob.if).toContain(`vars.${ACTIVATION_VARIABLE} == 'true'`);
  }
  for (const secret of [
    "NEMOCLAW_IMAGE_DISPATCH_TOKEN",
    "BREV_API_KEY",
    "BREV_ORG_ID",
    "NVIDIA_INFERENCE_API_KEY",
  ]) {
    expect(JSON.stringify(preflight)).not.toContain(`secrets.${secret}`);
    expect(JSON.stringify(qualify)).toContain(`secrets.${secret}`);
  }
  expect(JSON.stringify(qualify)).toContain("NEMOCLAW_IMAGE_QUALIFICATION_TOKEN");
  expect(source.match(/secrets\.NEMOCLAW_IMAGE_DISPATCH_TOKEN/gu)).toHaveLength(4);
  expect(workflowStrings).not.toContain("id-token: write");
  expect(source).not.toMatch(/npm (?:ci|install)/u);
  for (const step of [...(preflight.steps ?? []), ...(qualify.steps ?? [])]) {
    expect(step.run ?? "").not.toContain("${{ inputs.");
  }

  const actionUses = workflowStrings.filter((value) => value.startsWith("actions/"));
  expect(actionUses.length).toBeGreaterThan(0);
  for (const use of actionUses) expect(use).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/u);
  for (const checkout of qualify.steps?.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  ) ?? []) {
    expect(checkout.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
  }

  expect(controller).toContain('export const PRODUCER_REPOSITORY = "brevdev/nemoclaw-image"');
  expect(controller).toContain(
    'export const PRODUCER_WORKFLOW_FILE = "build-qualification-image.yml"',
  );
  expect(controller).toContain('export const PRODUCER_REF = "main"');
  expect(controller).toContain('request.ref !== "refs/heads/main"');
  expect(controller).toContain("request.candidateSha !== request.workflowSha");
  expect(controller).toContain('export const GITHUB_API_VERSION = "2026-03-10"');
  expect(controller).toContain("return_run_details: true");
  expect(controller).toContain("fs.renameSync(temporary, file)");
  expect(controller).not.toMatch(/actions\/runs\?/u);
  expect(controller).toContain("actions/workflows/${PRODUCER_WORKFLOW_FILE}/runs");

  const validate = qualify.steps?.find((step) => step.name === "Validate the exact image manifest");
  expect(validate?.run).toContain("tools/e2e/validate-exact-image-manifest.mts");
  for (const flag of [
    "--nemoclaw-sha",
    "--requester-run-id",
    "--requester-run-attempt",
    "--correlation-id",
    "--image-repository-sha",
    "--producer-run-id",
    "--producer-run-attempt",
  ]) {
    expect(validate?.run).toContain(flag);
  }

  expect(source).toContain("retention-days: 90");
  expect(source).toContain("if-no-files-found: error");
  expect(source).toContain("dispatch-intent.v1.json");
  expect(source).toContain("dispatch-reconciliation.v1.json");
  expect(source).toContain("controller-state.corrupt-*.json");
  expect(source).toContain("--mode finalize");
  expect(runtime).toContain("brev create");
  expect(runtime).toContain("--launchable");
  expect(runtime).toContain("test/e2e/live/full-e2e.test.ts");
  expect(runtime).toContain("NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable");
  expect(runtime).toContain("NEMOCLAW_E2E_SECURITY_POSTURE=1");
  expect(runtime).toContain("diff --quiet --no-ext-diff HEAD --");
  expect(runtime).toContain("validate_copied_artifact_tree");
  expect(runtime).toContain("targetResultSha256");
  expect(runtime).toContain("firstAgentTurn");
  expect(runtime).not.toContain("brev-quickstart");
  expect(fullE2e).toContain('host.command("brev-quickstart"');
  expect(fullE2e).toContain('"brev-launchable-cloud-openclaw"');
  expect(fullE2e).toContain("assertFirstAgentTurn({ apiKey: hosted.apiKey, sandbox })");
  expect(fullE2e).toMatch(
    /expect\(assistantReply,[\s\S]{0,200}\)\.toBe\(\s*EXPECTED_FIRST_REPLY,\s*\);/u,
  );
  expect(fullE2e).toContain("firstAgentTurn:");
  expect(source).not.toContain("test/e2e/live/exact-staging-launchable.test.ts");
  expect(source).toContain("brev-launchable-runtime.sh deploy");
  expect(source).toContain("brev-launchable-runtime.sh qualify");
  expect(source).toContain("brev-launchable-runtime.sh cleanup");
  expect(source).toContain("brev-launchable-cloud-openclaw/");
  expect(source).toContain("brev-cleanup-evidence.json");
  expect(source).toContain("NEMOCLAW_STAGING_LAUNCHABLE_ID");
  expect(source).not.toContain("image_family");
});

it("recursively redacts nested runtime evidence and rejects symlinks before upload", () => {
  const workflow = readYaml<QualificationWorkflow>(WORKFLOW_PATH);
  const redact = job(workflow, "qualify").steps?.find(
    (step) => step.id === "redact-runtime-evidence",
  );
  const script = redact?.run as string;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-evidence-redaction-"));
  const secret = "nvapi-nested-secret";

  try {
    const nested = path.join(root, "brev-launchable-cloud-openclaw", "target", "raw.log");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, `before ${secret} after\n`);
    const redacted = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: secret, WORK_DIR: root },
    });
    expect(redacted.status, redacted.stderr).toBe(0);
    expect(fs.readFileSync(nested, "utf8")).toBe("before [REDACTED] after\n");

    fs.symlinkSync(nested, path.join(root, "untrusted-link"));
    const rejected = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, NVIDIA_INFERENCE_API_KEY: secret, WORK_DIR: root },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("must not contain symlinks");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
