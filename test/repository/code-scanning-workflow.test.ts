// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readYaml, type Workflow } from "../helpers/e2e-workflow-contract";
import { WorkflowArtifactStore } from "../support/workflow-artifact-store";

const workflow = readYaml<Workflow>(".github/workflows/code-scanning.yaml");
const shellcheckSteps = workflow.jobs.shellcheck?.steps ?? [];

function requiredStep(name: string) {
  const step = shellcheckSteps.find((candidate) => candidate.name === name);
  assert(step, `ShellCheck workflow is missing step: ${name}`);
  return step;
}

function writeExecutable(file: string, content: string) {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function runShellCheckInstall({
  aptUpdateSucceeds = true,
  installedSupportsJson1 = true,
  preinstalledSupportsJson1,
}: {
  aptUpdateSucceeds?: boolean;
  installedSupportsJson1?: boolean;
  preinstalledSupportsJson1: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shellcheck-install-"));
  const bin = path.join(root, "bin");
  const trace = path.join(root, "trace");
  const installedMarker = path.join(root, "installed");
  fs.mkdirSync(bin);
  writeExecutable(
    path.join(bin, "shellcheck"),
    `#!/bin/sh
printf 'shellcheck:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *--format=json1*)
    [ "$PREINSTALLED_SUPPORTS_JSON1" = "true" ] ||
      { [ -f "$INSTALLED_MARKER" ] && [ "$INSTALLED_SUPPORTS_JSON1" = "true" ]; }
    ;;
  --version)
    printf 'version: 0.11.0\\n'
    ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "sudo"),
    `#!/bin/sh
printf 'sudo:%s\\n' "$*" >> "$TRACE"
case "$*" in
  *" update")
    [ "$APT_UPDATE_SUCCEEDS" = "true" ]
    ;;
  *" install -y shellcheck")
    : > "$INSTALLED_MARKER"
    ;;
esac
`,
  );
  const install = requiredStep("Install ShellCheck");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", install.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      APT_UPDATE_SUCCEEDS: String(aptUpdateSucceeds),
      PATH: `${bin}:${process.env.PATH}`,
      INSTALLED_MARKER: installedMarker,
      INSTALLED_SUPPORTS_JSON1: String(installedSupportsJson1),
      PREINSTALLED_SUPPORTS_JSON1: String(preinstalledSupportsJson1),
      RUNNER_TEMP: root,
      TRACE: trace,
    },
  });
  const calls = fs.readFileSync(trace, "utf8").trim().split("\n");
  fs.rmSync(root, { recursive: true, force: true });
  return { calls, result };
}

describe("ShellCheck SARIF workflow boundary", () => {
  // source-shape-contract: security -- ShellCheck conversion must install npm from an immutable reviewed action before executing the trusted converter
  it("installs npm from the immutable reviewed action bootstrap", () => {
    expect(requiredStep("Install reviewed npm").uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/setup-reviewed-npm@98669f24d35f18e49b6b2769cd68709509ea24f2",
    );
  });

  it("keeps a preinstalled ShellCheck only when its json1 formatter works (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: true });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("installs and validates ShellCheck when the preinstalled binary lacks json1 (#7684)", () => {
    const { calls, result } = runShellCheckInstall({ preinstalledSupportsJson1: false });

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
      "shellcheck:--version",
    ]);
  });

  it("fails clearly when the bounded ShellCheck package-index update fails (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      aptUpdateSucceeds: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update apt package indexes for ShellCheck");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
    ]);
  });

  it("rejects an installed ShellCheck without json1 support (#7684)", () => {
    const { calls, result } = runShellCheckInstall({
      installedSupportsJson1: false,
      preinstalledSupportsJson1: false,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Installed ShellCheck does not support --format=json1");
    expect(calls).toEqual([
      expect.stringContaining("shellcheck:--format=json1"),
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 update",
      "sudo:apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 install -y shellcheck",
      expect.stringContaining("shellcheck:--format=json1"),
    ]);
  });
});

const partitionAggregate = workflow.jobs["codeql-javascript-complete"]!;

function partitionStep(owner: typeof partitionAggregate, name: string) {
  const step = owner.steps?.find((candidate) => candidate.name === name);
  assert(step, `CodeQL workflow is missing step: ${name}`);
  return step;
}

describe("Complete CodeQL query partition qualification", () => {
  // source-shape-contract: security -- Complementary query filters and separate SARIF categories preserve complete CodeQL coverage
  it("preserves complete JavaScript coverage across disjoint query partitions", () => {
    const partitions = workflow.jobs["codeql-javascript"]!;
    expect(partitions.strategy?.matrix).toEqual({
      include: [
        {
          partition: "a-m",
          config: JSON.stringify({ "query-filters": [{ include: { id: "/^js\\/[a-m]/" } }] }),
        },
        {
          partition: "other",
          config: JSON.stringify({ "query-filters": [{ exclude: { id: "/^js\\/[a-m]/" } }] }),
        },
      ],
    });
    expect(partitions.env).toEqual({
      QUERY_SUITE: "security-and-quality",
      QUERY_LANGUAGE: "javascript-typescript",
    });
    expect(partitionStep(partitions, "Initialize CodeQL").with).toMatchObject({
      languages: "${{ env.QUERY_LANGUAGE }}",
      queries: "${{ env.QUERY_SUITE }}",
      config: "${{ matrix.config }}",
    });
    expect(partitionStep(partitions, "Perform CodeQL analysis").with).toEqual({
      upload: false,
      category: "/language:javascript-typescript/partition:${{ matrix.partition }}",
    });
    expect(partitionAggregate.needs).toEqual(["codeql-javascript", "codeql-javascript-report"]);
    expect(partitionAggregate.if).toBe("${{ always() }}");
    expect(
      partitionStep(partitionAggregate, "Require every query partition to succeed").env,
    ).toEqual({
      PARTITION_RESULT: "${{ needs.codeql-javascript.result }}",
      REPORT_RESULT: "${{ needs.codeql-javascript-report.result }}",
    });
    const python = workflow.jobs.codeql!;
    expect(python.needs).toBeUndefined();
    expect(python.strategy?.matrix).toEqual({ language: ["python"] });
    expect(python.name).toBe("CodeQL (python)");
    expect(python["timeout-minutes"]).toBe(15);
    expect(publisher["timeout-minutes"]).toBe(15);
    expect(partitionAggregate["timeout-minutes"]).toBe(1);
    expect(publisher.needs).toEqual(["codeql-javascript"]);
    expect(partitionStep(python, "Initialize CodeQL").with).toEqual({
      languages: "${{ matrix.language }}",
      queries: "security-and-quality",
    });
    expect(partitionStep(python, "Initialize CodeQL").if).toBeUndefined();
    expect(partitionStep(python, "Perform CodeQL analysis").if).toBeUndefined();
    expect(
      partitionStep(publisher, "Publish complete JavaScript report in the former category").env,
    ).toEqual({ CODEQL_ACTION_ANALYSIS_KEY: ".github/workflows/code-scanning.yaml:codeql" });
    expect(
      partitionStep(publisher, "Publish complete JavaScript report in the former category").with,
    ).toEqual({
      sarif_file: "codeql-sarif",
      category: legacyCategory.slice(0, -1),
      matrix: '{"language":"javascript-typescript"}',
    });
    expect([
      partitionStep(publisher, "Download first JavaScript query report").with,
      partitionStep(publisher, "Download complementary JavaScript query report").with,
    ]).toEqual([
      {
        name: "codeql-javascript-sarif-${{ github.run_id }}-a-m",
        path: "codeql-sarif/a-m",
        "digest-mismatch": "error",
      },
      {
        name: "codeql-javascript-sarif-${{ github.run_id }}-other",
        path: "codeql-sarif/other",
        "digest-mismatch": "error",
      },
    ]);
    expect(
      partitionStep(
        workflow.jobs["codeql-javascript"]!,
        "Retain JavaScript query report for complete publication",
      ).with?.["if-no-files-found"],
    ).toBe("error");
  });

  const states = ["success", "failure", "cancelled", "skipped"];
  const qualificationStates = states
    .flatMap((partition) => states.map((report) => ({ partition, report, python: "success" })))
    .concat(
      states
        .filter((python) => python !== "success")
        .map((python) => ({ partition: "success", report: "success", python })),
    );
  it.each(qualificationStates)(
    "requires complete JavaScript queries and publication ($partition, $report, $python)",
    ({ partition, report, python }) => {
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          partitionStep(partitionAggregate, "Require every query partition to succeed").run!,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            PARTITION_RESULT: partition,
            REPORT_RESULT: report,
            PYTHON_RESULT: python,
          },
        },
      );
      expect(result.status).toBe(partition === "success" && report === "success" ? 0 : 1);
    },
  );
});

const publisher = workflow.jobs["codeql-javascript-report"]!;
const legacyCategory =
  ".github/workflows/code-scanning.yaml:codeql/language:javascript-typescript/";

function exerciseReportIdentity(modify: (files: string[]) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-codeql-report-"));
  const original = ["a-m", "other"].map((partition) => ({
    version: "2.1.0",
    runs: [
      {
        automationDetails: {
          id: `/language:javascript-typescript/partition:${partition}/`,
          description: "retain metadata",
        },
        tool: { driver: { name: "CodeQL", rules: [{ id: `js/${partition}` }] } },
        results: [
          {
            ruleId: `js/${partition}`,
            message: { text: "retain this finding" },
            partialFingerprints: { primaryLocationLineHash: partition },
          },
        ],
        properties: { opaqueMetadata: [1, 2, 3] },
      },
    ],
  }));
  const files = ["a-m", "other"].map((partition) =>
    path.join(root, "codeql-sarif", partition, "javascript.sarif"),
  );
  try {
    files.forEach((file, index) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(original[index]));
    });
    modify(files);
    const before = files.map((file) =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
    );
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-e",
        "-c",
        partitionStep(publisher, "Prepare complete JavaScript report identity").run!,
      ],
      { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    const after = files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null));
    return { result, before, after, original };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("CodeQL complete report compatibility", () => {
  it("consumes retained and replaced partition reports after a failed-job rerun", () => {
    const upload = partitionStep(
      workflow.jobs["codeql-javascript"]!,
      "Retain JavaScript query report for complete publication",
    ).with!;
    const artifactName = (template: unknown, partition: string, attempt: number, run = 71) =>
      String(template)
        .replaceAll("${{ github.run_id }}", String(run))
        .replaceAll("${{ github.run_attempt }}", String(attempt))
        .replaceAll("${{ matrix.partition }}", partition);
    const retained = new WorkflowArtifactStore();
    const publish = (partition: string, attempt: number, body: string) => {
      const name = artifactName(upload.name, partition, attempt);
      retained.publish(name, body, upload.overwrite === true);
    };
    const downloads = [
      "Download first JavaScript query report",
      "Download complementary JavaScript query report",
    ].map((name) => partitionStep(publisher, name).with!.name);

    const consume = (files: string[], run = 71) => {
      retained.materialize(artifactName(downloads[0], "", 2, run), files[0]!);
      retained.materialize(artifactName(downloads[1], "", 2, run), files[1]!);
    };
    const { result, after } = exerciseReportIdentity((files) => {
      publish("a-m", 1, fs.readFileSync(files[0]!, "utf8"));
      publish("other", 1, "report from interrupted job");
      const replacement = JSON.parse(fs.readFileSync(files[1]!, "utf8"));
      replacement.runs[0].results[0].message.text = "successful replacement partition";
      publish("other", 2, JSON.stringify(replacement));
      consume(files);
    });
    expect(result.status, result.stderr).toBe(0);
    expect(after.map((body) => JSON.parse(body!).runs[0].results[0].message.text)).toEqual([
      "retain this finding",
      "successful replacement partition",
    ]);
    expect(retained.size).toBe(2);
    const unrelatedRun = exerciseReportIdentity((files) => consume(files, 72));
    expect(unrelatedRun.result.status).not.toBe(0);
    expect(unrelatedRun.after).toEqual([null, null]);
  });

  it("changes only the category while retaining both reports' findings and metadata", () => {
    const { result, after, original } = exerciseReportIdentity();
    expect(result.status, result.stderr).toBe(0);
    original.forEach((report, index) => {
      const expected = structuredClone(report);
      expected.runs[0]!.automationDetails.id = legacyCategory;
      expect(JSON.parse(after[index]!)).toEqual(expected);
    });
  });

  it.each([
    { fault: "missing", modify: (files: string[]) => fs.rmSync(files[1]!) },
    {
      fault: "malformed",
      modify: (files: string[]) => fs.writeFileSync(files[1]!, "{invalid-json"),
    },
    {
      fault: "wrong-category",
      modify: (files: string[]) => {
        const report = JSON.parse(fs.readFileSync(files[1]!, "utf8"));
        report.runs[0].automationDetails.id = "unrelated/";
        fs.writeFileSync(files[1]!, JSON.stringify(report));
      },
    },
  ])("refuses $fault complementary evidence before changing either report", ({ modify }) => {
    const { result, before, after } = exerciseReportIdentity(modify);
    expect(result.status).not.toBe(0);
    expect(after).toEqual(before);
  });
});
