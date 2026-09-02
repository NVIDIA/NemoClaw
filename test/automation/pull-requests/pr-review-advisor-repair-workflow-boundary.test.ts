// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const workflowSource = fs.readFileSync(
  path.join(root, ".github", "workflows", "pr-review-advisor-repair.yaml"),
  "utf8",
);
const workflow = YAML.parse(workflowSource) as Record<string, unknown>;
const policy = YAML.parse(
  fs.readFileSync(path.join(root, "tools", "pr-review-advisor-repair", "policy.yaml"), "utf8"),
) as Record<string, unknown>;
const validationPolicy = YAML.parse(
  fs.readFileSync(
    path.join(root, "tools", "pr-review-advisor-repair", "validation-policy.yaml"),
    "utf8",
  ),
) as Record<string, unknown>;
const resolverSource = fs.readFileSync(
  path.join(root, "tools", "pr-review-advisor-repair", "resolve.mts"),
  "utf8",
);
const validatorSource = fs.readFileSync(
  path.join(root, "tools", "pr-review-advisor-repair", "validate.mts"),
  "utf8",
);
const publisherSource = fs.readFileSync(
  path.join(root, "tools", "pr-review-advisor-repair", "publish.mts"),
  "utf8",
);
const generatedHeadWorkflowFiles = [
  "pr.yaml",
  "commit-lint.yaml",
  "dco-check.yaml",
  "installer-hash-check.yaml",
  "code-scanning.yaml",
] as const;
const generatedHeadWorkflowSources = Object.fromEntries(
  [...generatedHeadWorkflowFiles, "pr-review-advisor.yaml"].map((file) => [
    file,
    fs.readFileSync(path.join(root, ".github", "workflows", file), "utf8"),
  ]),
) as Record<string, string>;
const generatedHeadWorkflows = Object.fromEntries(
  Object.entries(generatedHeadWorkflowSources).map(([file, source]) => [file, YAML.parse(source)]),
) as Record<string, Record<string, unknown>>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function steps(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(job.steps) ? (job.steps as Array<Record<string, unknown>>) : [];
}

function namedStep(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const step = steps(job).find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as Record<string, unknown>;
}

describe("PR Review Advisor repair Phase 1 workflow boundary", () => {
  const jobs = record(workflow.jobs);
  const collect = record(jobs.collect);
  const claim = record(jobs.claim);
  const repair = record(jobs.repair);
  const validate = record(jobs.validate);
  const publish = record(jobs.publish);
  const verify = record(jobs["verify-generated-head"]);

  it("is manual-only, kill-switched, and splits model use from publication (#10791)", () => {
    expect(Object.keys(record(workflow.on))).toEqual(["workflow_dispatch"]);
    expect(
      record(record(record(workflow.on).workflow_dispatch).inputs).repository_egress_authorized,
    ).toEqual({
      default: false,
      description:
        "Explicitly authorize sending repository-derived context to the configured Advisor model endpoint",
      required: true,
      type: "boolean",
    });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(jobs).sort()).toEqual([
      "claim",
      "collect",
      "publish",
      "repair",
      "validate",
      "verify-generated-head",
    ]);
    expect(workflowSource).not.toMatch(/^\s+(?:push|pull_request|pull_request_target):/mu);
    expect(repair.permissions).toEqual({ actions: "read", contents: "read" });
    expect(publish.permissions).toEqual({
      actions: "write",
      contents: "write",
      "pull-requests": "read",
    });
    expect(publish.environment).toBe("advisor-repair-publication");
    expect(workflowSource.match(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/gu)).toEqual([
      "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    ]);
    expect(JSON.stringify(publish)).not.toContain("PR_REVIEW_ADVISOR_API_KEY");
    expect(namedStep(collect, "Record the emergency-switch decision").env).toMatchObject({
      GITHUB_TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
      PHASE1_ENABLED: "${{ vars.ADVISOR_REPAIR_PHASE1_ENABLED == 'true' }}",
      REPOSITORY_EGRESS_AUTHORIZED: "${{ inputs.repository_egress_authorized }}",
    });
    expect(namedStep(collect, "Upload the attempt audit receipt").if).toBe("always()");
    expect(repair.if).toContain("vars.ADVISOR_REPAIR_PHASE1_ENABLED == 'true'");
    expect(validate.if).toContain("vars.ADVISOR_REPAIR_PHASE1_ENABLED == 'true'");
    expect(claim.permissions).toEqual({ actions: "read", checks: "write", contents: "read" });
    expect(verify.permissions).toEqual({ actions: "read", checks: "read", contents: "read" });
  });

  it("pins trusted code and binds every handoff to artifact IDs from the same run (#10791)", () => {
    const actionReferences = Object.values(jobs)
      .map(record)
      .flatMap(steps)
      .map((step) => step.uses)
      .filter((uses): uses is string => typeof uses === "string");
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(
      actionReferences.every((uses) =>
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(uses),
      ),
    ).toBe(true);

    const trustedCheckouts = [collect, claim, repair, validate, publish, verify].map((job) =>
      steps(job).find((step) => String(step.uses ?? "").startsWith("actions/checkout@")),
    );
    expect(trustedCheckouts).toHaveLength(6);
    expect(trustedCheckouts.map((checkout) => checkout?.with)).toEqual([
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
      expect.objectContaining({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
        lfs: false,
        submodules: false,
      }),
    ]);
    expect(
      record(namedStep(collect, "Download the exact Advisor artifact IDs").with),
    ).toMatchObject({
      "artifact-ids": "${{ steps.select.outputs.artifact_ids }}",
      "run-id": "${{ inputs.advisor_run_id }}",
      "merge-multiple": false,
    });
    expect(
      record(namedStep(repair, "Download the exact selection artifact ID").with),
    ).toMatchObject({
      "artifact-ids": "${{ needs.collect.outputs.selection_artifact_id }}",
      "run-id": "${{ github.run_id }}",
      "merge-multiple": true,
    });
    expect(record(namedStep(validate, "Download the exact repair artifact ID").with)).toMatchObject(
      {
        "artifact-ids": "${{ needs.repair.outputs.repair_artifact_id }}",
        "run-id": "${{ github.run_id }}",
        "merge-multiple": true,
      },
    );
    expect(
      record(namedStep(publish, "Download the exact validation artifact ID").with),
    ).toMatchObject({
      "artifact-ids": "${{ needs.validate.outputs.validation_artifact_id }}",
      "run-id": "${{ github.run_id }}",
      "merge-multiple": true,
    });
    expect(record(namedStep(publish, "Checkout the exact selected PR head").with)).toMatchObject({
      ref: "${{ needs.collect.outputs.source_head_sha }}",
      "persist-credentials": false,
    });
  });

  it("isolates the model credential and gives Pi no bash or test tool (#10791)", () => {
    const configure = namedStep(repair, "Configure host-side OpenShell inference");
    const pi = namedStep(repair, "Run one Pi repair task without shell or test tools");
    expect(configure.env).toEqual({
      OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
      REPAIR_COMMAND: "configure",
    });
    expect(pi.env).toEqual({ REPAIR_COMMAND: "run" });
    expect(workflowSource.match(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/gu)).toEqual([
      "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    ]);
    expect(record(repair.env).PI_IMAGE).toMatch(
      /^ghcr[.]io\/nvidia\/openshell-community\/sandboxes\/pi@sha256:[0-9a-f]{64}$/u,
    );
    expect(String(namedStep(repair, "Install OpenShell").run)).toContain(
      "env -u GITHUB_TOKEN -u GH_TOKEN -u PR_REVIEW_ADVISOR_API_KEY",
    );
    expect(resolverSource).toContain('"read,edit,write,grep,find,ls"');
    expect(resolverSource).not.toContain('"read,bash,edit,write,grep,find,ls"');
    expect(policy.network_policies).toEqual({});
    expect(policy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ["/usr/bin", "/usr/lib", "/etc"],
      read_write: ["/dev", "/sandbox"],
    });
  });

  it("validates in a separate read-only job and never names an E2E lane (#10791)", () => {
    expect(repair.permissions).toEqual({ actions: "read", contents: "read" });
    expect(validate.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(
      namedStep(validate, "Run trusted validation against the still-live exact head").env,
    ).toMatchObject({
      GITHUB_TOKEN: "${{ github.token }}",
    });
    expect(
      namedStep(validate, "Upload the trusted validation receipt and validated patch").if,
    ).toBe("always()");
    expect(
      record(namedStep(validate, "Upload the trusted validation receipt and validated patch").with)
        .path,
    ).toBe("${{ env.VALIDATION_ARTIFACT_DIR }}/");
    expect(record(validate.env).VALIDATION_IMAGE).toMatch(
      /^ghcr[.]io\/nvidia\/openshell-community\/sandboxes\/pi@sha256:[0-9a-f]{64}$/u,
    );
    expect(
      String(namedStep(validate, "Install OpenShell for secret-free validation").run),
    ).toContain("env -u GITHUB_TOKEN -u GH_TOKEN -u OPENAI_API_KEY -u PR_REVIEW_ADVISOR_API_KEY");
    expect(validationPolicy.network_policies).toEqual({});
    expect(validationPolicy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(validationPolicy.process).toEqual({ run_as_user: "sandbox", run_as_group: "sandbox" });
    expect(validatorSource).toContain("startOwnedOpenShellGateway");
    expect(validatorSource).toContain("createOpenShellValidationRunner");
    expect(validatorSource).toContain("read_only: true");
    expect(validatorSource).toContain("target: `${SANDBOX_REPOSITORY}/.git`");
    expect(validatorSource).toContain("target: `${SANDBOX_REPOSITORY}/node_modules`");
    expect(validatorSource).toContain("a sandbox validation command runner is required");
    expect(workflowSource).not.toMatch(/e2e/iu);
  });

  it.each(generatedHeadWorkflowFiles)(
    "dispatches %s through an exact generated-head context (#10791)",
    (file) => {
      const generatedWorkflow = generatedHeadWorkflows[file];
      const dispatch = record(record(generatedWorkflow.on).workflow_dispatch);
      expect(Object.keys(record(dispatch.inputs)).sort()).toEqual([
        "base_sha",
        "pr_number",
        "repair_attempt_key",
        "source_head_sha",
      ]);
      expect(generatedHeadWorkflowSources[file]).toContain(
        "tools/pr-review-advisor-repair/generated-head-context.mts",
      );
      expect(generatedHeadWorkflowSources[file]).toContain("REPAIR_ATTEMPT_KEY");
      expect(generatedHeadWorkflowSources[file]).toContain("SOURCE_HEAD_SHA");
    },
  );

  it("dispatches Advisor through an exact generated-head context (#10791)", () => {
    const advisorInputs = record(
      record(record(generatedHeadWorkflows["pr-review-advisor.yaml"].on).workflow_dispatch).inputs,
    );
    expect(advisorInputs).toHaveProperty("source_head_sha");
    expect(advisorInputs).toHaveProperty("base_sha");
    expect(advisorInputs).toHaveProperty("repair_attempt_key");
    expect(generatedHeadWorkflowSources["pr-review-advisor.yaml"]).toContain(
      "tools/pr-review-advisor-repair/generated-head-context.mts",
    );
  });

  it("publishes by verified one-parent commit and non-force compare-and-swap (#10791)", () => {
    expect(publisherSource).toContain("parents: [input.selection.input.sourceHeadSha]");
    expect(publisherSource).toContain("await waitForVerifiedCommit");
    expect(publisherSource).toContain("beforeOid: input.selection.input.sourceHeadSha");
    expect(publisherSource).toContain("force: false");
    expect(publisherSource).not.toMatch(/git\s+push/iu);
  });
});
