// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");
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

function required<T>(value: T | undefined, message: string): T {
  expect(value, message).toBeDefined();
  return value as T;
}

function namedStep(job: Record<string, unknown>, name: string): Record<string, unknown> {
  return required(
    steps(job).find((candidate) => candidate.name === name),
    `Missing workflow step: ${name}`,
  );
}

function checkout(job: Record<string, unknown>): Record<string, unknown> {
  return required(
    steps(job).find((candidate) => String(candidate.uses ?? "").startsWith("actions/checkout@")),
    "Missing checkout step",
  );
}

function resolverInvocation(command: string): string {
  return `node --experimental-strip-types --no-warnings "$TRUSTED_CHECKOUT/tools/pr-merge-conflict-fixer/resolve.mts" ${command}`;
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
    expect(scan["timeout-minutes"]).toBe(10);
    expect(resolve["timeout-minutes"]).toBe(30);
    expect(publish["timeout-minutes"]).toBe(10);
  });

  it.each(
    Array.from(
      [
        ["Reproduce the recorded conflict", "prepare"],
        ["Configure OpenShell inference", "configure"],
        ["Create the credential-free sandbox", "create"],
        ["Run one Pi conflict-resolution task", "run"],
        ["Export the Git patch", "export"],
        ["Delete the sandbox", "delete"],
      ],
      (value) => [value],
    ),
  )("loads each resolve command from the pushed main SHA [case %#] (#6952)", ([name, command]) => {
    const actionReferences = [scan, resolve, publish]
      .flatMap((job) => steps(job))
      .map((step) => step.uses)
      .filter((reference): reference is string => typeof reference === "string");
    expect(actionReferences).not.toHaveLength(0);
    expect(
      actionReferences.every((reference) => /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/u.test(reference)),
    ).toBe(true);

    [scan, resolve, publish].forEach((job) => {
      expect(checkout(job).with).toMatchObject({
        "persist-credentials": false,
        ref: "${{ github.sha }}",
      });
    });
    expect(namedStep(publish, "Validate and publish the merge commit").run).toContain(
      "$TRUSTED_CHECKOUT/tools/pr-merge-conflict-fixer/publish.mts",
    );

    expect(namedStep(resolve, name).run).toBe(resolverInvocation(command));
  });

  it("keeps credentials and direct network egress out of Pi (#7542)", () => {
    const configure = namedStep(resolve, "Configure OpenShell inference");
    expect(configure.env).toEqual({
      OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    });
    expect(configure.run).toBe(resolverInvocation("configure"));

    const pi = namedStep(resolve, "Run one Pi conflict-resolution task");
    expect(pi.env).toBeUndefined();
    expect(pi.run).toBe(resolverInvocation("run"));
    expect(namedStep(resolve, "Install OpenShell").run).toContain(
      "env -u GITHUB_TOKEN -u GH_TOKEN -u PR_REVIEW_ADVISOR_API_KEY",
    );
    expect(record(resolve.env).OPENSHELL_GATEWAY_ENDPOINT).toBe("http://127.0.0.1:8080");
    expect(record(resolve.env).PI_IMAGE).toBe(
      "ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd",
    );
    const sandboxName = String(record(resolve.env).SANDBOX_NAME ?? "");
    expect(sandboxName).toBe("pr-conflict");
    expect(sandboxName.length).toBeLessThanOrEqual(19);
    expect(sandboxName).toMatch(/^(?!.*--)[a-z]([a-z0-9-]*[a-z0-9])?$/u);
    expect(workflowSource.match(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/gu)).toEqual([
      "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    ]);
    expect(workflowSource).not.toMatch(
      /\b(?:PAT|GitHub App|checks:\s*write|statuses:\s*write)\b/iu,
    );
    expect(policy.network_policies).toEqual({});
  });

  it("allows only the resolver runtime and sandbox paths (#7542)", () => {
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ["/usr/bin", "/usr/lib", "/usr/share/git-core", "/etc"],
      read_write: ["/dev", "/sandbox"],
    });
    expect(policy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(policy.process).toEqual({ run_as_group: "sandbox", run_as_user: "sandbox" });
    expect(record(resolve.env)).toMatchObject({
      ARTIFACT_DIR: "${{ github.workspace }}/resolution-artifact",
      RESOLUTION_WORKDIR: "${{ github.workspace }}/repo",
      RESOLVER_CONFIG_DIR: "${{ github.workspace }}/pi-config",
      TRUSTED_CHECKOUT: "${{ github.workspace }}/trusted",
    });
    expect(record(publish.env).ARTIFACT_DIR).toBe("${{ github.workspace }}/resolution-artifact");
  });

  it("publishes only a successfully exported patch and always deletes the sandbox (#7542)", () => {
    const exporter = namedStep(resolve, "Export the Git patch");
    expect(exporter.env).toEqual({
      CONFLICT_TREE: "${{ steps.prepare.outputs.conflict_tree }}",
    });
    expect(exporter.run).toBe(resolverInvocation("export"));

    const cleanup = namedStep(resolve, "Delete the sandbox");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toBe(resolverInvocation("delete"));

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
