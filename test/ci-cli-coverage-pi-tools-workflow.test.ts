// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract";

type PullRequestWorkflow = { jobs: Record<string, WorkflowJob> };

const action = readYaml<CompositeAction>(".github/actions/ci-cli-coverage-shard/action.yaml");
const pullRequestWorkflow = readYaml<PullRequestWorkflow>(".github/workflows/pr.yaml");
const mainWorkflow = readYaml<PullRequestWorkflow>(".github/workflows/main.yaml");

function requiredStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function fakeCommand(directory: string, name: string, source: string): void {
  writeFileSync(join(directory, name), source, { mode: 0o755 });
}

describe("CLI coverage Pi search-tool provisioning", () => {
  // source-shape-contract: security -- Base-trusted and bootstrap paths must share one pinned, verified tool contract before untrusted tests invoke Pi
  it("installs pinned fd and ripgrep before CLI coverage can invoke Pi", () => {
    const actionSteps = action.runs.steps;
    const pullRequestJob = pullRequestWorkflow.jobs["cli-test-shards"];
    const mainJob = mainWorkflow.jobs["cli-test-shards"];
    const jobSteps = pullRequestJob.steps ?? [];
    const install = requiredStep(actionSteps, "Install pinned Pi search tools");
    const detect = requiredStep(jobSteps, "Detect trusted E2E support sharding");
    const bootstrap = requiredStep(jobSteps, "Install pinned Pi search tools (bootstrap)");

    expect(install.env).toEqual({
      FD_FIND_VERSION: "9.0.0-1",
      RIPGREP_VERSION: "14.1.0-1",
    });
    expect(pullRequestJob["runs-on"]).toBe("ubuntu-24.04");
    expect(mainJob["runs-on"]).toBe("ubuntu-24.04");
    expect(actionSteps.indexOf(install)).toBeLessThan(
      actionSteps.indexOf(requiredStep(actionSteps, "Install dependencies")),
    );
    expect(actionSteps.indexOf(install)).toBeLessThan(
      actionSteps.indexOf(requiredStep(actionSteps, "Run CLI coverage and E2E support shard")),
    );
    expect(detect.run).toContain("name: Install pinned Pi search tools");
    expect(detect.run).toContain('echo "pi-search-tools=true" >> "$GITHUB_OUTPUT"');
    expect(detect.run).toContain('echo "pi-search-tools=false" >> "$GITHUB_OUTPUT"');
    expect(bootstrap.if).toBe(
      "${{ steps.trusted-shard-capabilities.outputs.pi-search-tools != 'true' }}",
    );
    expect(bootstrap.env).toEqual(install.env);
    expect(bootstrap.run).toBe(install.run);
    expect(jobSteps.indexOf(bootstrap)).toBeLessThan(
      jobSteps.indexOf(requiredStep(jobSteps, "Run CLI coverage shard")),
    );

    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-cli-pi-tools-install-"));
    const fakeBin = join(temp, "bin");
    const callLog = join(temp, "calls.log");
    mkdirSync(fakeBin);
    fakeCommand(fakeBin, "sudo", '#!/bin/bash\nprintf \'sudo %s\\n\' "$*" >> "$CALL_LOG"\n');
    fakeCommand(
      fakeBin,
      "dpkg-query",
      `#!/bin/bash
printf 'dpkg-query %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  *fd-find) printf '%s' "$FD_FIND_VERSION" ;;
  *ripgrep) printf '%s' "$RIPGREP_VERSION" ;;
  *) exit 1 ;;
esac
`,
    );
    fakeCommand(
      fakeBin,
      "fdfind",
      "#!/bin/bash\nprintf 'fdfind %s\\n' \"$*\" >> \"$CALL_LOG\"\nprintf 'fdfind 9.0.0\\n'\n",
    );
    fakeCommand(
      fakeBin,
      "rg",
      "#!/bin/bash\nprintf 'rg %s\\n' \"$*\" >> \"$CALL_LOG\"\nprintf 'ripgrep 14.1.0\\n-SIMD -AVX\\n'\n",
    );

    try {
      const result = spawnSync("bash", ["-c", install.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          ...install.env,
          CALL_LOG: callLog,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
        timeout: 5_000,
      });
      expect(result.status, String(result.stderr)).toBe(0);
      const calls = readFileSync(callLog, "utf8");
      expect(calls).toContain("sudo apt-get update -qq");
      expect(calls).toContain(
        "sudo apt-get install -y --no-install-recommends fd-find=9.0.0-1 ripgrep=14.1.0-1",
      );
      expect(calls).toContain("dpkg-query -W -f=${Version} fd-find");
      expect(calls).toContain("dpkg-query -W -f=${Version} ripgrep");
      expect(calls).toContain("fdfind --version");
      expect(calls).toContain("rg --version");
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });
});
