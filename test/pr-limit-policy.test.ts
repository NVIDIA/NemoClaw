// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function documentedLimit(source: string): number | undefined {
  const match = source.match(/(?:up to|the) (\d+)(?:-open-PR| open PRs)/iu);
  return match ? Number(match[1]) : undefined;
}

// source-shape-contract: compatibility -- Contributor guidance must match the enforced PR count and preserve the workflow-owned maintainer exemption
it("keeps contributor guidance aligned with the enforced maintainer exemption", () => {
  const workflow = YAML.parse(read(".github/workflows/pr-limit.yaml")) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  const run = workflow.jobs["check-pr-limit"]?.steps.find((step) => step.run)?.run ?? "";
  const enforcedLimit = Number(run.match(/\$OPEN_COUNT" -gt (\d+)/u)?.[1]);
  const exemptAccounts =
    run
      .match(/EXEMPT="([^"]+)"/u)?.[1]
      .trim()
      .split(/\s+/u) ?? [];
  const agents = read("AGENTS.md");
  const contributing = read("CONTRIBUTING.md");

  expect(enforcedLimit).toBe(10);
  expect(exemptAccounts.length).toBeGreaterThan(0);
  expect(documentedLimit(agents)).toBe(enforcedLimit);
  expect(documentedLimit(contributing)).toBe(enforcedLimit);
  expect(agents).toContain("only to accounts that the workflow does not exempt");
  expect(contributing).toContain(
    "Core maintainers listed in `.github/workflows/pr-limit.yaml` are exempt from this limit.",
  );
});
