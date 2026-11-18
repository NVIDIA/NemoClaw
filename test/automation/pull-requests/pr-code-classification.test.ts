// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(".github/workflows/pr.yaml");

describe("pull request code classification", () => {
  // source-shape-contract: security -- Executable security-review guidance must enter code checks even though its filename ends in Markdown
  it.each([
    [".agents/skills/nemoclaw-maintainer-security-code-review/SKILL.md", true],
    ["README.md", false],
    ["docs/guide.mdx", false],
    ["fern/docs.yml", false],
    ["scripts/install.sh", true],
  ])("classifies %s for required code checks", (file, expected) => {
    const changes = workflow.jobs.changes;
    const filterStep = changes.steps?.find((step) => step.id === "filter");
    const filters = YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;
    expect(changes.outputs?.code).toBe(
      "${{ steps.filter.outputs.code == 'true' || steps.filter.outputs.security_review == 'true' }}",
    );
    expect(filterStep?.with?.["predicate-quantifier"]).toBe("every");
    const matches = (key: string) =>
      filters[key].every((pattern) => picomatch(pattern, { dot: true })(file));
    expect(matches("code") || matches("security_review")).toBe(expected);
    expect(workflow.jobs["cli-test-shards"].if).toContain("needs.changes.outputs.code == 'true'");
  });
});
