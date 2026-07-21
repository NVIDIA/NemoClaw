// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { "cancel-in-progress"?: boolean };
  jobs?: Record<string, { if?: string; steps?: Step[] }>;
};

const root = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(
    path.join(root, ".github", "workflows", "openclaw-tar-security-revision.yaml"),
    "utf8",
  ),
) as Workflow;

describe("OpenClaw tar security revision publication (#7272)", () => {
  it("keeps publication inside the immutable historical-image boundary", () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);

    const job = workflow.jobs?.["build-and-push"];
    expect(job?.if).toContain("github.ref == 'refs/heads/main'");
    const steps = job?.steps ?? [];
    for (const step of steps.filter((candidate) => candidate.uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    }
    const plan =
      steps.find((step) => step.run?.includes("Resolve immutable publication plan")) ??
      steps.find((step) => step.run?.includes("source_digest"));
    expect(plan?.run).toContain('source_image="${image}@${source_digest}"');
    expect(plan?.run).toContain("Refusing to overwrite existing revision tag");
    expect(plan?.run).toContain("Could not prove revision tag is absent");

    const build = steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(build?.with).toMatchObject({
      file: "Dockerfile.openclaw-tar-security-revision",
      platforms: "linux/amd64,linux/arm64",
      push: true,
      tags: "${{ steps.plan.outputs.destination_image }}",
      provenance: "mode=max",
      sbom: true,
    });
    expect(String(build?.with?.["build-args"])).toContain(
      "BASE_IMAGE=${{ steps.plan.outputs.source_image }}",
    );
    const verification = steps.find((step) => step.run?.includes("revision_digest"));
    expect(verification?.run).toContain('test "$current_source" = "$SOURCE_DIGEST"');
    expect(verification?.run).toContain("NEMOCLAW_SANDBOX_BASE_IMAGE_REF=");
    expect(verification?.run).toContain("unique | length");
  });
});
