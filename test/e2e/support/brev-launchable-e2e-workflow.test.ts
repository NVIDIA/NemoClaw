// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { readRepoText, readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

const E2E_WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const RUNTIME_PATH = "tools/e2e/brev-launchable-runtime.sh";
const FULL_E2E_PATH = "test/e2e/live/full-e2e.test.ts";

function job(workflow: Workflow, name: string) {
  const value = workflow.jobs[name];
  expect(value, `missing ${name} job`).toBeDefined();
  return value!;
}

// source-shape-contract: security -- The exact-image Launchable path stays a single trusted E2E job with immutable identity proof and terminal cleanup
it("keeps exact-image Launchable coverage inside the existing E2E workflow", () => {
  const workflow = readYaml<Workflow>(E2E_WORKFLOW_PATH);
  const source = readRepoText(E2E_WORKFLOW_PATH);
  const runtime = readRepoText(RUNTIME_PATH);
  const fullE2e = readRepoText(FULL_E2E_PATH);
  const launchable = job(workflow, "staging-brev-launchable");
  const steps = launchable.steps ?? [];

  expect(fs.existsSync(".github/workflows/brev-launchable-qualification.yaml")).toBe(false);
  expect(fs.existsSync("tools/e2e/exact-image-qualification-controller.mts")).toBe(false);
  expect(fs.existsSync("tools/e2e/exact-image-manifest.mts")).toBe(false);
  expect(launchable["runs-on"]).toBe("ubuntu-latest");
  expect(launchable["timeout-minutes"]).toBe(120);
  expect(launchable.permissions).toEqual({ contents: "read" });
  expect(launchable.environment).toEqual({
    name: "approve-brev-launchable-e2e",
    deployment: false,
  });
  expect(launchable.concurrency).toEqual({
    group: "brev-launchable-staging-cpu",
    "cancel-in-progress": false,
  });
  expect(launchable.if).toContain("vars.NEMOCLAW_BREV_LAUNCHABLE_E2E_ENABLED == 'true'");
  expect(launchable.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
  expect(launchable.if).toContain("github.ref == 'refs/heads/main'");
  expect(launchable.if).toContain("brev-launchable-cloud-openclaw");
  expect(launchable.if).not.toContain("inputs.checkout_sha == '' && (github.event_name");

  const checkout = steps.find((step) => step.name === "Check out trusted E2E control code");
  expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/u);
  expect(checkout?.with).toEqual({
    ref: "${{ github.workflow_sha }}",
    "persist-credentials": false,
  });

  const request = steps.find((step) => step.name === "Bind exact image request");
  expect(request?.env?.CANDIDATE_SHA).toBe("${{ inputs.checkout_sha || github.sha }}");
  expect(request?.env?.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
  expect(request?.run).toContain('git rev-parse HEAD)" = "$WORKFLOW_SHA"');
  expect(request?.run).toContain("mktemp -d");

  const producer = steps.find((step) => step.name === "Build or reuse the exact staging image");
  expect(producer?.env?.PRODUCER_TOKEN).toBe("${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}");
  expect(producer?.run).toContain("build-qualification-image.yml/dispatches");
  expect(producer?.run).toContain("return_run_details:true");
  expect(producer?.run).toContain("workflow_run_id");
  expect(producer?.run).toContain('.path == ".github/workflows/build-qualification-image.yml"');
  expect(producer?.run).toContain(".display_title == $title");
  expect(producer?.run).not.toContain("actions/runs?");

  const handoff = steps.find((step) => step.name === "Read immutable image handoff");
  expect(handoff?.run).toContain("nemoclaw-image-handoff-v1-${PRODUCER_RUN_ID}-1");
  expect(handoff?.run).toContain(".nemoclawSha == $candidate");
  expect(handoff?.run).toContain('.status == "READY"');
  expect(handoff?.run).toContain('.observedFamily == "nemoclaw-brev-staging-cpu"');
  expect(handoff?.run).toContain(".imageSelfLink ==");
  expect(handoff?.run).not.toContain("validate-exact-image-manifest");

  expect(source).toContain("brev-launchable-runtime.sh deploy");
  expect(source).toContain("brev-launchable-runtime.sh qualify");
  expect(source).toContain("brev-launchable-runtime.sh cleanup");
  expect(source).toContain("brev-cleanup-evidence.json");
  expect(source).toContain("NEMOCLAW_STAGING_LAUNCHABLE_ID");
  expect(source).not.toContain("dispatch-intent.v1.json");
  expect(source).not.toContain("controller-state.json");
  expect(source).not.toContain("qualification-evidence.v1.json");
  expect(source).not.toMatch(/npm (?:ci|install)/u);

  const cleanup = steps.find((step) => step.name === "Delete staging workspace and verify absence");
  expect(cleanup?.if).toContain("always()");
  expect(cleanup?.if).toContain("steps.deploy.outcome != 'skipped'");
  const redactIndex = steps.findIndex((step) => step.id === "redact-launchable-evidence");
  const uploadIndex = steps.findIndex(
    (step) => step.name === "Upload exact-image Launchable evidence",
  );
  expect(redactIndex).toBeGreaterThanOrEqual(0);
  expect(uploadIndex).toBeGreaterThan(redactIndex);
  expect(steps[uploadIndex]?.if).toContain("steps.redact-launchable-evidence.outcome == 'success'");
  expect(steps[uploadIndex]?.uses).toBe(
    "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
  );

  expect(runtime).toContain("brev create");
  expect(runtime).toContain("--launchable");
  expect(runtime).toContain("sourceImageId");
  expect(runtime).toContain("test/e2e/live/full-e2e.test.ts");
  expect(runtime).toContain("NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable");
  expect(runtime).toContain("NEMOCLAW_E2E_SECURITY_POSTURE=1");
  expect(runtime).toContain("diff --quiet --no-ext-diff HEAD --");
  expect(runtime).toContain("targetResultSha256");
  expect(runtime).not.toContain("brev-quickstart");
  expect(fullE2e).toContain('host.command("brev-quickstart"');
  expect(fullE2e).toContain('"brev-launchable-cloud-openclaw"');
  expect(fullE2e).toContain("assertFirstAgentTurn({ apiKey: hosted.apiKey, sandbox })");
});

it("redacts nested Launchable evidence and rejects symlinks before upload", () => {
  const workflow = readYaml<Workflow>(E2E_WORKFLOW_PATH);
  const redact = job(workflow, "staging-brev-launchable").steps?.find(
    (step) => step.id === "redact-launchable-evidence",
  );
  const script = redact?.run as string;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-redaction-"));
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
