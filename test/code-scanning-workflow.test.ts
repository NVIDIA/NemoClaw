// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow } from "./helpers/e2e-workflow-contract";

type DependabotUpdate = {
  "package-ecosystem"?: string;
  directory?: string;
  groups?: Record<string, { patterns?: string[] }>;
};

const workflow = readYaml<Workflow>(".github/workflows/code-scanning.yaml");
const dependabot = readYaml<{ updates?: DependabotUpdate[] }>(".github/dependabot.yml");
const shellcheckSteps = workflow.jobs.shellcheck?.steps ?? [];

const codeqlActionPrefix = "github/codeql-action/";

function requiredStep(name: string) {
  const step = shellcheckSteps.find((candidate) => candidate.name === name);
  assert(step, `ShellCheck workflow is missing step: ${name}`);
  return step;
}

function stepIndex(name: string) {
  const index = shellcheckSteps.findIndex((candidate) => candidate.name === name);
  assert(index >= 0, `ShellCheck workflow is missing step: ${name}`);
  return index;
}

describe("Code scanning workflow dependency updates", () => {
  // source-shape-contract: security -- One immutable CodeQL revision prevents partial scanner action upgrades
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

  // source-shape-contract: security -- Grouped CodeQL updates preserve the reviewed single-revision scanner boundary
  it("groups CodeQL action updates so Dependabot keeps the shared revision synchronized", () => {
    const githubActionsUpdate = dependabot.updates?.find(
      (update) => update["package-ecosystem"] === "github-actions" && update.directory === "/",
    );
    const groups = Object.values(githubActionsUpdate?.groups ?? {});

    expect(groups.some((group) => group.patterns?.includes("github/codeql-action/*"))).toBe(true);
  });
});

describe("ShellCheck SARIF workflow boundary", () => {
  // source-shape-contract: security -- A sparse trusted checkout, disabled credential persistence, an isolated helper environment, and fail-closed ordering protect SARIF publication
  it("runs only the trusted converter and keeps scanner status separate from conversion failures (#6959)", () => {
    expect(workflow.jobs.shellcheck).toBeDefined();

    const checkout = requiredStep("Checkout");
    expect(checkout.with?.path).toBe("source");
    expect(checkout.with?.["persist-credentials"]).toBe(false);

    const trustedCheckout = requiredStep("Check out the trusted ShellCheck converter");
    expect(trustedCheckout.uses).toBe("actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10");
    expect(trustedCheckout.with).toMatchObject({
      ref: "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.workflow_sha }}",
      path: "trusted-shellcheck-converter",
      "persist-credentials": false,
      "sparse-checkout": "scripts/shellcheck-json1-to-sarif.mts\n",
      "sparse-checkout-cone-mode": false,
    });

    const detect = requiredStep("Detect trusted ShellCheck converter");
    expect(detect.id).toBe("converter");
    expect(detect.run).toContain(
      "trusted-shellcheck-converter/scripts/shellcheck-json1-to-sarif.mts",
    );
    expect(detect.run).toContain('echo "present=false" >> "$GITHUB_OUTPUT"');
    expect(detect.run).toContain("conversion and upload begin after this helper lands");

    const setupNode = requiredStep("Setup Node.js");
    expect(setupNode.if).toBe("steps.converter.outputs.present == 'true'");
    expect(setupNode.uses).toBe("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(setupNode.with?.["node-version"]).toBe("22.19.0");

    const install = requiredStep("Install ShellCheck");
    expect(install.if).toBe("steps.converter.outputs.present == 'true'");

    const collect = requiredStep("Collect shell files");
    expect(collect.if).toBe("steps.converter.outputs.present == 'true'");
    expect(collect).toMatchObject({ "working-directory": "source" });
    expect(collect.run).toContain("$GITHUB_WORKSPACE/shell-files.txt");
    expect(collect.run).toContain("git ls-files -z --");
    expect(collect.run).toContain("sort -zu");

    const generate = requiredStep("Generate ShellCheck SARIF");
    expect(generate.if).toBe(
      "steps.converter.outputs.present == 'true' && steps.shell-files.outputs.has_files == 'true'",
    );
    expect(generate).toMatchObject({ "working-directory": "source" });
    expect(generate.run).toContain(
      '"$GITHUB_WORKSPACE/trusted-shellcheck-converter/scripts/shellcheck-json1-to-sarif.mts"',
    );
    expect(generate.run).not.toContain(
      '"$GITHUB_WORKSPACE/source/scripts/shellcheck-json1-to-sarif.mts"',
    );
    expect(generate.run).toContain("mapfile -d '' -t shell_files");
    expect(generate.run).toContain('shellcheck --format=json1 -- "${shell_files[@]}"');
    expect(generate.run).not.toContain("xargs");
    expect(generate.run).toContain('case "$sc_exit" in');
    expect(generate.run).toContain('exit "$sc_exit"');
    expect(generate.run).toContain("ShellCheck found issues; continuing");
    expect(generate.run).toContain("refusing to convert or upload incomplete results");
    expect(generate.run).toContain("conversion_exit=$?");
    expect(generate.run).toContain('exit "$conversion_exit"');
    expect(generate.run).not.toContain("def level_map");
    expect(generate.run).not.toContain("cat > shellcheck.sarif");

    const checkRuns = requiredStep("Check SARIF has runs");
    expect(checkRuns.if).toBe(
      "steps.converter.outputs.present == 'true' && steps.shell-files.outputs.has_files == 'true'",
    );
    expect(checkRuns.run).toContain("jq '.runs | length' shellcheck.sarif");

    const upload = requiredStep("Upload ShellCheck SARIF");
    expect(upload.if).toBe(
      "steps.converter.outputs.present == 'true' && steps.shell-files.outputs.has_files == 'true' && steps.sarif-runs.outputs.has_runs == 'true'",
    );
    expect(upload.with?.checkout_path).toBe("source");

    const orderedSteps = [
      stepIndex("Checkout"),
      stepIndex("Check out the trusted ShellCheck converter"),
      stepIndex("Detect trusted ShellCheck converter"),
      stepIndex("Setup Node.js"),
      stepIndex("Install ShellCheck"),
      stepIndex("Collect shell files"),
      stepIndex("Generate ShellCheck SARIF"),
      stepIndex("Check SARIF has runs"),
      stepIndex("Upload ShellCheck SARIF"),
    ];
    expect(orderedSteps).toEqual([...orderedSteps].sort((left, right) => left - right));
  });
});
