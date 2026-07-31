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
  CLI_ARTIFACT_RESTORE_STEP,
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

function runIdentityValidation(overrides: Record<string, unknown> = {}) {
  const action = readYaml<CompositeAction>(".github/actions/restore-e2e-cli-artifact/action.yaml");
  const workflowSha = "d".repeat(40);
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-identity-"));
  return spawnSync("bash", ["-c", action.runs.steps[0]!.run!], {
    encoding: "utf8",
    env: {
      ...process.env,
      CALLER_WORKFLOW_SHA: workflowSha,
      GITHUB_OUTPUT: path.join(outputDirectory, "github-output"),
      GITHUB_RUN_ATTEMPT: "1",
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
}

function workflowFixture(): Workflow {
  return JSON.parse(JSON.stringify(readWorkflow())) as Workflow;
}

type RestoreFixtureOptions = {
  archive?: "valid" | "non-dist" | "link";
  buildIdentitySha?: string;
  expectedPayloadSha256?: string;
  manifestCandidateSha?: string;
  preexistingDist?: boolean;
};

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runRestoreValidation(options: RestoreFixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-restore-"));
  const workspace = path.join(root, "workspace");
  const runnerTemp = path.join(root, "runner-temp");
  const artifactDirectory = path.join(runnerTemp, "nemoclaw-cli-artifact");
  const payloadRoot = path.join(root, "payload-root");
  const toolDirectory = path.join(root, "tools");
  fs.mkdirSync(path.join(workspace, "bin"), { recursive: true });
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
  if (options.archive === "non-dist") {
    fs.writeFileSync(path.join(payloadRoot, "outside.txt"), "outside dist\n");
    execFileSync("tar", ["-cf", payload, "-C", payloadRoot, "outside.txt"]);
  } else {
    const dist = path.join(payloadRoot, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "nemoclaw.js"), 'console.log("nemoclaw v0.0.0");\n');
    fs.writeFileSync(
      path.join(dist, "build-identity.json"),
      `${JSON.stringify({
        nemoclawVersion: "0.0.0",
        sourceRevision: options.buildIdentitySha ?? candidateSha,
      })}\n`,
    );
    if (options.archive === "link") {
      fs.symlinkSync("nemoclaw.js", path.join(dist, "linked-cli.js"));
    }
    execFileSync("tar", ["-cf", payload, "-C", payloadRoot, "dist"]);
  }

  const actualPayloadSha256 = sha256File(payload);
  const expectedPayloadSha256 = options.expectedPayloadSha256 ?? actualPayloadSha256;
  const artifactName = `nemoclaw-cli-${candidateSha}-${expectedPayloadSha256}`;
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
      workflow: { sha: workflowSha, runId: "98765", runAttempt: "1" },
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
  if (options.preexistingDist) {
    fs.mkdirSync(path.join(workspace, "dist"));
    fs.writeFileSync(path.join(workspace, "dist", "existing.txt"), "preserve\n");
  }

  const action = readYaml<CompositeAction>(".github/actions/restore-e2e-cli-artifact/action.yaml");
  const result = spawnSync("bash", ["-c", action.runs.steps[2]!.run!], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      ARTIFACT_NAME: artifactName,
      CANDIDATE_REPOSITORY: "NVIDIA/NemoClaw",
      CANDIDATE_SHA: candidateSha,
      GITHUB_WORKSPACE: workspace,
      PATH: `${toolDirectory}:${process.env.PATH ?? ""}`,
      PAYLOAD_SHA256: expectedPayloadSha256,
      RUN_ATTEMPT: "1",
      RUN_ID: "98765",
      RUNNER_TEMP: runnerTemp,
      WORKFLOW_SHA: workflowSha,
    },
  });
  return {
    candidateSha,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    output: `${result.stdout}${result.stderr}`,
    result,
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
  it("builds once and gives every build-backed E2E job the verified artifact", () => {
    expect(validateCliArtifactWorkflowBoundary(readWorkflow())).toEqual([]);
  });

  it("accepts an exact producer and consumer identity", () => {
    const result = runIdentityValidation();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["empty artifact ID", { artifactId: "" }],
    ["prefixed upload digest", { artifactDigest: `sha256:${"c".repeat(64)}` }],
    ["malformed candidate SHA", { candidateSha: "abc" }],
    ["different candidate SHA", { candidateSha: "e".repeat(40) }],
    ["unbound artifact name", { artifactName: `nemoclaw-cli-${CANDIDATE_SHA}` }],
    ["malformed payload digest", { payloadSha256: "abc" }],
    ["malformed workflow SHA", { workflowSha: "abc" }],
    ["unknown provenance field", { unexpected: "value" }],
  ])("fails closed for %s", (_case, overrides) => {
    expect(runIdentityValidation(overrides).status).not.toBe(0);
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
        fs
          .readdirSync(fixture.runnerTemp)
          .filter((entry) => entry.startsWith("nemoclaw-cli-restore.")),
      ).toEqual([]);
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

  it("rejects an archive member outside dist before artifact extraction (#7915)", () => {
    expectRestoreFailure(
      { archive: "non-dist" },
      "CLI artifact contains an unsafe member: outside.txt",
    );
  });

  it("rejects an archive link before artifact extraction (#7915)", () => {
    expectRestoreFailure({ archive: "link" }, "CLI artifact contains a link or special file");
  });

  it("does not overwrite a preexisting dist directory (#7915)", () => {
    const fixture = runRestoreValidation({ preexistingDist: true });
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
    const uploadStep = requireStep(workflow, "generate-matrix", CLI_ARTIFACT_PUBLISH_STEP);
    uploadStep.uses = "actions/upload-artifact@v7";

    expect(validateCliArtifactWorkflowBoundary(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix must expose exact cli_artifact_provenance provenance",
        "CLI artifact package step must bind candidate and trusted workflow identities explicitly",
        `CLI artifact package step must contain ${CONTENT_ADDRESSED_ARTIFACT_NAME}`,
        "CLI artifact upload must use the immutable content-addressed upload contract",
      ]),
    );
  });

  it("rejects incomplete consumer provenance and a mutable action reference", () => {
    const workflow = workflowFixture();
    const restore = requireStep(workflow, "sandbox-operations", CLI_ARTIFACT_RESTORE_STEP);
    restore.uses = "NVIDIA/NemoClaw/.github/actions/restore-e2e-cli-artifact@main";
    restore.with = { "provenance-json": "${{ inputs.checkout_sha }}" };

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "sandbox-operations must use the immutable complete CLI artifact restore contract",
    );
  });

  it("rejects action implementation drift that weakens extraction or payload verification", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-artifact-action-"));
    const actionPath = path.join(directory, "action.yaml");
    const source = readRepoText(".github/actions/restore-e2e-cli-artifact/action.yaml")
      .replace("tar --no-same-owner --no-same-permissions", "tar")
      .replace('[[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]', '[[ -s "$payload" ]]');
    fs.writeFileSync(actionPath, source);

    expect(validateCliArtifactRestoreAction(actionPath)).toEqual(
      expect.arrayContaining([
        "CLI artifact restore action must match its immutable workflow pin",
        'CLI artifact payload verification must contain tar --no-same-owner --no-same-permissions -xf "$payload" -C "$restore_dir"',
        'CLI artifact payload verification must contain [[ "$actual_payload_sha256" == "$PAYLOAD_SHA256" ]]',
      ]),
    );
  });

  it("rejects missing consumer restoration", () => {
    const workflow = workflowFixture();
    workflow.jobs["cloud-inference"].steps = workflow.jobs["cloud-inference"].steps!.filter(
      (step) => step.name !== CLI_ARTIFACT_RESTORE_STEP,
    );

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "cloud-inference must verify and restore the exact CLI artifact exactly once",
    );
  });

  it("keeps installer-backed no-build jobs outside the artifact handoff", () => {
    const workflow = workflowFixture();
    const inheritedRestore = requireStep(workflow, "sandbox-operations", CLI_ARTIFACT_RESTORE_STEP);
    workflow.jobs["security-posture"].steps!.push(inheritedRestore);

    expect(validateCliArtifactWorkflowBoundary(workflow)).toContain(
      "security-posture must not consume the shared CLI artifact",
    );
  });
});
