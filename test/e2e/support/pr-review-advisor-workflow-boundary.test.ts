// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import YAML from "yaml";

import { validatePrReviewAdvisorWorkflow } from "../../../tools/pr-review-advisor/workflow-boundary.mts";

const run = "${{ github.run_id }}";
const attempt = "${{ github.run_attempt }}";
const temp = "${{ runner.temp }}";
const matrix = "${{ matrix.advisor.artifact_name }}";

it("accepts the checked-in Advisor workflow", () => {
  expect(validatePrReviewAdvisorWorkflow()).toEqual([]);
});

it("executes the Advisor runtime install with only the required Ubuntu source", () => {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-pr-review-advisor-apt-"));
  const fakeBin = join(directory, "bin");
  const advisorDirectory = join(directory, "advisor");
  const aptTrace = join(directory, "apt-trace");
  const ubuntuSources = join(directory, "ubuntu.sources");
  mkdirSync(fakeBin);
  mkdirSync(advisorDirectory);
  writeFileSync(
    join(fakeBin, "sudo"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >> "$APT_TRACE"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(fakeBin, "dpkg-query"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${@: -1}" in',
      '  fd-find) printf "9.0.0-1" ;;',
      '  ripgrep) printf "14.1.0-1" ;;',
      "  *) exit 1 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  try {
    const workflow = YAML.parse(
      readFileSync(join(process.cwd(), ".github/workflows/pr-review-advisor.yaml"), "utf8"),
    ) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const installStep = workflow.jobs["build-advisor-runtime"]?.steps?.find(
      (step) => step.name === "Install locked runtime",
    );
    const executableScript = installStep?.run?.replace(
      'UBUNTU_APT_SOURCES="/etc/apt/sources.list.d/ubuntu.sources"',
      `UBUNTU_APT_SOURCES=${JSON.stringify(ubuntuSources)}`,
    );
    const runInstall = () =>
      spawnSync("bash", ["-c", executableScript ?? ""], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          ADVISOR_DIR: advisorDirectory,
          APT_TRACE: aptTrace,
          FD_FIND_VERSION: "9.0.0-1",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RIPGREP_VERSION: "14.1.0-1",
        },
        timeout: 5_000,
      });

    writeFileSync(ubuntuSources, "Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\n");
    const success = runInstall();
    expect(success.status, success.stderr).toBe(0);
    expect(readFileSync(aptTrace, "utf8").trim().split("\n")).toEqual([
      `apt-get -o Dir::Etc::sourcelist=${ubuntuSources} -o Dir::Etc::sourceparts=- update -qq`,
      `apt-get -o Dir::Etc::sourcelist=${ubuntuSources} -o Dir::Etc::sourceparts=- install -y --no-install-recommends fd-find=9.0.0-1 ripgrep=14.1.0-1`,
    ]);

    rmSync(ubuntuSources);
    rmSync(aptTrace);
    const missingSource = runInstall();
    expect(missingSource.status).not.toBe(0);
    expect(missingSource.stdout).toContain("Required Ubuntu APT source is unavailable");
    expect(existsSync(aptTrace)).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it.each([
  [
    "context attempt suffix",
    `pr-review-advisor-context-${run}\n`,
    `pr-review-advisor-context-${run}-${attempt}\n`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context name attempt suffix",
    `name: pr-review-advisor-context-${run}\n          path: ${temp}`,
    `name: pr-review-advisor-context-${run}-${attempt}\n          path: ${temp}`,
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "context overwrite",
    "overwrite: true",
    "overwrite: false",
    "Unified advisor context artifact must survive failed-job and full reruns",
  ],
  [
    "specialist attempt suffix",
    `${matrix}-${attempt}`,
    matrix,
    "Unified advisor specialist artifacts must be unique per rerun attempt",
  ],
  [
    "successful CI requirement",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.conclusion == 'failure'",
    "Unified advisor green checks gate must require",
  ],
  [
    "successful CI bypass",
    "endsWith(github.event.workflow_run.display_title, ' gate true')))",
    "(endsWith(github.event.workflow_run.display_title, ' gate true') || true)))",
    "Unified advisor green checks gate must require",
  ],
  [
    "dependent job bypass",
    "if: ${{ github.repository == 'NVIDIA/NemoClaw' }}",
    "if: ${{ always() && github.repository == 'NVIDIA/NemoClaw' }}",
    "Unified advisor entry jobs must retain fail-closed conditions",
  ],
  [
    "source run identity",
    "format('Advisor after {0}', github.event.workflow_run.display_title)",
    "'Advisor after an unknown run'",
    "Unified advisor must retain completed CI / Pull Request identity",
  ],
  [
    "gate dependency",
    "needs: require-green-checks",
    "needs: []",
    "Unified advisor entry jobs must depend on the green checks gate",
  ],
  [
    "source commit binding",
    ".head.sha == $sha",
    ".head.sha != $sha",
    "Unified advisor green checks gate must retain .head.sha == $sha",
  ],
  [
    "source base binding",
    ".base.sha == $base_sha",
    ".base.sha != $base_sha",
    "Unified advisor green checks gate must retain .base.sha == $base_sha",
  ],
  [
    "analysis commit binding",
    "needs.require-green-checks.outputs.head_sha || ''",
    "needs.require-green-checks.outputs.base_sha || ''",
    "Unified advisor must prepare the PR revision from the successful checks run",
  ],
  [
    "Ubuntu archive source isolation",
    'sudo apt-get "${APT_SOURCE_OPTIONS[@]}" update -qq',
    "sudo apt-get update -qq",
    "Unified advisor runtime package install must use only Ubuntu archive sources",
  ],
  [
    "Ubuntu archive install isolation",
    'sudo apt-get "${APT_SOURCE_OPTIONS[@]}" install -y',
    "sudo apt-get install -y",
    "Unified advisor runtime package install must use only Ubuntu archive sources",
  ],
  [
    "Ubuntu archive source availability",
    'echo "::error::Required Ubuntu APT source is unavailable: $UBUNTU_APT_SOURCES"\n            exit 1',
    'echo "::error::Required Ubuntu APT source is unavailable: $UBUNTU_APT_SOURCES"\n            true',
    "Unified advisor runtime package install must use only Ubuntu archive sources",
  ],
])("rejects an unsafe Advisor %s mutation", (_case, before, after, error) => {
  const directory = mkdtempSync(join(tmpdir(), "nemoclaw-pr-review-advisor-"));
  const advisorPath = join(directory, "advisor.yaml");
  try {
    const source = readFileSync(
      join(process.cwd(), ".github/workflows/pr-review-advisor.yaml"),
      "utf8",
    );
    writeFileSync(advisorPath, source.replace(before, after));
    expect(validatePrReviewAdvisorWorkflow(advisorPath)).toEqual(
      expect.arrayContaining([expect.stringContaining(error)]),
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
