// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_ARTIFACT_PACKAGE_STEP,
  CLI_ARTIFACT_PUBLISH_STEP,
  validateCliArtifactRestoreAction,
  validateCliArtifactWorkflowBoundary,
} from "../../../tools/e2e/cli-artifact-workflow-boundary.mts";
import {
  type CompositeAction,
  readRepoText,
  readWorkflow,
  readYaml,
  type Workflow,
} from "../../helpers/e2e-workflow-contract";

const CANDIDATE_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const PAYLOAD_SHA256 = "b".repeat(64);
const CONTENT_ADDRESSED_ARTIFACT_NAME = `artifact_name="nemoclaw-cli-\${CANDIDATE_SHA}-\${payload_sha256}"`;
const UNBOUND_ARTIFACT_NAME = `artifact_name="nemoclaw-cli-\${CANDIDATE_SHA}"`;

function runIdentityValidation(overrides: Record<string, unknown> = {}, consumerAttempt = "1") {
  const action = readYaml<CompositeAction>(".github/actions/restore-e2e-cli-artifact/action.yaml");
  const workflowSha = "d".repeat(40);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-identity-"));
  try {
    const outputPath = path.join(outputDirectory, "github-output");
    const result = spawnSync("bash", ["-c", action.runs.steps[0]!.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALLER_WORKFLOW_SHA: workflowSha,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_ATTEMPT: consumerAttempt,
        GITHUB_RUN_ID: "98765",
        PROVENANCE_JSON: JSON.stringify({
          kind: "nemoclaw-e2e-cli-provenance-v1",
          artifactDigest: "c".repeat(64),
          artifactId: "12345",
          artifactName: `nemoclaw-cli-${CANDIDATE_SHA}-${PAYLOAD_SHA256}`,
          candidateRepository: "NVIDIA/NemoClaw",
          candidateSha: CANDIDATE_SHA,
          payloadSha256: PAYLOAD_SHA256,
          runAttempt: "1",
          runId: "98765",
          workflowSha,
          ...overrides,
        }),
      },
    });
    return {
      ...result,
      outputs: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
    };
  } finally {
    fs.rmSync(outputDirectory, { force: true, recursive: true });
  }
}

function workflowFixture(): Workflow {
  return JSON.parse(JSON.stringify(readWorkflow())) as Workflow;
}

type RestoreFixtureOptions = {
  archive?:
    | "valid"
    | "cli-directory"
    | "missing-shared"
    | "non-dist"
    | "link"
    | "shared-module-directory"
    | "traversal";
  buildIdentitySha?: string;
  consumerRunAttempt?: string;
  expectedPayloadSha256?: string;
  manifestCandidateSha?: string;
  manifestRunAttempt?: string;
  preexistingDist?:
    | "dangling-symlink"
    | "directory"
    | "plugin-directory"
    | "symlinked-plugin-parent";
  producerRunAttempt?: string;
};

type ArchiveFixtureContext = {
  buildIdentitySha: string;
  payload: string;
  payloadRoot: string;
};

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeCliArchive(
  context: ArchiveFixtureContext,
  customizeDist: (dist: string) => void,
  customizeShared: (shared: string) => void = () => undefined,
): void {
  const dist = path.join(context.payloadRoot, "dist");
  const shared = path.join(context.payloadRoot, "nemoclaw", "dist", "shared");
  fs.mkdirSync(dist);
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "nemoclaw.js"),
    'require("../nemoclaw/dist/shared/sandbox-name.cjs");\nconsole.log("nemoclaw v0.0.0");\n',
  );
  fs.writeFileSync(
    path.join(dist, "build-identity.json"),
    `${JSON.stringify({
      nemoclawVersion: "0.0.0",
      sourceRevision: context.buildIdentitySha,
    })}\n`,
  );
  for (const boundary of [
    "openshell-policy-boundary.cjs",
    "sandbox-name.cjs",
    "snapshot-sanitizer-boundary.cjs",
  ]) {
    fs.writeFileSync(path.join(shared, boundary), "module.exports = {};\n");
  }
  customizeShared(shared);

  customizeDist(dist);
  execFileSync("tar", [
    "-cf",
    context.payload,
    "-C",
    context.payloadRoot,
    "dist",
    "nemoclaw/dist/shared",
  ]);
}

function writeValidArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, () => undefined);
}

function writeLinkArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, (dist) => {
    fs.symlinkSync("nemoclaw.js", path.join(dist, "linked-cli.js"));
  });
}

function writeCliDirectoryArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(context, (dist) => {
    const entrypoint = path.join(dist, "nemoclaw.js");
    fs.rmSync(entrypoint);
    fs.mkdirSync(entrypoint);
    fs.writeFileSync(path.join(entrypoint, "index.js"), 'console.log("nemoclaw v0.0.0");\n');
  });
}

function writeMissingSharedArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => fs.rmSync(path.join(shared, "sandbox-name.cjs")),
  );
}

function writeSharedModuleDirectoryArchive(context: ArchiveFixtureContext): void {
  writeCliArchive(
    context,
    () => undefined,
    (shared) => {
      const modulePath = path.join(shared, "sandbox-name.cjs");
      fs.rmSync(modulePath);
      fs.mkdirSync(modulePath);
      fs.writeFileSync(path.join(modulePath, "index.js"), "module.exports = {};\n");
    },
  );
}

function writeNonDistArchive(context: ArchiveFixtureContext): void {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  execFileSync("tar", ["-cf", context.payload, "-C", context.payloadRoot, "outside.txt"]);
}

function writeTraversalArchive(context: ArchiveFixtureContext): void {
  fs.writeFileSync(path.join(context.payloadRoot, "outside.txt"), "outside dist\n");
  const transform =
    process.platform === "darwin"
      ? ["-s", "|^outside.txt$|dist/../outside.txt|"]
      : ["--transform=s|^outside.txt$|dist/../outside.txt|"];
  execFileSync("tar", [
    "-cf",
    context.payload,
    ...transform,
    "-C",
    context.payloadRoot,
    "outside.txt",
  ]);
}

const ARCHIVE_FIXTURE_WRITERS = {
  "cli-directory": writeCliDirectoryArchive,
  link: writeLinkArchive,
  "missing-shared": writeMissingSharedArchive,

  "non-dist": writeNonDistArchive,
  "shared-module-directory": writeSharedModuleDirectoryArchive,
  traversal: writeTraversalArchive,
  valid: writeValidArchive,
} satisfies Record<
  NonNullable<RestoreFixtureOptions["archive"]>,
  (context: ArchiveFixtureContext) => void
>;

function writeDanglingDistSymlink(workspace: string): void {
  const dist = path.join(workspace, "dist");
  fs.symlinkSync("missing-dist", dist);
}

function writePreexistingDistDirectory(workspace: string): void {
  const dist = path.join(workspace, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(workspace, "dist", "existing.txt"), "preserve\n");
}

function writePreexistingPluginDistDirectory(workspace: string): void {
  const shared = path.join(workspace, "nemoclaw", "dist", "shared");
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, "existing.cjs"), "module.exports = {};\n");
}

function writeSymlinkedPluginParent(workspace: string): void {
  const escaped = path.join(path.dirname(workspace), "escaped");
  fs.rmSync(path.join(workspace, "nemoclaw"), { force: true, recursive: true });
  fs.mkdirSync(escaped);
  fs.symlinkSync(escaped, path.join(workspace, "nemoclaw"), "dir");
}

const PREEXISTING_DIST_WRITERS = {
  "dangling-symlink": writeDanglingDistSymlink,
  directory: writePreexistingDistDirectory,
  "plugin-directory": writePreexistingPluginDistDirectory,
  "symlinked-plugin-parent": writeSymlinkedPluginParent,

  none: () => undefined,
} satisfies Record<
  NonNullable<RestoreFixtureOptions["preexistingDist"]> | "none",
  (workspace: string) => void
>;

function runRestoreValidation(options: RestoreFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-restore-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  const artifactDirectory = path.join(runnerTemp, "nemoclaw-cli-artifact");
  const payloadRoot = path.join(root, "payload-root");
  const toolDirectory = path.join(root, "tools");
  fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "nemoclaw"), { recursive: true });

  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.mkdirSync(toolDirectory, { recursive: true });
  fs.writeFileSync(path.join(workspace, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(
    path.join(workspace, "bin", "nemoclaw.js"),
    '#!/usr/bin/env node\nrequire("../dist/nemoclaw.js");\n',
    { mode: 0o755 },
  );
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/NVIDIA/NemoClaw.git"], {
    cwd: workspace,
  });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: workspace },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();

  const payload = path.join(artifactDirectory, "nemoclaw-cli.tar");
  ARCHIVE_FIXTURE_WRITERS[options.archive ?? "valid"]({
    buildIdentitySha: options.buildIdentitySha ?? candidateSha,
    payload,
    payloadRoot,
  });

  const actualPayloadSha256 = sha256File(payload);
  const expectedPayloadSha256 = options.expectedPayloadSha256 ?? actualPayloadSha256;
  const artifactName = `nemoclaw-cli-${candidateSha}-${expectedPayloadSha256}`;
  const producerRunAttempt = options.producerRunAttempt ?? "1";
  const workflowSha = "d".repeat(40);
  fs.writeFileSync(
    path.join(artifactDirectory, "manifest.json"),
    `${JSON.stringify({
      kind: "nemoclaw-e2e-cli-artifact-v1",
      artifactName,
      candidate: {
        repository: "NVIDIA/NemoClaw",
        sha: options.manifestCandidateSha ?? candidateSha,
        sourceTree,
        lockfileSha256: sha256File(path.join(workspace, "package-lock.json")),
      },
      workflow: {
        sha: workflowSha,
        runId: "98765",
        runAttempt: options.manifestRunAttempt ?? options.producerRunAttempt ?? "1",
      },
      toolchain: {
        node: "v22.23.1",
        npm: "10.9.2",
        runnerOs: "Linux",
        runnerArch: "X64",
      },
      build: { command: "npm run build:cli", sourceRevision: candidateSha },
      payload: { file: "nemoclaw-cli.tar", sha256: expectedPayloadSha256 },
    })}\n`,
  );

  const nodeWrapper = path.join(toolDirectory, "node");
  fs.writeFileSync(
    nodeWrapper,
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$#" -eq 1 && "$1" == "--version" ]]; then\n  echo v22.23.1\n  exit 0\nfi\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  const lockfileSha256 = sha256File(path.join(workspace, "package-lock.json"));
  fs.writeFileSync(
    path.join(toolDirectory, "sha256sum"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'case "${1:-}" in',
      `  package-lock.json|*/nemoclaw-cli.tar) printf '%s  %s\\n' '${"0".repeat(64)}' "$1" ;;`,
      `  *) printf '%s  %s\\n' '${lockfileSha256}' "$1" ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  PREEXISTING_DIST_WRITERS[options.preexistingDist ?? "none"](workspace);

  const action = readYaml<CompositeAction>(".github/actions/restore-e2e-cli-artifact/action.yaml");
  const githubOutput = path.join(root, "github-output");
  const identityResult = spawnSync("bash", ["-c", action.runs.steps[0]!.run!], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      CALLER_WORKFLOW_SHA: workflowSha,
      GITHUB_OUTPUT: githubOutput,
      GITHUB_RUN_ATTEMPT: options.consumerRunAttempt ?? producerRunAttempt,
      GITHUB_RUN_ID: "98765",
      PROVENANCE_JSON: JSON.stringify({
        kind: "nemoclaw-e2e-cli-provenance-v1",
        artifactDigest: "c".repeat(64),
        artifactId: "12345",
        artifactName,
        candidateRepository: "NVIDIA/NemoClaw",
        candidateSha,
        payloadSha256: expectedPayloadSha256,
        runAttempt: producerRunAttempt,
        runId: "98765",
        workflowSha,
      }),
    },
  });
  const runRestoreStep = () => {
    const identityOutputs = Object.fromEntries(
      fs
        .readFileSync(githubOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return spawnSync("bash", ["-c", action.runs.steps[2]!.run!], {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_NAME: identityOutputs.artifact_name,
        CANDIDATE_REPOSITORY: identityOutputs.candidate_repository,
        CANDIDATE_SHA: identityOutputs.candidate_sha,
        GITHUB_WORKSPACE: workspace,
        PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
        PAYLOAD_SHA256: identityOutputs.payload_sha256,
        PRODUCER_RUN_ATTEMPT: identityOutputs.producer_run_attempt,
        RUN_ID: identityOutputs.run_id,
        RUNNER_TEMP: runnerTemp,
        WORKFLOW_SHA: identityOutputs.workflow_sha,
      },
    });
  };
  const identitySucceeded = identityResult.status === 0;
  const restoreResult = identitySucceeded ? runRestoreStep() : identityResult;
  return {
    candidateSha,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    output: `${identityResult.stdout}${identityResult.stderr}${
      identitySucceeded ? `${restoreResult.stdout}${restoreResult.stderr}` : ""
    }`,
    result: restoreResult,
    runnerTemp,
    workspace,
  };
}

function expectRestoreFailure(options: RestoreFixtureOptions, message: string): void {
  const fixture = runRestoreValidation(options);
  try {
    expect(fixture.result.status, fixture.output).not.toBe(0);
    expect(fixture.output).toContain(message);
    expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspace, "nemoclaw", "dist"))).toBe(false);
  } finally {
    fixture.cleanup();
  }
}

function requireStep(workflow: Workflow, jobName: string, stepName: string) {
  const step = workflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
  expect(step, `${jobName} must contain ${stepName}`).toBeDefined();
  return step!;
}

describe("exact-commit CLI artifact workflow boundary", () => {
  it("builds the candidate CLI once and requires every artifact-using job to restore it", () => {
    expect(validateCliArtifactWorkflowBoundary(readWorkflow())).toEqual([]);
  });

  it("rejects dependency caching before trusted installation (#9051)", () => {
    const workflow = workflowFixture();
    const setupNode = requireStep(
      workflow,
      "mcp-bridge-dev",
      "Set up Node.js for trusted OpenShell verification",
    );
    setupNode.with = { ...setupNode.with, "package-manager-cache": true };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
    );
  });

  it("rejects package manager probes after candidate checkout (#9051)", () => {
    const workflow = workflowFixture();
    const steps = workflow.jobs["mcp-bridge-dev"].steps!;
    const setupNode = requireStep(
      workflow,
      "mcp-bridge-dev",
      "Set up Node.js for trusted OpenShell verification",
    );
    const [movedSetupNode] = steps.splice(steps.indexOf(setupNode), 1);
    const candidateCheckoutIndex = steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    steps.splice(candidateCheckoutIndex + 1, 0, movedSetupNode!);

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must set up Node.js without dependency caching before candidate checkout",
    );
  });

  it("rejects candidate execution before trusted development installation (#9051)", () => {
    const workflow = workflowFixture();
    const steps = workflow.jobs["mcp-bridge-dev"].steps!;
    const candidateCheckoutIndex = steps.findIndex((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    steps.splice(candidateCheckoutIndex + 1, 0, {
      name: "Execute candidate CLI before trusted installation",
      run: "node bin/nemoclaw.js --version",
    });

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must preserve every reviewed step through trusted installation",
    );
  });

  it("rejects candidate execution embedded in the trusted development installer (#9051)", () => {
    const workflow = workflowFixture();
    const install = requireStep(
      workflow,
      "mcp-bridge-dev",
      "Install immutable OpenShell dev artifact",
    );
    install.run = `bash test/e2e/setup-mcp-test-tls.sh\n${install.run ?? ""}`;

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must preserve every reviewed step through trusted installation",
    );
  });

  it("rejects candidate-controlled process hooks in the trusted development job (#9051)", () => {
    const workflow = workflowFixture();
    const job = workflow.jobs["mcp-bridge-dev"];
    expect(job).toBeDefined();
    job!.env = {
      ...job!.env,
      NODE_OPTIONS: "--require=./candidate-preload.cjs",
    };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must not use candidate-controlled process hooks before trusted installation",
    );
  });

  it("rejects candidate-controlled process hooks in the workflow environment (#9051)", () => {
    const workflow = workflowFixture() as Workflow & { env?: Record<string, string> };
    workflow.env = {
      ...workflow.env,
      NODE_OPTIONS: "--require=./candidate-preload.cjs",
    };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "workflow must not set process startup hooks before CLI artifact restore",
    );
  });

  it("scans the complete job for process hooks when trusted installation is missing (#9051)", () => {
    const workflow = workflowFixture();
    const job = workflow.jobs["mcp-bridge-dev"];
    const steps = job.steps!;
    job.steps = steps.filter(
      (step) => step.name !== "Install immutable OpenShell dev artifact",
    );
    const prepare = requireStep(workflow, "mcp-bridge-dev", "Prepare E2E workspace");
    prepare.env = { NODE_OPTIONS: "--require=./candidate-preload.cjs" };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "mcp-bridge-dev must not use candidate-controlled process hooks before trusted installation",
        "mcp-bridge-dev must preserve every reviewed step through trusted installation",
      ]),
    );
  });

  it("rejects skipping the trusted development installer (#9051)", () => {
    const workflow = workflowFixture();
    const install = requireStep(
      workflow,
      "mcp-bridge-dev",
      "Install immutable OpenShell dev artifact",
    );
    install.if = "${{ false }}";

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must preserve every reviewed step through trusted installation",
    );
  });

  it("rejects skipping post-install dependency preparation (#9051)", () => {
    const workflow = workflowFixture();
    const prepare = requireStep(workflow, "mcp-bridge-dev", "Prepare E2E workspace");
    prepare.if = "${{ false }}";

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must preserve reviewed dependency preparation and candidate CLI restore after trusted installation",
    );
  });

  it("rejects removing post-install dependency preparation and candidate CLI restore (#9051)", () => {
    const workflow = workflowFixture();
    const steps = workflow.jobs["mcp-bridge-dev"].steps!;
    workflow.jobs["mcp-bridge-dev"].steps = steps.filter(
      (step) =>
        step.name !== "Prepare E2E workspace" &&
        step.name !== "Restore exact-commit CLI artifact",
    );

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "mcp-bridge-dev must verify and restore the exact CLI artifact exactly once",
    );
  });

  it("rejects removing the trusted development consumer job (#9051)", () => {
    const workflow = workflowFixture();
    delete workflow.jobs["mcp-bridge-dev"];

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "workflow is missing required CLI artifact consumer mcp-bridge-dev",
    );
  });

  it("reports both an unreadable action and a missing producer", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-missing-action-"));
    try {
      const workflow = workflowFixture();
      delete workflow.jobs["generate-matrix"];

      expect(
        validateCliArtifactWorkflowBoundary(workflow, path.join(directory, "missing-action.yaml")),
      ).toEqual([
        "CLI artifact restore action file is missing or unreadable",
        "workflow is missing CLI artifact producer generate-matrix",
      ]);
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts matching artifact, candidate source, and workflow identities", () => {
    const result = runIdentityValidation();
    expect(result.status, "matching artifact identity validation failed").toBe(0);
  });

  it("reuses an immutable producer artifact during a later failed-job rerun", () => {
    const fixture = runRestoreValidation({ consumerRunAttempt: "2", producerRunAttempt: "1" });
    try {
      expect(fixture.result.status, "cross-attempt CLI artifact restore failed").toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "build-identity.json"), "utf8"),
        ),
      ).toEqual({ nemoclawVersion: "0.0.0", sourceRevision: fixture.candidateSha });
      expect(fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw.js"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "sandbox-name.cjs"),
        ),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a producer attempt that does not match the restored artifact manifest", () => {
    expectRestoreFailure(
      { manifestRunAttempt: "2", producerRunAttempt: "1" },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects consumer workflow attempt zero", () => {
    const result = runIdentityValidation({}, "0");
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "consumer workflow run attempt is invalid",
    );
  });

  it.each([
    ["empty artifact ID", { artifactId: "" }, "producer CLI artifact provenance is invalid"],
    [
      "prefixed upload digest",
      { artifactDigest: `sha256:${"c".repeat(64)}` },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed candidate SHA",
      { candidateSha: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "different candidate SHA",
      { candidateSha: "e".repeat(40) },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "unbound artifact name",
      { artifactName: `nemoclaw-cli-${CANDIDATE_SHA}` },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed payload digest",
      { payloadSha256: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "malformed workflow SHA",
      { workflowSha: "abc" },
      "producer CLI artifact provenance is invalid",
    ],
    [
      "unknown provenance field",
      { unexpected: "value" },
      "producer CLI artifact provenance is invalid",
    ],
  ])("fails closed for %s", (_case, overrides, expectedError) => {
    const result = runIdentityValidation(overrides);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
  });

  it.each([
    [
      "candidate repository",
      { candidateRepository: "example/other-repository" },
      "consumer checkout repository does not match producer provenance",
    ],
    ["workflow SHA", { workflowSha: "e".repeat(40) }, "consumer and producer workflow SHAs differ"],
    ["run ID", { runId: "98766" }, "consumer and producer workflow run IDs differ"],
    [
      "future producer attempt",
      { runAttempt: "2" },
      "producer workflow attempt is newer than the consumer attempt",
    ],
  ])("rejects a mismatched %s before artifact download", (_case, overrides, expectedError) => {
    const result = runIdentityValidation(overrides);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
  });

  it("restores a payload whose compiled identity matches the candidate commit (#7915)", () => {
    const fixture = runRestoreValidation();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(fixture.workspace, "dist", "build-identity.json"), "utf8"),
        ),
      ).toEqual({ nemoclawVersion: "0.0.0", sourceRevision: fixture.candidateSha });
      expect(
        fs.existsSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "sandbox-name.cjs"),
        ),
      ).toBe(true);

      expect(
        fs
          .readdirSync(fixture.runnerTemp)
          .filter((entry) => entry.startsWith("nemoclaw-cli-restore.")),
      ).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("restores a binary payload when the host SHA-256 utility reports a different digest (#10569)", () => {
    const fixture = runRestoreValidation();
    try {
      expect(fixture.result.status, fixture.output).toBe(0);
      expect(fs.existsSync(path.join(fixture.workspace, "dist", "nemoclaw.js"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects manifest provenance before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { manifestCandidateSha: "e".repeat(40) },
      "exact-commit CLI artifact provenance mismatch",
    );
  });

  it("rejects a payload digest mismatch before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { expectedPayloadSha256: "f".repeat(64) },
      "exact-commit CLI artifact payload digest mismatch",
    );
  });

  it("rejects a payload missing a compiled shared module before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "missing-shared" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects a directory in place of the CLI entry point before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "cli-directory" },
      "restored CLI artifact entry point is missing or is not a nonempty regular file",
    );
  });

  it("rejects a directory in place of a shared module before activation (#7915)", () => {
    expectRestoreFailure(
      { archive: "shared-module-directory" },
      "restored CLI artifact shared module is missing or is not a nonempty regular file: sandbox-name.cjs",
    );
  });

  it("rejects an archive member outside dist before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { archive: "non-dist" },
      "CLI artifact contains an unsafe member: outside.txt",
    );
  });

  it("rejects traversal through a dist-prefixed archive member before extraction (#7915)", () => {
    expectRestoreFailure({ archive: "traversal" }, "CLI artifact contains traversal");
  });

  it("rejects an archive link before artifact extraction (#7915)", () => {
    expectRestoreFailure({ archive: "link" }, "CLI artifact contains a link or special file");
  });

  it("does not overwrite a preexisting dist directory (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "directory" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain("consumer unexpectedly built dist before artifact restore");
      expect(fs.readFileSync(path.join(fixture.workspace, "dist", "existing.txt"), "utf8")).toBe(
        "preserve\n",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a preexisting nemoclaw/dist directory (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "plugin-directory" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain(
        "consumer unexpectedly built nemoclaw/dist before artifact restore",
      );
      expect(
        fs.readFileSync(
          path.join(fixture.workspace, "nemoclaw", "dist", "shared", "existing.cjs"),
          "utf8",
        ),
      ).toBe("module.exports = {};\n");
      expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a symlinked nemoclaw directory without writing outside the workspace (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "symlinked-plugin-parent" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain(
        "consumer nemoclaw directory must be a non-symlink directory",
      );
      expect(fs.lstatSync(path.join(fixture.workspace, "nemoclaw")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(path.dirname(fixture.workspace), "escaped", "dist"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(fixture.workspace, "dist"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not overwrite a dangling dist symlink (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: "dangling-symlink" });
    try {
      expect(fixture.result.status, fixture.output).not.toBe(0);
      expect(fixture.output).toContain("consumer unexpectedly built dist before artifact restore");
      expect(fs.lstatSync(path.join(fixture.workspace, "dist")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(fixture.workspace, "dist"))).toBe("missing-dist");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a compiled identity mismatch before artifact activation (#7915)", () => {
    expectRestoreFailure(
      { buildIdentitySha: "e".repeat(40) },
      "restored CLI build identity does not match the candidate SHA",
    );
  });

  it("rejects producer identity and content-addressing drift", () => {
    const workflow = workflowFixture();
    const producer = workflow.jobs["generate-matrix"];
    producer.outputs!.cli_artifact_provenance =
      "${{ steps.upload_cli_artifact.outputs.artifact-url }}";
    const packageStep = requireStep(workflow, "generate-matrix", CLI_ARTIFACT_PACKAGE_STEP);
    packageStep.env!.WORKFLOW_SHA = "${{ inputs.checkout_sha }}";
    packageStep.run = packageStep.run!.replace(
      CONTENT_ADDRESSED_ARTIFACT_NAME,
      UNBOUND_ARTIFACT_NAME,
    );
    packageStep.run = packageStep.run!.replace("sandbox-name.cjs", "missing-boundary.cjs");
    const uploadStep = requireStep(workflow, "generate-matrix", CLI_ARTIFACT_PUBLISH_STEP);
    uploadStep.uses = "actions/upload-artifact@v7";

    expect(validateCliArtifactWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix must expose exact cli_artifact_provenance provenance",
        "CLI artifact package step must bind candidate and trusted workflow identities explicitly",
        `CLI artifact package step must contain ${CONTENT_ADDRESSED_ARTIFACT_NAME}`,
        "CLI artifact package step must contain sandbox-name.cjs",
        "CLI artifact upload must use the immutable content-addressed upload contract",
      ]),
    );
  });

  it("leaves job timeouts to their dedicated workflow validators", () => {
    const workflow = workflowFixture();
    const timeoutMinutes = Number(workflow.jobs["hermes-e2e"]["timeout-minutes"]);
    expect(Number.isFinite(timeoutMinutes)).toBe(true);
    workflow.jobs["hermes-e2e"]["timeout-minutes"] = timeoutMinutes + 1;

    expect(validateCliArtifactWorkflowBoundary(workflow)).toEqual([]);
  });

  it("rejects action implementation drift that weakens extraction or payload verification", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-action-"));
    try {
      const actionPath = path.join(directory, "action.yaml");
      const source = readRepoText(".github/actions/restore-e2e-cli-artifact/action.yaml")
        .replace("tar --no-same-owner --no-same-permissions", "tar")
        .replace("sandbox-name.cjs", "missing-boundary.cjs")
        .replace(
          'lockfile_sha256="$(sha256_file package-lock.json)"',
          [
            '# lockfile_sha256="$(sha256_file package-lock.json)"',
            'lockfile_sha256="$(openssl dgst -sha256 -r package-lock.json | cut -d " " -f 1)"',
          ].join("\n        "),
        )
        .replace(
          'actual_payload_sha256="$(sha256_file "$payload")"',
          [
            '# actual_payload_sha256="$(sha256_file "$payload")"',
            'actual_payload_sha256="$(openssl dgst -sha256 -r "$payload" | cut -d " " -f 1)"',
          ].join("\n        "),
        )
        .replace('[[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]', '[[ -s "$payload" ]]');
      fs.writeFileSync(actionPath, source);

      expect(validateCliArtifactRestoreAction(actionPath)).toEqual(
        expect.arrayContaining([
          "CLI artifact restore action must match its immutable workflow pin",
          'CLI artifact payload verification must contain tar --no-same-owner --no-same-permissions -xf "$payload" -C "$restore_dir"',
          "CLI artifact payload verification must contain sandbox-name.cjs",
          "CLI artifact payload verification must assign lockfile_sha256 exactly once through the Node.js binary stream",
          "CLI artifact payload verification must assign actual_payload_sha256 exactly once through the Node.js binary stream",
          'CLI artifact payload verification must contain [[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]',
        ]),
      );
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
