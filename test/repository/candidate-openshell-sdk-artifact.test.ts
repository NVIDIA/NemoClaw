// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateSdkLocatorFixture } from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];
function fixture(mode: "candidate" | "trusted" = "candidate") {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-sdk-artifact-locator-"));
  roots.push(root);
  return candidateSdkLocatorFixture(root, mode);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("candidate SDK artifact provenance", () => {
  it.each(["push", "workflow_dispatch"])(
    "keeps the trusted SDK archive from main event %s",
    (event) => {
      const f = fixture("trusted");
      f.run.event = event;
      const result = f.execute();
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toContain(
        `artifact_id=42\nrun_id=44\nartifact_name=${f.decision.artifactName}`,
      );
    },
  );

  it("does not use a candidate producer for an already trusted SDK", () => {
    const f = fixture("trusted");
    f.run.path = ".github/workflows/candidate-upgrade-admission.yaml";
    f.run.event = "pull_request_target";
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });

  it("does not download any archive when neither lock uses the SDK", () => {
    const f = fixture("trusted");
    f.decision.required = false;
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("required=false\n");
  });

  it("selects an archive from the trusted pull-request-target producer", () => {
    const f = fixture();
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain(
      "artifact_id=42\nrun_id=44\nartifact_name=nvidia-openshell-sdk-9.8.7.tgz",
    );
  });

  it("selects an archive produced after an approval comment on main", () => {
    const f = fixture();
    f.run.event = "issue_comment";
    f.run.head_branch = "main";
    f.run.head_sha = "d".repeat(40);
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("artifact_id=42");
  });

  it.each([
    ["path", ".github/workflows/pr.yaml"],
    ["event", "pull_request"],
    ["event", "workflow_dispatch"],
    ["status", "in_progress"],
    ["conclusion", "failure"],
    ["head_sha", "f".repeat(40)],
    ["head_sha", "b".repeat(40)],
  ] as const)("rejects producer %s=%s", (key, value) => {
    const f = fixture();
    f.run[key] = value;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });

  it.each(["repository", "head_repository"] as const)("rejects a different producer %s", (key) => {
    const f = fixture();
    f.run[key].full_name = "attacker/NemoClaw";
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });

  it.each([
    [],
    [{ number: 124, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } }],
    [{ number: 123, head: { sha: "f".repeat(40) }, base: { sha: "b".repeat(40) } }],
    [{ number: 123, head: { sha: "a".repeat(40) }, base: { sha: "f".repeat(40) } }],
  ])("rejects a target producer without the exact PR association: %j", (...associations) => {
    const f = fixture();
    f.run.pull_requests = associations;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });

  it("rejects an archive for a superseded approval", () => {
    const f = fixture();
    f.artifact.name = f.artifact.name.replace(/-50$/u, "-49");
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });

  it("rejects an expired archive", () => {
    const f = fixture();
    f.artifact.expired = true;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });
});
