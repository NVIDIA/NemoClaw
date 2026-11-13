// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateSdkLocatorFixture } from "../support/candidate-openshell-sdk.ts";

const roots: string[] = [];
function fixture(mode: "candidate" | "trusted" | "stacked" = "candidate") {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-sdk-artifact-locator-"));
  roots.push(root);
  return candidateSdkLocatorFixture(root, mode);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("candidate SDK artifact provenance", () => {
  it("keeps existing main archive reuse for an ordinary stacked PR", () => {
    const f = fixture("trusted");
    f.stack.baseRef = "feature";
    f.stack.parents = [];
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("artifact_id=42");
    expect(result.output).not.toContain("stack_pr=");
  });
  it("reuses a stack parent's separately admitted SDK without relabeling it", () => {
    const f = fixture("stacked");
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("stack_pr=123");
    expect(result.output).toContain("artifact_id=42");
    expect(result.output).toContain(f.artifact.name);
  });
  it("rejects a stack parent whose admission no longer covers the child's inputs", () => {
    const f = fixture("stacked");
    f.stack.denied = true;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
    expect(result.state?.artifactReads).toBe(1);
  });
  it("rejects a parent's different SDK artifact selection", () => {
    const f = fixture("stacked");
    f.stack.decision.artifactName = "other-sdk.tgz";
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });
  it.each(["missing", "ambiguous", "changed head", "fork", "different base"])(
    "rejects %s stack parent before artifact lookup",
    (kind) => {
      const f = fixture("stacked");
      const parent = f.stack.parents[0]!;
      const changes = {
        missing: () => f.stack.parents.splice(0),
        ambiguous: () => f.stack.parents.push(parent),
        "changed head": () => {
          parent.head.sha = "f".repeat(40);
        },
        fork: () => {
          parent.head.repo.full_name = "attacker/NemoClaw";
        },
        "different base": () => {
          parent.base.ref = "upgrade";
        },
      };
      changes[kind as keyof typeof changes]();
      const result = f.execute();
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain("artifact_id=");
      expect(result.state?.artifactReads).toBe(1);
    },
  );
  it("rejects child audit policy changes before admitting the parent's SDK", () => {
    const f = fixture("stacked");
    writeFileSync(join(f.root, "ci/reviewed-npm-audit.json"), "{}");
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("artifact_id=");
  });
  it("rechecks the parent's admission after download before releasing the archive", () => {
    const f = fixture("stacked");
    const result = f.execute(true);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(f.root, "verified-sdk", f.decision.artifactName))).toBe(true);
  });
  it.each(["revoked", "changed review"])("rejects %s parent admission after download", (kind) => {
    const f = fixture("stacked");
    f.stack.denied = kind === "revoked";
    f.stack.decision.bundleName += "-changed";
    const result = f.execute(true);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(f.root, "verified-sdk"))).toBe(false);
  });
  it("waits for the approved candidate archive and completed producer", () => {
    const f = fixture();
    f.availability.missingReads = 2;
    f.availability.pendingReads = 2;
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain("artifact_id=42");
    expect(result.state).toEqual({ artifactReads: 5, producerReads: 4, sleeps: 4 });
  });

  it("fails after the bounded wait without publishing SDK outputs", () => {
    const f = fixture();
    f.availability.missingReads = 24;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.state).toEqual({ artifactReads: 24, producerReads: 0, sleeps: 23 });
    expect(result.output).not.toContain("artifact_id=");
  });

  it("does not wait for a missing trusted archive", () => {
    const f = fixture("trusted");
    f.availability.missingReads = 24;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.state).toEqual({ artifactReads: 1, producerReads: 0, sleeps: 0 });
    expect(result.output).not.toContain("artifact_id=");
  });

  it("stops on an artifact access denial without waiting or publishing SDK outputs", () => {
    const f = fixture();
    f.availability.accessDenied = true;
    const result = f.execute();
    expect(result.status).not.toBe(0);
    expect(result.state).toBeUndefined();
    expect(result.output).not.toContain("artifact_id=");
  });

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

  it("selects an archive produced after a PR review refresh on main", () => {
    const f = fixture();
    f.run.event = "workflow_run";
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
