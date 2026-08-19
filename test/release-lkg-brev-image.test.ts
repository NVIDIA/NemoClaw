// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readYaml } from "./helpers/e2e-workflow-contract";

const repoRoot = path.join(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "release-lkg-brev-image.sh");
const workflowPath = ".github/workflows/release-lkg-brev-image.yaml";
const sourceWorkflowRef = `NVIDIA/NemoClaw/${workflowPath}@refs/tags/lkg`;
const fixedCreatedAt = "2026-08-19T12:34:56Z";
const sourceRunId = "32290000000";
const tempRoots: string[] = [];

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
};

type Fixture = {
  binDir: string;
  commit: string;
  counterPath: string;
  recordDir: string;
  requestPath: string;
  root: string;
  summaryPath: string;
  work: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "LKG Dispatch Test",
      GIT_AUTHOR_EMAIL: "lkg-dispatch@example.com",
      GIT_COMMITTER_NAME: "LKG Dispatch Test",
      GIT_COMMITTER_EMAIL: "lkg-dispatch@example.com",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "tag.gpgSign",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "commit.gpgSign",
      GIT_CONFIG_VALUE_1: "false",
    },
  }).trim();
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-lkg-brev-image-"));
  tempRoots.push(root);
  const work = path.join(root, "work");
  const binDir = path.join(root, "bin");
  const recordDir = path.join(root, "gh-records");
  const counterPath = path.join(root, "gh-counter.txt");
  const requestPath = path.join(
    root,
    "runner-temp",
    "nemoclaw-lkg-image-request",
    "nemoclaw-lkg-image-request.v1.json",
  );
  const summaryPath = path.join(root, "summary.md");
  fs.mkdirSync(work);
  fs.mkdirSync(binDir);
  fs.mkdirSync(recordDir);
  git(work, ["init"]);
  fs.writeFileSync(path.join(work, "file.txt"), "initial\n");
  git(work, ["add", "file.txt"]);
  git(work, ["commit", "-m", "initial"]);
  const commit = git(work, ["rev-parse", "HEAD"]);

  const fakeGh = path.join(binDir, "gh");
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${GH_TOKEN:-}" != "\${EXPECTED_GH_TOKEN:-}" ]]; then
  echo "unexpected GH_TOKEN" >&2
  exit 2
fi
call=1
if [[ -f "$GH_COUNTER_PATH" ]]; then
  call=$(( $(<"$GH_COUNTER_PATH") + 1 ))
fi
printf '%s\n' "$call" >"$GH_COUNTER_PATH"
printf '%s\n' "$@" >"$GH_RECORD_DIR/gh-args-$call.txt"
cat >"$GH_RECORD_DIR/gh-input-$call.json"
exit_name="GH_EXIT_CODE_$call"
exit_code="\${!exit_name:-0}"
if [[ "$exit_code" != "0" ]]; then
  echo "HTTP 403: dispatch denied" >&2
  exit "$exit_code"
fi
output_name="GH_OUTPUT_$call"
printf '%s\n' "\${!output_name}"
`,
    "utf8",
  );
  fs.chmodSync(fakeGh, 0o755);

  const fakeDate = path.join(binDir, "date");
  fs.writeFileSync(
    fakeDate,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == "2" && "$1" == "-u" && "$2" == "+%Y-%m-%dT%H:%M:%SZ" ]]; then
  printf '%s\n' "${fixedCreatedAt}"
else
  /bin/date "$@"
fi
`,
    "utf8",
  );
  fs.chmodSync(fakeDate, 0o755);

  return {
    binDir,
    commit,
    counterPath,
    recordDir,
    requestPath,
    root,
    summaryPath,
    work,
  };
}

function tag(fixture: Fixture, name: string, annotated = true): void {
  const args = annotated
    ? ["tag", "-a", name, fixture.commit, "-m", name]
    : ["tag", name, fixture.commit];
  git(fixture.work, args);
}

function runScript(
  fixture: Fixture,
  operation: "prepare-request" | "dispatch-images",
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [scriptPath, operation], {
    cwd: fixture.work,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_GH_TOKEN: "test-dispatch-token",
      GH_COUNTER_PATH: fixture.counterPath,
      GH_EXIT_CODE_1: "0",
      GH_EXIT_CODE_2: "0",
      GH_OUTPUT_1: "123456789\thttps://github.com/brevdev/nemoclaw-image/actions/runs/123456789",
      GH_OUTPUT_2: "987654321\thttps://github.com/brevdev/nemoclaw-image/actions/runs/987654321",
      GH_RECORD_DIR: fixture.recordDir,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/lkg",
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: sourceRunId,
      GITHUB_SHA: fixture.commit,
      GITHUB_STEP_SUMMARY: fixture.summaryPath,
      GITHUB_WORKFLOW_REF: sourceWorkflowRef,
      LKG_DELETED: "false",
      LKG_REQUEST_PATH: fixture.requestPath,
      LKG_SHA: fixture.commit,
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "test-dispatch-token",
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: path.join(fixture.root, "runner-temp"),
      ...extraEnv,
    },
  });
}

function callCount(fixture: Fixture): number {
  return fs.existsSync(fixture.counterPath)
    ? Number.parseInt(fs.readFileSync(fixture.counterPath, "utf8"), 10)
    : 0;
}

function callArgs(fixture: Fixture, call: number): string[] {
  return fs
    .readFileSync(path.join(fixture.recordDir, `gh-args-${call}.txt`), "utf8")
    .trim()
    .split("\n");
}

function callInput(fixture: Fixture, call: number): string {
  return fs.readFileSync(path.join(fixture.recordDir, `gh-input-${call}.json`), "utf8");
}

function expectedArgs(workflow: string): string[] {
  return [
    "api",
    "--method",
    "POST",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    `repos/brevdev/nemoclaw-image/actions/workflows/${workflow}/dispatches`,
    "--input",
    "-",
    "--jq",
    "[.workflow_run_id, .html_url] | @tsv",
  ];
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("LKG Brev image request workflow", () => {
  // source-shape-contract: security -- The LKG caller must keep event provenance, attestation permissions, action pins, operation order, and its dispatch credential on reviewed workflow boundaries
  it("attests one request before the isolated dispatch job (#9661)", () => {
    const workflow = readYaml<Workflow>(workflowPath);

    expect(workflow.on).toEqual({ push: { tags: ["lkg"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual([
      "attest-lkg-image-request",
      "dispatch-production-image",
    ]);

    const attest = workflow.jobs["attest-lkg-image-request"];
    expect(attest.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(attest.if).toContain("github.event_name == 'push'");
    expect(attest.if).toContain("github.ref == 'refs/tags/lkg'");
    expect(attest.if).toContain("github.event.deleted == false");
    expect(attest.if).toContain("github.run_attempt == 1");
    expect(attest.permissions).toEqual({
      contents: "read",
      attestations: "write",
      "id-token": "write",
    });
    expect(attest["runs-on"]).toBe("ubuntu-latest");
    expect(JSON.stringify(attest)).not.toContain("NEMOCLAW_IMAGE_DISPATCH_TOKEN");

    const steps = attest.steps ?? [];
    expect(steps.map((step) => step.name)).toEqual([
      "Check out LKG target",
      "Prepare LKG image request",
      "Upload LKG image request",
      "Attest LKG image request",
    ]);
    expect(steps[0]).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false },
    });
    expect(steps[1]).toMatchObject({
      run: "scripts/release-lkg-brev-image.sh prepare-request",
      env: {
        LKG_REQUEST_PATH: "nemoclaw-lkg-image-request.v1.json",
        LKG_SHA: "${{ github.sha }}",
      },
    });
    expect(steps[2]).toEqual({
      name: "Upload LKG image request",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "nemoclaw-lkg-image-request-v1-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "nemoclaw-lkg-image-request.v1.json",
        "if-no-files-found": "error",
        "retention-days": 30,
      },
    });
    expect(steps[3]).toEqual({
      name: "Attest LKG image request",
      uses: "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      with: {
        "subject-path": "nemoclaw-lkg-image-request.v1.json",
      },
    });

    const dispatch = workflow.jobs["dispatch-production-image"];
    expect(dispatch.needs).toBe("attest-lkg-image-request");
    expect(dispatch.if).toContain("success()");
    expect(dispatch.if).toContain("github.run_attempt == 1");
    expect(dispatch.permissions).toEqual({ contents: "read" });
    expect(dispatch["runs-on"]).toBe("ubuntu-latest");
    const dispatchSteps = dispatch.steps ?? [];
    expect(dispatchSteps.at(-1)).toMatchObject({
      run: "scripts/release-lkg-brev-image.sh dispatch-images",
      env: {
        NEMOCLAW_IMAGE_DISPATCH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
      },
    });
    expect(JSON.stringify(dispatchSteps.slice(0, -1))).not.toContain(
      "NEMOCLAW_IMAGE_DISPATCH_TOKEN",
    );
    expect(JSON.stringify(workflow).match(/\$\{\{ secrets\.[^}]+ \}\}/gu)).toEqual([
      "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
    ]);
  });
});

describe("LKG Brev image request", () => {
  it("writes the canonical request bytes without credentials (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "lkg", false);
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "prepare-request");

    expect(result.status).toBe(0);
    const expected = `${JSON.stringify({
      schemaVersion: 1,
      kind: "nemoclaw-lkg-image-request",
      sourceRepository: "NVIDIA/NemoClaw",
      sourceWorkflow: workflowPath,
      event: "push",
      ref: "refs/tags/lkg",
      runId: sourceRunId,
      runAttempt: 1,
      eventSha: fixture.commit,
      targetRepository: "brevdev/nemoclaw-image",
      targetWorkflow: ".github/workflows/build-lkg-image.yml",
      createdAt: fixedCreatedAt,
    })}\n`;
    const request = fs.readFileSync(fixture.requestPath, "utf8");
    expect(request).toBe(expected);
    expect(request.split("\n")).toHaveLength(2);
    expect(fs.statSync(fixture.requestPath).mode & 0o777).toBe(0o400);
    expect(callCount(fixture)).toBe(0);
    expect(fs.existsSync(fixture.summaryPath)).toBe(false);
    expect(`${request}${result.stdout}${result.stderr}`).not.toContain("test-dispatch-token");
  });

  it.each([
    ["another repository", { GITHUB_REPOSITORY: "example/NemoClaw" }, "GITHUB_REPOSITORY"],
    ["another event", { GITHUB_EVENT_NAME: "workflow_dispatch" }, "GITHUB_EVENT_NAME"],
    ["another ref", { GITHUB_REF: "refs/heads/lkg" }, "GITHUB_REF"],
    [
      "another workflow ref",
      { GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/other.yaml@refs/tags/lkg" },
      "GITHUB_WORKFLOW_REF",
    ],
    ["a zero run ID", { GITHUB_RUN_ID: "0" }, "GITHUB_RUN_ID"],
    ["a workflow rerun", { GITHUB_RUN_ATTEMPT: "2" }, "GITHUB_RUN_ATTEMPT"],
    ["an uppercase event SHA", { GITHUB_SHA: "A".repeat(40) }, "GITHUB_SHA"],
  ])("rejects %s before creating a request (#9661)", (_name, environment, message) => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "prepare-request", environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
    expect(callCount(fixture)).toBe(0);
  });

  it("rejects an indirect LKG tag object before creating a request (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");
    tag(fixture, "lkg");
    const lkgObject = git(fixture.work, ["rev-parse", "refs/tags/lkg"]);

    const result = runScript(fixture, "prepare-request", {
      GITHUB_SHA: lkgObject,
      LKG_SHA: lkgObject,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("LKG_SHA must identify the LKG commit directly");
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
  });

  it("fails before creating a request when LKG has no exact release (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109-rc.1");

    const result = runScript(fixture, "prepare-request");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`LKG target ${fixture.commit} has no exact vX.Y.Z release tag`);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
    expect(callCount(fixture)).toBe(0);
  });

  it("requires a request location before creating the request (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "prepare-request", {
      LKG_REQUEST_PATH: "",
      RUNNER_TEMP: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "RUNNER_TEMP or LKG_REQUEST_PATH is required to locate the LKG image request",
    );
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
    expect(callCount(fixture)).toBe(0);
  });

  it("refuses to overwrite an existing request (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");
    fs.mkdirSync(path.dirname(fixture.requestPath), { recursive: true });
    fs.writeFileSync(fixture.requestPath, "existing\n");

    const result = runScript(fixture, "prepare-request");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite existing LKG image request");
    expect(fs.readFileSync(fixture.requestPath, "utf8")).toBe("existing\n");
  });
});

describe("LKG Brev image dispatches", () => {
  it("preserves production and adds the run-identity-only LKG dispatch (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.9");
    tag(fixture, "v0.0.10");
    tag(fixture, "v0.0.11-rc.1");

    const result = runScript(fixture, "dispatch-images");

    expect(result.status).toBe(0);
    expect(callCount(fixture)).toBe(2);
    expect(callArgs(fixture, 1)).toEqual(expectedArgs("build-scheduled.yml"));
    expect(callInput(fixture, 1)).toBe(
      '{"ref":"main","inputs":{"nemoclaw_ref":"v0.0.10"},"return_run_details":true}\n',
    );
    expect(callArgs(fixture, 2)).toEqual(expectedArgs("build-lkg-image.yml"));
    expect(callInput(fixture, 2)).toBe(
      `{"ref":"main","return_run_details":true,"inputs":{"requester_workflow_run_id":"${sourceRunId}","requester_workflow_run_attempt":"1"}}\n`,
    );

    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(`LKG commit: \`${fixture.commit}\``);
    expect(summary).toContain("Release tag: `v0.0.10`");
    expect(summary).toContain(`Source run: \`${sourceRunId}\` (attempt \`1\`)`);
    expect(summary).toContain(
      "Target: `brevdev/nemoclaw-image/.github/workflows/build-scheduled.yml@main`",
    );
    expect(summary).toContain(
      "Downstream run: [123456789](https://github.com/brevdev/nemoclaw-image/actions/runs/123456789)",
    );
    expect(summary).toContain(
      "Target: `brevdev/nemoclaw-image/.github/workflows/build-lkg-image.yml@main`",
    );
    expect(summary).toContain(
      "Downstream run: [987654321](https://github.com/brevdev/nemoclaw-image/actions/runs/987654321)",
    );
    expect(summary.match(/Dispatch result: `accepted \(HTTP 200\)`/gu)).toHaveLength(2);
    expect(`${result.stdout}${result.stderr}${summary}`).not.toContain("test-dispatch-token");
  });

  it("skips both dispatches when the LKG tag is deleted (#9661)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "dispatch-images", {
      GITHUB_SHA: "",
      LKG_DELETED: "true",
      LKG_SHA: "",
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipping deleted lkg tag");
    expect(callCount(fixture)).toBe(0);
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary.match(/Dispatch result: `skipped \(lkg deleted\)`/gu)).toHaveLength(2);
  });

  it("fails before either dispatch when the credential is absent (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", {
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_IMAGE_DISPATCH_TOKEN is required");
    expect(callCount(fixture)).toBe(0);
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary.match(/Dispatch result: `not attempted`/gu)).toHaveLength(2);
  });

  it("rejects a workflow rerun before either dispatch (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", { GITHUB_RUN_ATTEMPT: "2" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GITHUB_RUN_ATTEMPT must be 1");
    expect(callCount(fixture)).toBe(0);
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary.match(/Dispatch result: `not attempted`/gu)).toHaveLength(2);
  });

  it("records the LKG run when production returns invalid run details (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", { GH_OUTPUT_1: "null\tnull" });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(2);
    expect(result.stderr).toContain(
      "GitHub accepted the production image dispatch but did not return valid run details",
    );
    expect(result.stderr).toContain("will not be retried");
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `accepted (remote run identity unavailable)`");
    expect(summary).toContain(
      "Downstream run: [987654321](https://github.com/brevdev/nemoclaw-image/actions/runs/987654321)",
    );
  });

  it("attempts the LKG dispatch after an unconfirmed production write (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", { GH_EXIT_CODE_1: "1" });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(2);
    expect(result.stderr).toContain("production image dispatch; it may have been accepted");
    expect(callArgs(fixture, 2)).toEqual(expectedArgs("build-lkg-image.yml"));
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `failed (dispatch may have been accepted)`");
    expect(summary).toContain(
      "Downstream run: [987654321](https://github.com/brevdev/nemoclaw-image/actions/runs/987654321)",
    );
  });

  it("preserves the production run when the LKG dispatch is unconfirmed (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", { GH_EXIT_CODE_2: "1" });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(2);
    expect(result.stderr).toContain("LKG-only image dispatch; it may have been accepted");
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(
      "Downstream run: [123456789](https://github.com/brevdev/nemoclaw-image/actions/runs/123456789)",
    );
    expect(summary).toContain("Dispatch result: `failed (dispatch may have been accepted)`");
  });

  it("rejects a returned run URL that does not match its numeric ID (#9661)", () => {
    const fixture = createFixture();
    tag(fixture, "v0.0.109");

    const result = runScript(fixture, "dispatch-images", {
      GH_OUTPUT_2: "987654321\thttps://github.com/brevdev/nemoclaw-image/actions/runs/123456789",
    });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(2);
    expect(result.stderr).toContain(
      "GitHub accepted the LKG-only image dispatch but did not return valid run details",
    );
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `accepted (remote run identity unavailable)`");
    expect(summary).toContain("Downstream run: `unavailable`");
    expect(summary).not.toContain("actions/runs/987654321");
  });
});
