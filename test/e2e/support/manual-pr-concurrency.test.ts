// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";

function scheduling(overrides: Record<string, string | boolean | number> = {}) {
  const workflow = readWorkflow();
  const inputs = {
    checkout_sha: "a".repeat(40),
    base_sha: "b".repeat(40),
    pr_number: "123",
    jobs: "",
    targets: "",
    allow_jetson_dispatch: false,
    include_staging_brev_launchable: false,
    ...overrides,
  };
  // Evaluate the checked-in expressions with concrete inputs in a credential-free child.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readFileSync } from 'node:fs';
         import { runInNewContext } from 'node:vm';
         const { concurrency, inputs } = JSON.parse(readFileSync(0, 'utf8'));
         const context = { inputs, github: { ref: 'refs/heads/main', run_id: 456 },
           toJSON: JSON.stringify,
           format: (pattern, ...args) => pattern.replace(/\\{(\\d+)\\}/g, (_, n) => String(args[Number(n)])),
           contains: (value, part) => value.includes(part) };
         const evaluate = expression => runInNewContext(expression, context, { timeout: 1000 });
         const group = concurrency.group.replace(/\\$\\{\\{([\\s\\S]*?)\\}\\}/g, (_, expression) => evaluate(expression));
         const cancel = evaluate(concurrency['cancel-in-progress'].slice(3, -2));
         process.stdout.write(JSON.stringify({ group, cancel }));`,
      ],
      {
        input: JSON.stringify({ concurrency: workflow.concurrency, inputs }),
        env: {},
        encoding: "utf8",
        timeout: 5000,
      },
    ),
  ) as { group: string; cancel: boolean };
}

describe("manual PR comparison scheduling", () => {
  it.each<Record<string, string>>([
    { jobs: "gateway-upgrade" },
    { targets: "sandbox-operations" },
    { jobs: "x-targets-y", targets: "z" },
  ])("keeps distinct baseline selectors in distinct groups: %j", (selectors) => {
    const baseline = { checkout_sha: "b".repeat(40) };
    const selected = scheduling({ ...baseline, ...selectors });
    expect(selected.group).not.toBe(scheduling(baseline).group);
    expect(selected.cancel).toBe(false);
  });

  it("keeps selector field boundaries distinct in baseline group keys", () => {
    const baseline = { checkout_sha: "b".repeat(40) };
    expect(scheduling({ ...baseline, jobs: "x-targets-y", targets: "z" }).group).not.toBe(
      scheduling({ ...baseline, jobs: "x", targets: "y-targets-z" }).group,
    );
    const workflow = readWorkflow();
    const concurrency = workflow.concurrency as Record<string, unknown>;
    concurrency.group = String(concurrency.group).replace(
      "format('pr-{0}-base-{1}-jobs-{2}-targets-{3}', inputs.pr_number, inputs.base_sha, toJSON(inputs.jobs), toJSON(inputs.targets))",
      "format('pr-{0}-base-{1}', inputs.pr_number, inputs.base_sha)",
    );
    expect(validateE2eWorkflow(workflow)).toContain(
      "workflow concurrency must isolate baseline comparisons and each Launchable dispatch",
    );
  });

  it("keeps a candidate retry out of the active baseline group", () => {
    const candidate = scheduling();
    const baseline = scheduling({ checkout_sha: "b".repeat(40) });
    expect(candidate.group).not.toBe(baseline.group);
    expect(candidate.cancel).toBe(true);
    expect(baseline.cancel).toBe(false);
  });

  it("supersedes older candidates without superseding another base revision", () => {
    expect(scheduling({ checkout_sha: "c".repeat(40) }).group).toBe(scheduling().group);
    expect(scheduling({ checkout_sha: "b".repeat(40) }).group).not.toBe(
      scheduling({ checkout_sha: "c".repeat(40), base_sha: "c".repeat(40) }).group,
    );
    expect(scheduling({ pr_number: "124" }).group).not.toBe(scheduling().group);
  });

  it.each<Record<string, string | boolean | number>>([
    { checkout_sha: "", base_sha: "" },
    { allow_jetson_dispatch: true },
    { jobs: "llama-cpp-dgx-spark-qualification" },
    { jobs: "dgx-station-express" },
    { jobs: "staging-brev-launchable" },
    { jobs: "staging-brev-launchable-identity" },
    { include_staging_brev_launchable: true },
  ])("preserves cancellation protection for %j", (inputs) => {
    expect(scheduling(inputs).cancel).toBe(false);
  });

  it("rejects a workflow that restores candidate and baseline group collisions", () => {
    const workflow = readWorkflow();
    expect(validateE2eWorkflow(workflow)).toEqual([]);
    (workflow.concurrency as Record<string, unknown>).group =
      "e2e-${{ github.ref }}-pr-${{ inputs.pr_number }}-manual-pr";
    expect(validateE2eWorkflow(workflow)).toContain(
      "workflow concurrency must isolate baseline comparisons and each Launchable dispatch",
    );
  });

  it("rejects cancellation of active baseline runs", () => {
    const workflow = readWorkflow();
    const concurrency = workflow.concurrency as Record<string, unknown>;
    concurrency["cancel-in-progress"] = String(concurrency["cancel-in-progress"]).replace(
      " && inputs.checkout_sha != inputs.base_sha",
      "",
    );
    expect(validateE2eWorkflow(workflow)).toContain(
      "workflow concurrency must not cancel an active baseline, Jetson, or Launchable dispatch",
    );
  });
});
