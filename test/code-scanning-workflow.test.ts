// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readYaml, type Workflow } from "./helpers/e2e-workflow-contract";

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  groups?: Record<string, { patterns?: string[] }>;
};

const workflow = readYaml<Workflow>(".github/workflows/code-scanning.yaml");
const dependabot = readYaml<{ updates?: DependabotUpdate[] }>(".github/dependabot.yml");

const codeqlActionPrefix = "github/codeql-action/";

describe("Code scanning workflow dependency updates", () => {
  it("keeps every CodeQL action on one immutable revision", () => {
    const codeqlActions = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses?.startsWith(codeqlActionPrefix) ?? false);

    expect(
      codeqlActions.map((uses) => uses.slice(codeqlActionPrefix.length).split("@")[0]).sort(),
    ).toEqual(["analyze", "init", "upload-sarif"]);

    const revisions = codeqlActions.map((uses) => uses.split("@")[1]);
    expect(revisions).toHaveLength(3);
    for (const revision of revisions) {
      expect(revision).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(new Set(revisions).size).toBe(1);
  });

  it("groups CodeQL action updates so Dependabot keeps the shared revision synchronized", () => {
    const githubActionsUpdate = dependabot.updates?.find(
      (update) => update["package-ecosystem"] === "github-actions" && update.directory === "/",
    );
    const groups = Object.values(githubActionsUpdate?.groups ?? {});

    expect(groups.some((group) => group.patterns?.includes("github/codeql-action/*"))).toBe(true);
  });
});
