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

  it("pins actions and checks out the recorded base SHA (#7542)", () => {
    const actionReferences = [scan, resolve, publish]
      .flatMap((job) => steps(job))
      .map((step) => step.uses)
      .filter((reference): reference is string => typeof reference === "string");
    expect(actionReferences).not.toHaveLength(0);
    expect(
      actionReferences.every((reference) => /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/u.test(reference)),
    ).toBe(true);

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

  it("keeps credentials and direct network egress out of Pi (#7542)", () => {
    const configure = namedStep(resolve, "Configure OpenShell inference");
    expect(configure.env).toEqual({
      OPENAI_API_KEY: "${{ secrets.PR_REVIEW_ADVISOR_API_KEY }}",
    });
    expect(configure.run).toContain("--credential OPENAI_API_KEY");
    expect(configure.run).toContain("--model azure/openai/gpt-5.6-terra");
    expect(configure.run).toContain("openshell-gateway generate-certs");
    expect(configure.run).toContain("allow_unauthenticated_users = true");
    expect(configure.run).toContain("supervisor_bin =");
    expect(record(resolve.env).OPENSHELL_GATEWAY_ENDPOINT).toBe("http://127.0.0.1:8080");

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
    expect(pi.run).toContain("--workdir /sandbox/repo");
    expect(pi.run).toContain("--env PI_CODING_AGENT_DIR=/sandbox/pi-config");
    expect(pi.run).toContain("/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    expect(pi.run).toContain("--print @/sandbox/pi-config/task.txt");
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
  });

  it("allows only the resolver runtime and sandbox paths (#7542)", () => {
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ["/usr/bin", "/usr/lib", "/usr/share/git-core", "/etc"],
      read_write: ["/dev", "/sandbox"],
    });
    expect(policy.landlock).toEqual({ compatibility: "hard_requirement" });
    expect(policy.process).toEqual({ run_as_group: "sandbox", run_as_user: "sandbox" });

    const create = namedStep(resolve, "Create the credential-free sandbox");
    expect(record(resolve.env)).toMatchObject({
      ARTIFACT_DIR: "${{ github.workspace }}/resolution-artifact",
      RESOLUTION_WORKDIR: "${{ github.workspace }}/repo",
      RESOLVER_CONFIG_DIR: "${{ github.workspace }}/pi-config",
    });
    expect(record(publish.env).ARTIFACT_DIR).toBe("${{ github.workspace }}/resolution-artifact");
    expect(create.run).toContain('--upload "$RESOLUTION_WORKDIR:/sandbox"');
    expect(create.run).toContain('--upload "$RESOLVER_CONFIG_DIR:/sandbox"');
    expect(create.run).toContain("-- /usr/bin/git -C /sandbox/repo status --short");
  });

  it("publishes only a successfully exported patch and always deletes the sandbox (#7542)", () => {
    expect(namedStep(resolve, "Create the credential-free sandbox").run).toContain(
      "--no-git-ignore",
    );
    const exporter = namedStep(resolve, "Export the Git patch");
    expect(exporter.run).toContain("--workdir /sandbox/repo");
    expect(exporter.run).toContain("/sandbox/resolution.patch");

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
