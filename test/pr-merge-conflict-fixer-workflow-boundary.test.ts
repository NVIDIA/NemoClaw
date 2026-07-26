// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const workflowSource = fs.readFileSync(
  path.join(root, ".github", "workflows", "pr-merge-conflict-fixer.yaml"),
  "utf8",
);
const workflow = YAML.parse(workflowSource) as Record<string, unknown>;
const policy = YAML.parse(
  fs.readFileSync(path.join(root, "tools", "pr-merge-conflict-fixer", "policy.yaml"), "utf8"),
) as Record<string, unknown>;

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
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

function checkout(job: Record<string, unknown>): Record<string, unknown> {
  const step = steps(job).find((candidate) =>
    String(candidate.uses ?? "").startsWith("actions/checkout@"),
  );
  if (!step) throw new Error("Missing checkout step");
  return step;
}

describe("PR merge conflict fixer workflow boundary", () => {
  const jobs = record(workflow.jobs);
  const scan = record(jobs.scan);
  const resolve = record(jobs.resolve);
  const publish = record(jobs.publish);

  it("runs only after pushes to main with one write stage (#7542)", () => {
    expect(record(workflow.on)).toEqual({ push: { branches: ["main"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(jobs).sort()).toEqual(["publish", "resolve", "scan"]);
    expect(scan.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(resolve.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "write", "pull-requests": "read" });
    expect(resolve["timeout-minutes"]).toBe(30);
    expect(
      Object.values(jobs).filter((job) => record(job)["timeout-minutes"] !== undefined),
    ).toHaveLength(1);
  });

  it("runs pinned trusted code at the recorded base revisions (#7542)", () => {
    for (const job of [scan, resolve, publish]) {
      for (const step of steps(job)) {
        if (step.uses) expect(step.uses).toMatch(/^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/u);
      }
    }
    expect(checkout(scan).with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    });
    for (const job of [resolve, publish]) {
      expect(checkout(job).with).toMatchObject({
        "persist-credentials": false,
        ref: "${{ matrix.item.base_sha }}",
      });
    }
    expect(namedStep(publish, "Validate and publish the merge commit").run).toContain(
      "$TRUSTED_CHECKOUT/tools/pr-merge-conflict-fixer/publish.mts",
    );
  });

  it("keeps credentials and ordinary network access out of Pi (#7542)", () => {
    const configure = namedStep(resolve, "Configure OpenShell inference");
    expect(configure.env).toEqual({
      OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    });
    expect(configure.run).toContain("--credential OPENAI_API_KEY");
    expect(configure.run).toContain("--model azure/openai/gpt-5.6-terra");

    const pi = namedStep(resolve, "Run one Pi conflict-resolution task");
    expect(pi.env).toBeUndefined();
    for (const option of [
      "--model azure/openai/gpt-5.6-terra",
      "--no-context-files",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-session",
      "--no-skills",
      "--no-themes",
      "--offline",
    ]) {
      expect(pi.run).toContain(option);
    }
    expect(String(pi.run)).not.toContain("GITHUB_TOKEN");
    expect(record(resolve.env).PI_IMAGE).toBe(
      "ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd",
    );
    expect(workflowSource.match(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/gu)).toEqual([
      "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    ]);
    expect(workflowSource).not.toMatch(
      /\b(?:PAT|GitHub App|checks:\s*write|statuses:\s*write)\b/iu,
    );
    expect(policy.network_policies).toEqual({});
    expect(record(policy.process).run_as_user).toBe("sandbox");
    expect(record(policy.filesystem_policy).read_write).toContain("/sandbox");
  });

  it("publishes only a successfully exported patch and always deletes the sandbox (#7542)", () => {
    expect(namedStep(resolve, "Create the credential-free sandbox").run).toContain(
      "--no-git-ignore",
    );
    const cleanup = namedStep(resolve, "Delete the sandbox");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("openshell sandbox delete");

    const upload = namedStep(resolve, "Upload the resolution patch");
    const download = namedStep(publish, "Download the resolution patch");
    expect(upload.if).toBe("success()");
    expect(download["continue-on-error"]).toBe(true);
    expect(record(download.with).name).toBe(record(upload.with).name);
    expect(record(download.with).path).toBe("${{ env.ARTIFACT_DIR }}");

    const publisher = namedStep(publish, "Validate and publish the merge commit");
    expect(publisher.if).toBe("${{ steps.download.outcome == 'success' }}");
    expect(record(publisher.env).GITHUB_TOKEN).toBe("${{ github.token }}");
  });
});
