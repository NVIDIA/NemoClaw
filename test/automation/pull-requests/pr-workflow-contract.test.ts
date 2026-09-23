// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  type CompositeAction,
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type CiWorkflow = {
  "run-name"?: string;
  on?: { pull_request?: { paths?: string[]; types?: string[] } };
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob & { if?: string; needs?: string | string[] }>;
};

const trustedCheckoutAction = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const trustedSetupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const reviewedNpmAction = "./.github/actions/setup-reviewed-npm";

const cliShardCount = "12";
const cliShardTimeoutMinutes = 30;
const dependencyInstallJobs = [
  "build-typecheck",
  "cli-tests",
  "installer-integration",
  "cli-test-shards",
  "plugin-tests",
  "static-checks",
] as const;

function stepRuns(jobOrAction: WorkflowJob | CompositeAction): string[] {
  const steps = "runs" in jobOrAction ? jobOrAction.runs.steps : (jobOrAction.steps ?? []);
  return steps.flatMap((step) => (step.run ? [step.run] : []));
}

function stepUses(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : []));
}

function requiredStep(action: CompositeAction, stepName: string): WorkflowStep {
  const step = action.runs.steps.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing shared action step: ${stepName}`);
  }
  return step;
}

function requiredWorkflowStep(job: WorkflowJob, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing workflow step: ${stepName}`);
  }
  return step;
}

function runWorkflowShellStep(
  step: WorkflowStep,
  env: Record<string, string>,
  cwd = process.cwd(),
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", step.run ?? ""], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...step.env, ...env },
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

const reviewedSdk = {
  artifactName: "reviewed-sdk.tgz",
  integrity: "sha512-reviewed",
  packageSpec: "@nvidia/openshell-sdk@1.0.0",
};
const reviewedBundle = `reviewed-openshell-sdk-${createHash("sha256")
  .update(`${JSON.stringify([reviewedSdk])}\n`)
  .digest("hex")}`;
const mainSdkArtifact = {
  id: 100,
  name: reviewedBundle,
  expired: false,
  workflow_run: { id: 200, head_branch: "main", head_repository_id: 123 },
};
const mainSdkRun = {
  path: ".github/workflows/main.yaml",
  head_branch: "main",
  event: "push",
  head_repository: { full_name: "NVIDIA/NemoClaw" },
  repository: { full_name: "NVIDIA/NemoClaw" },
};

type SdkPackageLocatorFixture = Readonly<{
  artifacts?: readonly unknown[];
  inspectorOutput?: string;
  inspectorRequired?: unknown;
  run?: unknown;
  step: WorkflowStep;
  apiFailure?: boolean;
  headRepository?: string;
}>;

function runSdkPackageLocator(fixture: SdkPackageLocatorFixture): Readonly<{
  githubOutput: string;
  requests: string;
  result: ReturnType<typeof runWorkflowShellStep>;
}> {
  const tempRoot = mkdtempSync(join(tmpdir(), "nemoclaw-sdk-package-locator-"));
  try {
    const trustedRoot = join(tempRoot, ".trusted-sdk-package-decision");
    const inspectorDirectory = join(trustedRoot, "scripts/checks");
    const fakeBin = join(tempRoot, "bin");
    mkdirSync(inspectorDirectory, { recursive: true });
    mkdirSync(join(trustedRoot, "ci"));
    mkdirSync(fakeBin);
    writeFileSync(
      join(trustedRoot, "ci/reviewed-npm-audit.json"),
      JSON.stringify({ sourceRegistryPackage: reviewedSdk }),
    );
    writeFileSync(
      join(inspectorDirectory, "prepare-ci-npm-install.mts"),
      `process.stdout.write(${JSON.stringify(fixture.inspectorOutput ?? JSON.stringify({ artifactName: "reviewed-sdk.tgz", required: fixture.inspectorRequired ?? true }))});\n`,
    );
    writeFileSync(
      join(fakeBin, "gh"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const request = process.argv.slice(2).join(" ");',
        'fs.appendFileSync(process.env.REQUEST_LOG, request + "\\n");',
        'if (process.env.API_FAILURE === "true") { process.stderr.write("private diagnostic"); process.exit(1); }',
        'if (request.includes("actions/artifacts?name=")) { process.stdout.write(process.env.ARTIFACTS); }',
        'else if (request.includes("actions/runs/200")) { process.stdout.write(process.env.SDK_RUN); }',
        "else process.exit(64);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const outputPath = join(tempRoot, "github-output");
    const requestLog = join(tempRoot, "requests");
    writeFileSync(requestLog, "");
    const result = runWorkflowShellStep(
      fixture.step,
      {
        ARTIFACTS: JSON.stringify([{ artifacts: fixture.artifacts ?? [mainSdkArtifact] }]),
        API_FAILURE: String(fixture.apiFailure ?? false),
        SDK_RUN: JSON.stringify(fixture.run ?? mainSdkRun),
        REQUEST_LOG: requestLog,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_WORKSPACE: tempRoot,
        REPOSITORY_ID: "123",
        HEAD_REPOSITORY: fixture.headRepository ?? "NVIDIA/NemoClaw",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      tempRoot,
    );
    return {
      githubOutput: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "",
      requests: readFileSync(requestLog, "utf8"),
      result,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function workflowJob(
  id: unknown,
  name: unknown,
  conclusion: unknown,
  status: unknown = "completed",
): Record<string, unknown> {
  return { conclusion, id, name, status };
}

function workflowJobListing(
  jobs: Record<string, unknown>[],
  totalCount: unknown = jobs.length,
): string {
  return JSON.stringify({ jobs, total_count: totalCount });
}

function runWorkflowShellStepWithJobs(
  step: WorkflowStep,
  env: Record<string, string>,
  jobsResponse: string,
  ghExitCode = 0,
): { status: number | null; stdout: string; stderr: string } {
  const temp = mkdtempSync(join(tmpdir(), "nemoclaw-workflow-jobs-"));
  const fakeBin = join(temp, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const expected = `api repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.RUN_ID}/attempts/${process.env.RUN_ATTEMPT}/jobs?per_page=100`;",
      'if (process.argv.slice(2).join(" ") !== expected) process.exit(64);',
      "const exitCode = Number(process.env.FAKE_GH_EXIT_CODE);",
      "if (exitCode !== 0) process.exit(exitCode);",
      'process.stdout.write(process.env.FAKE_GH_RESPONSE ?? "");',
    ].join("\n"),
    { mode: 0o755 },
  );
  try {
    return runWorkflowShellStep(step, {
      FAKE_GH_EXIT_CODE: String(ghExitCode),
      FAKE_GH_RESPONSE: jobsResponse,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RUN_ATTEMPT: "2",
      RUN_ID: "123",
      RUN_URL: "https://github.com/NVIDIA/NemoClaw/actions/runs/123",
      ...env,
    });
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

function installerHashTrustViolations(workflow: CiWorkflow): string[] {
  const steps = workflow.jobs["check-hash"]?.steps ?? [];
  const baseCheckout = steps.find(
    (step) => step.name === "Checkout base-trusted installer hash action",
  );
  const prCheck = steps.find(
    (step) => step.name === "Verify pull request installer hashes from base-trusted code",
  );
  const allowedExecutors = new Set([
    "./.trusted-installer-hash/.github/actions/ci-installer-hash-check",
    "./.github/actions/ci-installer-hash-check",
  ]);

  return [
    ...(baseCheckout ? [] : ["missing base-trusted installer hash checkout"]),
    ...(baseCheckout?.uses === trustedCheckoutAction
      ? []
      : ["base-trusted installer hash checkout must use the pinned checkout action"]),
    ...(baseCheckout?.with?.ref === "${{ github.event.pull_request.base.sha }}"
      ? []
      : ["base-trusted installer hash checkout must use the PR base SHA"]),
    ...(baseCheckout?.with?.path === ".trusted-installer-hash"
      ? []
      : ["base-trusted installer hash checkout must use the trusted action path"]),
    ...(prCheck?.if === "github.event_name == 'pull_request'" &&
    prCheck.uses === "./.trusted-installer-hash/.github/actions/ci-installer-hash-check"
      ? []
      : ["pull request installer hashes must use only the base-trusted action"]),
    ...steps.flatMap((step) => [
      ...(step.uses === "./.github/actions/ci-installer-hash-check" &&
      step.if !== "github.event_name != 'pull_request'"
        ? ["installer hash action from the latest PR commit must not execute for pull requests"]
        : []),
      ...(step.uses?.includes("ci-installer-hash-check") && !allowedExecutors.has(step.uses)
        ? [`unapproved installer hash executor: ${step.uses}`]
        : []),
    ]),
  ];
}

describe("pull request and main workflow contracts", () => {
  const prWorkflow = readYaml<CiWorkflow>(".github/workflows/pr.yaml");
  const mainWorkflow = readYaml<CiWorkflow>(".github/workflows/main.yaml");

  const installerHashWorkflow = readYaml<CiWorkflow>(".github/workflows/installer-hash-check.yaml");
  const advisorWorkflow = readYaml<CiWorkflow>(".github/workflows/pr-review-advisor.yaml");
  const sdkPackageJob = mainWorkflow.jobs["package-openshell-sdk"];

  const sharedActions = {
    staticChecks: readYaml<CompositeAction>(".github/actions/ci-static-checks/action.yaml"),
    compileArtifacts: readYaml<CompositeAction>(".github/actions/ci-compile-artifacts/action.yaml"),
    buildTypecheck: readYaml<CompositeAction>(".github/actions/ci-build-typecheck/action.yaml"),
    cliCoverageShard: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-shard/action.yaml",
    ),
    cliCoverageMerge: readYaml<CompositeAction>(
      ".github/actions/ci-cli-coverage-merge/action.yaml",
    ),
    pluginCoverage: readYaml<CompositeAction>(".github/actions/ci-plugin-coverage/action.yaml"),
    installerIntegration: readYaml<CompositeAction>(
      ".github/actions/ci-installer-integration/action.yaml",
    ),
  };

  it.each([
    ["pull_request", prWorkflow],
    ["main", mainWorkflow],
  ] as const)("keeps the %s CLI coverage shard budget aligned", (_workflowName, workflow) => {
    expect(workflow.jobs["cli-test-shards"]?.["timeout-minutes"]).toBe(cliShardTimeoutMinutes);
  });

  // source-shape-contract: security -- Credential-free workflow structure prevents pull request code from receiving Hugging Face or checkout credentials
  it("verifies changed Hugging Face catalog references without credentials", () => {
    const job = prWorkflow.jobs["hugging-face-models"];
    const filterStep = prWorkflow.jobs.changes.steps?.find((step) => step.id === "filter");
    const filters = YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;
    const huggingFaceModelFilters = filters.hugging_face_models ?? [];

    expect(
      huggingFaceModelFilters.some((pattern) =>
        pattern.includes("src/lib/inference/serving/catalog-loader.ts"),
      ),
    ).toBe(true);
    expect(
      huggingFaceModelFilters.some((pattern) =>
        pattern.includes("src/lib/inference/serving/generate-catalog.ts"),
      ),
    ).toBe(true);
    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.hugging_face_models == 'true'");
    expect(stepUses(job)).toEqual([
      trustedCheckoutAction,
      trustedSetupNodeAction,
      reviewedNpmAction,
    ]);
    expect(requiredWorkflowStep(job, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(requiredWorkflowStep(job, "Install dependencies").run).toBe(
      "npm ci --ignore-scripts --no-audit --no-fund",
    );
    expect(requiredWorkflowStep(job, "Verify Hugging Face model references").run).toBe(
      "npm run catalog:verify-hugging-face",
    );
    expect(JSON.stringify(job)).not.toMatch(/HF_TOKEN|HUGGING_FACE_HUB_TOKEN|secrets\./u);
  });

  // source-shape-contract: security -- Required pre-merge execution and credential-free inputs keep the real OpenClaw install proof on the reviewed PR boundary
  it("requires the real patched OpenClaw distribution proof before merge", () => {
    const job = prWorkflow.jobs["real-openclaw-dist-harness"];

    expect(job.needs).toBe("changes");
    expect(job.if).toBe("needs.changes.outputs.code == 'true'");
    expect(job["timeout-minutes"]).toBe(20);
    expect(stepUses(job)).toEqual([
      trustedCheckoutAction,
      trustedSetupNodeAction,
      reviewedNpmAction,
    ]);
    expect(requiredWorkflowStep(job, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(requiredWorkflowStep(job, "Install test dependencies").run).toBe(
      "npm ci --ignore-scripts --no-audit --no-fund",
    );
    expect(requiredWorkflowStep(job, "Build generated harness inputs").run).toBe(
      "npm run build:policy-boundary && npm run catalog:compile",
    );
    const proof = requiredWorkflowStep(job, "Audit the real patched OpenClaw distribution");
    expect(proof.env).toEqual({ NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS: "1" });
    expect(proof.run).toContain("openclaw-real-patched-dist-harness.test.ts");
    expect(JSON.stringify(job)).not.toMatch(/secrets\./u);
  });

  // source-shape-contract: security -- Pull request jobs must never receive the GitHub Packages credential
  it("does not grant package access to pull request jobs", () => {
    expect(prWorkflow.permissions).toEqual({ contents: "read" });
    expect(
      Object.entries(prWorkflow.jobs).filter(([, job]) => job.permissions?.packages !== undefined),
    ).toEqual([]);
    expect(requiredWorkflowStep(prWorkflow.jobs["static-checks"], "Run static checks").env).toEqual(
      {
        PR_NUMBER: "${{ github.event.pull_request.number }}",
        BASE_SHA: "${{ github.event.pull_request.base.sha }}",
        HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      },
    );
    expect(
      requiredWorkflowStep(prWorkflow.jobs["cli-test-shards"], "Run CLI coverage shard").env,
    ).toEqual({
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
  });

  // source-shape-contract: security -- Trusted main jobs may read packages only where the reviewed installer consumes the token
  it("limits main package reads to dependency-install jobs", () => {
    expect(mainWorkflow.permissions).toEqual({ contents: "read" });
    expect(
      Object.entries(mainWorkflow.jobs)
        .filter(([, job]) => job.permissions?.packages !== undefined)
        .map(([jobName, job]) => [jobName, job.permissions?.packages] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ).toEqual([
      ["build-typecheck", "read"],
      ["cli-test-shards", "read"],
      ["cli-tests", "read"],
      ["compile-artifacts", "read"],
      ["installer-integration", "read"],
      ["package-openshell-sdk", "read"],
      ["plugin-tests", "read"],
      ["static-checks", "read"],
    ]);
  });

  // source-shape-contract: security -- The shared action must pass a package token only on trusted main pushes
  it("provides the package token only to trusted main dependency installation", () => {
    const actions = [
      sharedActions.staticChecks,
      sharedActions.compileArtifacts,
      sharedActions.cliCoverageMerge,
      sharedActions.installerIntegration,
      sharedActions.cliCoverageShard,
      sharedActions.pluginCoverage,
    ];
    expect(
      actions.map((action) => requiredStep(action, "Setup Node.js").with?.["registry-url"]),
    ).toEqual(actions.map(() => undefined));
    expect(actions.map((action) => requiredStep(action, "Setup Node.js").with?.scope)).toEqual(
      actions.map(() => undefined),
    );
    expect(actions.map((action) => requiredStep(action, "Install dependencies").env)).toEqual(
      actions.map(() => ({
        NODE_AUTH_TOKEN: "${{ github.event_name == 'push' && github.token || '' }}",
      })),
    );
    expect(actions.map((action) => requiredStep(action, "Install dependencies").run)).toEqual([
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh"',
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh"',
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh" none',
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh"',
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh" production',
      'bash "$GITHUB_ACTION_PATH/../ci-install-dependencies.sh"',
    ]);
  });

  it.each([
    [
      "docs-only checks",
      requiredWorkflowStep(prWorkflow.jobs["docs-only-checks"], "Install hadolint"),
    ],
    ["shared static checks", requiredStep(sharedActions.staticChecks, "Install hadolint")],
  ])("retries transient hadolint downloads in %s", (_name, step) => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-hadolint-retry-"));
    try {
      const bin = join(root, "bin");
      const target = join(bin, "hadolint");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "curl"),
        `#!/bin/sh
set -eu
retry=0
all_errors=0
delay=0
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --retry) [ "\${2:-}" = 3 ] || exit 91; retry=1; shift 2 ;;
    --retry-all-errors) all_errors=1; shift ;;
    --retry-delay) [ "\${2:-}" = 2 ] || exit 92; delay=1; shift 2 ;;
    -o) destination="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$retry:$all_errors:$delay" = 1:1:1 ] || exit 93
printf 'fake hadolint' > "$destination"
`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "sha256sum"),
        `#!/bin/sh
printf '%s  %s\\n' '6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47' "$1"
`,
        { mode: 0o755 },
      );
      const testStep = {
        ...step,
        run: step.run?.replaceAll("/usr/local/bin/hadolint", target),
      };
      const result = runWorkflowShellStep(testStep, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("fake hadolint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // source-shape-contract: security -- The trusted split must retain test-config coverage after compiling candidate production code
  it.each([
    ["pull request", prWorkflow],
    ["main", mainWorkflow],
  ] as const)(
    "keeps %s plugin test typechecking after the trusted production build",
    (_name, workflow) => {
      expect([workflow.jobs["build-typecheck"].needs].flat()).toContain("compile-artifacts");
      expect(requiredStep(sharedActions.buildTypecheck, "Typecheck plugin tests").run).toBe(
        "npm --prefix nemoclaw exec -- tsc --noEmit -p nemoclaw/tsconfig.test.json",
      );
      expect(stepRuns(sharedActions.buildTypecheck)).not.toContain(
        "npm --prefix nemoclaw run typecheck",
      );
    },
  );
  it.each([
    ["CLI shards", requiredStep(sharedActions.cliCoverageShard, "Install pinned Pi search tools")],
    [
      "Advisor runtime",
      requiredWorkflowStep(advisorWorkflow.jobs["build-advisor-runtime"], "Install locked runtime"),
    ],
  ])("refreshes only Ubuntu package metadata for %s", (_name, installStep) => {
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-ubuntu-apt-sources-"));
    const fakeBin = join(temp, "bin");
    const aptArgs = join(temp, "apt-args");
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "sudo"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$APT_ARGS"\nexit 86\n',
      { mode: 0o755 },
    );

    try {
      const result = runWorkflowShellStep(installStep, {
        APT_ARGS: aptArgs,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      });
      expect(result.status).toBe(86);
      expect(readFileSync(aptArgs, "utf8").trim().split("\n")).toEqual([
        "apt-get",
        "update",
        "-qq",
        "-o",
        "Dir::Etc::sourcelist=sources.list.d/ubuntu.sources",
        "-o",
        "Dir::Etc::sourceparts=-",
      ]);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  // source-shape-contract: security -- PR dependency jobs receive only the base-approved SDK archive after credential-free integrity verification
  it("passes only the base-packaged SDK archive to pull request dependency jobs", () => {
    const job = prWorkflow.jobs["openshell-sdk-package"];
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    expect(requiredWorkflowStep(job, "Checkout base package decision").with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      path: ".trusted-sdk-package-decision",
    });
    expect(requiredWorkflowStep(job, "Download approved SDK bundle").with).toMatchObject({
      "artifact-ids": "${{ steps.locate.outputs.artifact_id }}",
      "run-id": "${{ steps.locate.outputs.run_id }}",
    });
    const verification = requiredWorkflowStep(
      job,
      "Verify selected SDK archive against base policy and PR locks",
    );
    expect(verification.env?.NEMOCLAW_CI_NPM_PACKAGE_MODE).toBe("artifact");
    expect(verification.run).toContain(
      "node .trusted-sdk-package-decision/scripts/checks/prepare-ci-npm-install.mts",
    );
    expect(job.steps!.indexOf(verification)).toBeLessThan(
      job.steps!.indexOf(requiredWorkflowStep(job, "Publish SDK archive inside this CI run")),
    );
  });

  const locateSdk = requiredWorkflowStep(
    prWorkflow.jobs["openshell-sdk-package"],
    "Locate approved SDK artifact",
  );

  it("reuses a main SDK artifact without a package run for the PR commit", () => {
    const { result, githubOutput, requests } = runSdkPackageLocator({ step: locateSdk });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(githubOutput).toContain("artifact_id=100");
    expect(githubOutput).toContain("run_id=200");
    expect(requests).toContain(
      `--paginate --slurp repos/NVIDIA/NemoClaw/actions/artifacts?name=${reviewedBundle}`,
    );
    expect(requests.trim().split("\n")).toHaveLength(2);
  });

  it("skips SDK artifact lookup when the trusted inspector does not require a package", () => {
    const { result, githubOutput, requests } = runSdkPackageLocator({
      step: locateSdk,
      inspectorRequired: false,
    });
    expect(result.status).toBe(0);
    expect(githubOutput).toBe("required=false\n");
    expect(requests).toBe("");
  });

  it.each(["true", 1, {}, null])(
    "rejects malformed package decision %j before artifact lookup",
    (required) => {
      const { result, requests } = runSdkPackageLocator({
        step: locateSdk,
        inspectorOutput: JSON.stringify({ required }),
      });
      expect(result.status).not.toBe(0);
      expect(requests).toBe("");
    },
  );

  it("rejects fork access before SDK artifact lookup", () => {
    const { result, requests } = runSdkPackageLocator({
      step: locateSdk,
      headRepository: "example/fork",
    });
    expect(result.status).not.toBe(0);
    expect(requests).toBe("");
  });

  it.each([
    { ...mainSdkArtifact, expired: true },
    { ...mainSdkArtifact, name: "another-package" },
    {
      ...mainSdkArtifact,
      workflow_run: { ...mainSdkArtifact.workflow_run, head_branch: "feature" },
    },
    {
      ...mainSdkArtifact,
      workflow_run: { ...mainSdkArtifact.workflow_run, head_repository_id: 456 },
    },
  ])("rejects unavailable or untrusted SDK artifact %j", (artifact) => {
    const { result, requests } = runSdkPackageLocator({ step: locateSdk, artifacts: [artifact] });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("gh workflow run main.yaml --ref main");
    expect(requests.trim().split("\n")).toHaveLength(1);
  });

  it.each([
    { ...mainSdkRun, path: ".github/workflows/pr.yaml" },
    { ...mainSdkRun, event: "pull_request_target" },
    { ...mainSdkRun, head_branch: "feature" },
    { ...mainSdkRun, head_repository: { full_name: "example/fork" } },
  ])("rejects untrusted SDK producer %j", (run) => {
    const { result, githubOutput } = runSdkPackageLocator({ step: locateSdk, run });
    expect(result.status).not.toBe(0);
    expect(githubOutput).not.toContain("artifact_id=");
  });

  it("accepts a manually refreshed archive from trusted main", () => {
    const { result } = runSdkPackageLocator({
      step: locateSdk,
      run: { ...mainSdkRun, event: "workflow_dispatch" },
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("reports artifact lookup failures without private API diagnostics", () => {
    const { result } = runSdkPackageLocator({ step: locateSdk, apiFailure: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Restore Actions access");
    expect(result.stdout).not.toContain("private diagnostic");
    expect(result.stderr).not.toContain("private diagnostic");
  });

  // source-shape-contract: security -- Every PR dependency consumer must receive the verified archive without package access
  it.each(dependencyInstallJobs)("passes the verified SDK archive to %s", (jobName) => {
    const job = prWorkflow.jobs[jobName];
    expect(job.needs).toEqual(expect.arrayContaining(["changes", "openshell-sdk-package"]));
    expect(job.permissions?.packages).toBeUndefined();
    const download = requiredWorkflowStep(job, "Download verified OpenShell SDK archive");
    expect(download.uses).toBe(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(download.if).toBe("needs.openshell-sdk-package.outputs.required == 'true'");
    expect(download.with).toMatchObject({
      name: "openshell-sdk-package",
      path: "${{ runner.temp }}/openshell-sdk",
    });
  });

  // source-shape-contract: security -- Package credentials stay in the main-only job that uploads verified SDK archives
  it("keeps package access out of pull request controlled execution", () => {
    expect(sdkPackageJob.permissions).toEqual({ contents: "read", packages: "read" });
    expect(sdkPackageJob.if).toBe(
      "github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main'",
    );
    expect(
      requiredWorkflowStep(sdkPackageJob, "Checkout trusted package verifier").with,
    ).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
    const fetch = requiredWorkflowStep(
      sdkPackageJob,
      "Download and verify approved OpenShell SDK packages",
    );
    expect(fetch.env?.NODE_AUTH_TOKEN).toBe("${{ github.token }}");
    expect(fetch.env?.NEMOCLAW_OPEN_SHELL_SDK_INCLUDE_AVAILABLE_REPLACEMENT).toBe("1");
    expect((sdkPackageJob.steps ?? []).filter((step) => step.env?.NODE_AUTH_TOKEN)).toEqual([
      fetch,
    ]);
    expect(
      requiredWorkflowStep(sdkPackageJob, "Upload verified OpenShell SDK archive").with,
    ).toMatchObject({
      name: "${{ steps.package.outputs.bundle_name }}",
      path: "${{ runner.temp }}/openshell-sdk/*.tgz",
      "retention-days": 90,
    });
  });

  // source-shape-contract: security -- Both producer and consumer derive the archive identity from trusted package policy rather than PR metadata
  it("derives the package and archive identity from the base-controlled decision", () => {
    const producer = requiredWorkflowStep(
      sdkPackageJob,
      "Download and verify approved OpenShell SDK packages",
    );
    const identity =
      "jq -cS '[.sourceRegistryPackage, .sourceRegistryPackageReplacement // empty]'";
    expect(producer.run).toContain(identity);
    expect(locateSdk.run).toContain(identity);
    expect(locateSdk.run).toContain(".trusted-sdk-package-decision/ci/reviewed-npm-audit.json");
  });

  it.each([false, true])(
    "publishes a stable archive identity with replacement metadata: %s",
    (withReplacement) => {
      const temp = mkdtempSync(join(tmpdir(), "nemoclaw-sdk-bundle-identity-"));
      const replacement = {
        ...reviewedSdk,
        artifactName: "next-sdk.tgz",
        integrity: "sha512-next",
        packageSpec: "@nvidia/openshell-sdk@2.0.0",
      };
      const approved = withReplacement ? [reviewedSdk, replacement] : [reviewedSdk];
      const expected = createHash("sha256")
        .update(`${JSON.stringify(approved)}\n`)
        .digest("hex");
      try {
        mkdirSync(join(temp, "ci"));
        mkdirSync(join(temp, "scripts/checks"), { recursive: true });
        writeFileSync(
          join(temp, "ci/reviewed-npm-audit.json"),
          JSON.stringify({
            sourceRegistryPackage: reviewedSdk,
            sourceRegistryPackageReplacement: withReplacement ? replacement : undefined,
          }),
        );
        writeFileSync(
          join(temp, "scripts/checks/package-openshell-sdk-for-pr.mts"),
          'process.stdout.write("/tmp/verified-sdk");',
        );
        const output = join(temp, "output");
        const result = runWorkflowShellStep(
          requiredWorkflowStep(
            sdkPackageJob,
            "Download and verify approved OpenShell SDK packages",
          ),
          {
            GITHUB_OUTPUT: output,
            HEAD_SHA: "unrelated-pr-commit",
          },
          temp,
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(
          `bundle_name=reviewed-openshell-sdk-${expected}\n`,
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  // source-shape-contract: security -- PR base SHA action execution prevents pull-request code from authorizing installer hashes
  it("executes pull request installer hash checks only from the PR base SHA", () => {
    expect(installerHashTrustViolations(installerHashWorkflow)).toEqual([]);

    const headCheckout = structuredClone(installerHashWorkflow);
    requiredWorkflowStep(
      headCheckout.jobs["check-hash"],
      "Checkout base-trusted installer hash action",
    ).with = {
      ref: "${{ github.event.pull_request.head.sha }}",
      path: ".trusted-installer-hash",
    };

    const missingBaseCheckout = structuredClone(installerHashWorkflow);
    missingBaseCheckout.jobs["check-hash"].steps = missingBaseCheckout.jobs[
      "check-hash"
    ].steps?.filter((step) => step.name !== "Checkout base-trusted installer hash action");

    const mutableExecutor = structuredClone(installerHashWorkflow);
    requiredWorkflowStep(
      mutableExecutor.jobs["check-hash"],
      "Verify pull request installer hashes from base-trusted code",
    ).uses = "./.github/actions/ci-installer-hash-check";

    const bootstrapExecutor = structuredClone(installerHashWorkflow);
    bootstrapExecutor.jobs["check-hash"].steps?.push({
      name: "Run installer hash bootstrap",
      uses: "./.bootstrap-installer-hash/.github/actions/ci-installer-hash-check",
    });

    const prOnlyLocalExecutor = structuredClone(installerHashWorkflow);
    prOnlyLocalExecutor.jobs["check-hash"].steps?.push({
      name: "Run local installer hash action for pull requests",
      if: "github.event_name == 'pull_request'",
      uses: "./.github/actions/ci-installer-hash-check",
    });

    expect(installerHashTrustViolations(headCheckout)).toContain(
      "base-trusted installer hash checkout must use the PR base SHA",
    );
    expect(installerHashTrustViolations(missingBaseCheckout)).toContain(
      "missing base-trusted installer hash checkout",
    );
    expect(installerHashTrustViolations(mutableExecutor)).toContain(
      "pull request installer hashes must use only the base-trusted action",
    );
    expect(installerHashTrustViolations(bootstrapExecutor)).toContain(
      "unapproved installer hash executor: ./.bootstrap-installer-hash/.github/actions/ci-installer-hash-check",
    );

    expect(installerHashTrustViolations(prOnlyLocalExecutor)).toContain(
      "installer hash action from the latest PR commit must not execute for pull requests",
    );
  });

  it("validates CLI shard inputs before using them in shell commands", () => {
    const shardValidationStep = requiredStep(
      sharedActions.cliCoverageShard,
      "Validate shard inputs",
    );
    const mergeValidationStep = requiredStep(
      sharedActions.cliCoverageMerge,
      "Validate shard inputs",
    );
    const temp = mkdtempSync(join(tmpdir(), "nemoclaw-cli-shard-validation-"));
    const marker = join(temp, "injected");
    const shellPayload = `$(touch ${marker})`;
    const output = join(temp, "github-output");

    try {
      const validShard = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: cliShardCount,
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: output,
      });
      const invalidShard = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: shellPayload,
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: output,
      });
      const invalidRange = runWorkflowShellStep(shardValidationStep, {
        CLI_SHARD: "13",
        CLI_SHARD_COUNT: cliShardCount,
        GITHUB_OUTPUT: join(temp, "github-output"),
      });
      const invalidCount = runWorkflowShellStep(mergeValidationStep, {
        CLI_SHARD_COUNT: shellPayload,
      });

      expect(validShard.status).toBe(0);
      expect(invalidShard.status).not.toBe(0);
      expect(invalidShard.stdout).toContain("Invalid CLI shard");
      expect(invalidRange.status).not.toBe(0);
      expect(invalidRange.stdout).toContain("Invalid CLI shard range");
      expect(invalidCount.status).not.toBe(0);
      expect(invalidCount.stdout).toContain("Invalid CLI shard count");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { force: true, recursive: true });
    }
  });

  // source-shape-contract: compatibility -- The coverage merge must consume the current attempt instead of a stale failed shard report
  it("replaces stale CLI shard reports when a failed job is rerun", () => {
    const upload = requiredStep(sharedActions.cliCoverageShard, "Upload CLI shard blob report");

    expect(upload.with).toMatchObject({
      name: "cli-blob-report-${{ inputs.shard }}",
      overwrite: true,
    });
  });

  it.each([
    ["cli-build-output", "required=true\n"],
    ["compiled-test-inputs", ""],
  ])("uploads the legacy coverage artifact only when the base reads %s", (artifact, expected) => {
    const root = mkdtempSync(join(tmpdir(), "coverage-artifact-rollout-"));
    const actionDirectory = join(root, ".trusted-ci-actions/.github/actions/ci-cli-coverage-merge");
    const output = join(root, "output");
    try {
      mkdirSync(actionDirectory, { recursive: true });
      writeFileSync(join(actionDirectory, "action.yaml"), `with:\n  name: ${artifact}\n`);
      writeFileSync(output, "");
      const result = runWorkflowShellStep(
        requiredWorkflowStep(
          prWorkflow.jobs["compile-artifacts"],
          "Detect legacy coverage artifact reader",
        ),
        { GITHUB_OUTPUT: output },
        root,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(expected);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  const coverageEntrypointCases = [
    {
      action: sharedActions.cliCoverageMerge,
      step: "Verify compiled CLI artifact",
      stem: "scripts/check-dist-sourcemaps",
    },
    {
      action: sharedActions.cliCoverageMerge,
      step: "Merge CLI coverage",
      stem: "scripts/check-coverage-ratchet",
    },
    {
      action: sharedActions.pluginCoverage,
      step: "Run plugin coverage",
      stem: "scripts/check-coverage-ratchet",
    },
  ] as const;
  const coverageEntrypointVariants = [
    {
      fixtureExtension: "mts",
      expectedEntrypointExtension: "mts",
      expectedStatus: 0,
    },
    {
      fixtureExtension: "missing",
      expectedEntrypointExtension: "mts",
      expectedStatus: 1,
    },
  ] as const;

  it.each(
    coverageEntrypointCases.flatMap((testCase) =>
      coverageEntrypointVariants.map((variant) => ({ testCase, variant })),
    ),
  )(
    "requires the migrated $testCase.stem.$variant.expectedEntrypointExtension entrypoint",
    ({ testCase, variant }) => {
      const temp = mkdtempSync(join(tmpdir(), "nemoclaw-coverage-entrypoint-"));
      const fakeBin = join(temp, "bin");
      mkdirSync(fakeBin);
      mkdirSync(join(temp, "dist"));
      mkdirSync(join(temp, "scripts"));
      writeFileSync(join(temp, "dist", ["nemoclaw", "js"].join(".")), "built\n");
      writeFileSync(join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(fakeBin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(
        join(fakeBin, "npx"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "tsx" ] && [[ "${2:-}" == scripts/check-* ]]; then',
          '  test "${2}" = "${EXPECTED_ENTRYPOINT}"',
          '  test -f "${2}"',
          "fi",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(temp, `${testCase.stem}.${variant.fixtureExtension}`), "// fixture\n");

      try {
        const result = runWorkflowShellStep(
          requiredStep(testCase.action, testCase.step),
          {
            EXPECTED_ENTRYPOINT: `${testCase.stem}.${variant.expectedEntrypointExtension}`,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
          temp,
        );

        expect(result.status, result.stderr).toBe(variant.expectedStatus);
      } finally {
        rmSync(temp, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["pull_request", prWorkflow],
    ["main", mainWorkflow],
  ] as const)(
    "links every failed %s CLI shard and falls back when job metadata is unavailable",
    (workflowName, workflow) => {
      const runUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/123";
      const failedShards = workflowJobListing([
        workflowJob(101, "cli-test-shards (1)", "success"),
        workflowJob(102, "cli-test-shards (2)", "failure"),
        workflowJob(112, "cli-test-shards (12)", "cancelled"),
        workflowJob(109, "plugin-tests", "success"),
      ]);
      const malformedShards = workflowJobListing([
        workflowJob("not-a-number", "cli-test-shards (2)", "failure"),
      ]);
      const oversizedShards = workflowJobListing([
        workflowJob(9_007_199_254_740_992, "cli-test-shards (2)", "failure"),
      ]);

      const cliGate = requiredWorkflowStep(
        workflow.jobs["cli-tests"],
        "Verify CLI shards completed",
      );
      const failure = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        failedShards,
      );
      const malformed = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        malformedShards,
      );
      const oversized = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "failure" },
        oversizedShards,
      );
      const unavailable = runWorkflowShellStepWithJobs(
        cliGate,
        { CLI_SHARD_RESULT: "cancelled" },
        "",
        1,
      );

      expect(failure.status, `${workflowName}: ${failure.stderr}`).not.toBe(0);
      expect(failure.stdout).toContain(`${runUrl}/job/102`);
      expect(failure.stdout).toContain(`${runUrl}/job/112`);
      expect(malformed.status).not.toBe(0);
      expect(malformed.stdout).toContain(`Details: ${runUrl}`);
      expect(malformed.stdout).not.toContain(`${runUrl}/job/`);
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout).toContain(`Details: ${runUrl}`);
      expect(oversized.stdout).not.toContain(`${runUrl}/job/`);
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stdout).toContain(`Expected success, got cancelled. Details: ${runUrl}`);
    },
  );

  it("accepts successful aggregate checks and rejects failed required lanes", () => {
    const prChecks = prWorkflow.jobs.checks;
    const mainChecks = mainWorkflow.jobs.checks;
    const prGate = requiredWorkflowStep(prChecks, "Verify required PR checks");
    const mainGate = requiredWorkflowStep(mainChecks, "Verify required main checks");
    const successfulCode = {
      BUILD_TYPECHECK_RESULT: "success",
      CHANGES_RESULT: "success",
      CI_REQUIRED: "true",
      CLI_TESTS_RESULT: "success",
      CODE_CHANGED: "true",
      DOCS_ONLY_RESULT: "skipped",
      HF_MODELS_CHANGED: "true",
      HF_MODELS_RESULT: "success",
      INSTALLER_INTEGRATION_RESULT: "success",
      OPEN_SHELL_SDK_PACKAGE_RESULT: "success",
      PLUGIN_TESTS_RESULT: "success",
      REAL_OPENCLAW_DIST_HARNESS_RESULT: "success",
      REVIEWED_NPM_AUDIT_RESULT: "success",
      STATIC_RESULT: "success",
      WECHAT_RUNTIME_AUDIT_RESULT: "success",
    };
    const successfulMain = {
      SDK_PACKAGE_RESULT: "success",
      BUILD_TYPECHECK_RESULT: "success",
      CLI_TESTS_RESULT: "success",
      INSTALLER_INTEGRATION_RESULT: "success",
      PLUGIN_TESTS_RESULT: "success",
      REVIEWED_NPM_AUDIT_RESULT: "success",
      REAL_OPENCLAW_DIST_HARNESS_RESULT: "success",
      SANDBOX_IMAGE_CONTRACTS_RESULT: "success",
      STATIC_RESULT: "success",
      WECHAT_RUNTIME_AUDIT_RESULT: "success",
    };

    const codeSuccess = runWorkflowShellStep(prGate, successfulCode);
    const codeFailure = runWorkflowShellStepWithJobs(
      prGate,
      {
        ...successfulCode,
        HF_MODELS_RESULT: "failure",
        PLUGIN_TESTS_RESULT: "cancelled",
        REAL_OPENCLAW_DIST_HARNESS_RESULT: "failure",
        STATIC_RESULT: "failure",
      },
      workflowJobListing([
        workflowJob(201, "static-checks", "failure"),
        workflowJob(202, "plugin-tests", "cancelled"),
        workflowJob(203, "hugging-face-models", "failure"),
        workflowJob(204, "real-openclaw-dist-harness", "failure"),
      ]),
    );
    const docsOnlySuccess = runWorkflowShellStep(prGate, {
      ...successfulCode,
      BUILD_TYPECHECK_RESULT: "skipped",
      CLI_TESTS_RESULT: "skipped",
      CODE_CHANGED: "false",
      DOCS_ONLY_RESULT: "success",
      HF_MODELS_CHANGED: "false",
      HF_MODELS_RESULT: "skipped",
      INSTALLER_INTEGRATION_RESULT: "skipped",
      OPEN_SHELL_SDK_PACKAGE_RESULT: "skipped",
      PLUGIN_TESTS_RESULT: "skipped",
      REAL_OPENCLAW_DIST_HARNESS_RESULT: "skipped",
      REVIEWED_NPM_AUDIT_RESULT: "skipped",
      STATIC_RESULT: "skipped",
      WECHAT_RUNTIME_AUDIT_RESULT: "skipped",
    });
    const mainSuccess = runWorkflowShellStep(mainGate, successfulMain);
    const mainFailure = runWorkflowShellStepWithJobs(
      mainGate,
      {
        ...successfulMain,
        SANDBOX_IMAGE_CONTRACTS_RESULT: "failure",
      },
      workflowJobListing([workflowJob(302, "sandbox-image-contracts", "failure")]),
    );
    const mainSdkFailure = runWorkflowShellStepWithJobs(
      mainGate,
      { ...successfulMain, SDK_PACKAGE_RESULT: "failure" },
      workflowJobListing([workflowJob(303, "package-openshell-sdk", "failure")]),
    );
    const malformedFailure = runWorkflowShellStepWithJobs(
      prGate,
      { ...successfulCode, STATIC_RESULT: "failure" },
      workflowJobListing([workflowJob("invalid", "static-checks", "failure")]),
    );
    const oversizedFailure = runWorkflowShellStepWithJobs(
      prGate,
      { ...successfulCode, STATIC_RESULT: "failure" },
      workflowJobListing([workflowJob(9_007_199_254_740_992, "static-checks", "failure")]),
    );

    expect(codeSuccess.status).toBe(0);
    expect(codeFailure.status).not.toBe(0);
    expect(codeFailure.stdout).toContain("static-checks failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/201",
    );
    expect(codeFailure.stdout).toContain("plugin-tests failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/202",
    );
    expect(codeFailure.stdout).toContain("hugging-face-models failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/203",
    );
    expect(codeFailure.stdout).toContain("real-openclaw-dist-harness failed");
    expect(codeFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/204",
    );
    expect(docsOnlySuccess.status).toBe(0);
    expect(mainSuccess.status).toBe(0);
    expect(mainFailure.status).not.toBe(0);
    expect(mainFailure.stdout).toContain("sandbox-image-contracts failed");
    expect(mainFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/302",
    );
    expect(mainSdkFailure.status).not.toBe(0);
    expect(mainSdkFailure.stdout).toContain("package-openshell-sdk failed");
    expect(mainSdkFailure.stdout).toContain(
      "https://github.com/NVIDIA/NemoClaw/actions/runs/123/job/303",
    );
    expect(malformedFailure.status).not.toBe(0);
    expect(malformedFailure.stdout).toContain(
      "Details: https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    );
    expect(malformedFailure.stdout).not.toContain("actions/runs/123/job/");
    expect(oversizedFailure.status).not.toBe(0);
    expect(oversizedFailure.stdout).toContain(
      "Details: https://github.com/NVIDIA/NemoClaw/actions/runs/123",
    );
    expect(oversizedFailure.stdout).not.toContain("actions/runs/123/job/");
  });
});
