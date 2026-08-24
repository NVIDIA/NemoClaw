// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readYaml } from "../../helpers/e2e-workflow-contract";

const repoRoot = path.join(import.meta.dirname, "../../..");
const scriptPath = path.join(repoRoot, "scripts", "release-daily-brev-image.sh");
const workflowPath = ".github/workflows/release-daily-brev-image.yaml";
const releaseTag = "v0.0.113";
const sourceRef = `refs/tags/${releaseTag}`;
const sourceWorkflowRef = `NVIDIA/NemoClaw/${workflowPath}@${sourceRef}`;
const eventSha = "a".repeat(40);
const tagObjectSha = "b".repeat(40);
const fixedCreatedAt = "2026-08-20T12:34:56Z";
const sourceRunId = "32390000000";
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
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<string, WorkflowJob>;
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
};

type Fixture = {
  binDir: string;
  counterPath: string;
  recordDir: string;
  requestPath: string;
  root: string;
  summaryPath: string;
};

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-daily-brev-image-"));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  const recordDir = path.join(root, "gh-records");
  const counterPath = path.join(root, "gh-counter.txt");
  const requestPath = path.join(
    root,
    "runner-temp",
    "nemoclaw-daily-image-request",
    "nemoclaw-daily-image-request.v1.json",
  );
  const summaryPath = path.join(root, "summary.md");
  fs.mkdirSync(binDir);
  fs.mkdirSync(recordDir);

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
endpoint=""
for argument in "$@"; do
  case "$argument" in
    repos/*)
      endpoint="$argument"
      break
      ;;
  esac
done
printf '%s\n' "$endpoint" >"$GH_RECORD_DIR/gh-endpoint-$call.txt"
if [[ " $* " == *" --input - "* ]]; then
  cat >"$GH_RECORD_DIR/gh-input-$call.json"
else
  : >"$GH_RECORD_DIR/gh-input-$call.json"
fi
if [[ -n "\${GH_FAIL_ENDPOINT:-}" && "$endpoint" == "$GH_FAIL_ENDPOINT" ]]; then
  echo "HTTP 403: request denied" >&2
  exit 1
fi
case "$endpoint" in
  repos/NVIDIA/NemoClaw/git/ref/tags/*)
    printf '%s\t%s\n' "\${GH_REF_OBJECT_TYPE:-tag}" "\${GH_TAG_OBJECT_SHA:-${tagObjectSha}}"
    ;;
  repos/NVIDIA/NemoClaw/git/tags/*)
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "\${GH_OBJECT_TAG:-${releaseTag}}" \
      "\${GH_OBJECT_TYPE:-commit}" \
      "\${GH_OBJECT_SHA:-${eventSha}}" \
      "\${GH_TAG_VERIFIED:-true}" \
      "\${GH_VERIFICATION_REASON:-valid}"
    ;;
  repos/NVIDIA/NemoClaw/compare/*)
    printf '%s\n' "\${GH_COMPARE_STATUS:-ahead}"
    ;;
  repos/brevdev/nemoclaw-image/actions/workflows/build-daily-image.yml/dispatches)
    printf '%b\n' "\${GH_DISPATCH_OUTPUT:-987654321\\thttps://github.com/brevdev/nemoclaw-image/actions/runs/987654321}"
    ;;
  *)
    echo "unexpected endpoint: $endpoint" >&2
    exit 3
    ;;
esac
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

  const fakeSleep = path.join(binDir, "sleep");
  fs.writeFileSync(fakeSleep, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.chmodSync(fakeSleep, 0o755);

  return { binDir, counterPath, recordDir, requestPath, root, summaryPath };
}

function runScript(
  fixture: Fixture,
  operation: "prepare-request" | "dispatch-image",
  extraEnv: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  const prepare = operation === "prepare-request";
  return spawnSync("bash", [scriptPath, operation], {
    encoding: "utf8",
    env: {
      ...process.env,
      DAILY_IMAGE_DELETED: "false",
      DAILY_IMAGE_REQUEST_PATH: fixture.requestPath,
      DAILY_IMAGE_SHA: eventSha,
      EXPECTED_GH_TOKEN: prepare ? "test-read-token" : "test-dispatch-token",
      GH_COUNTER_PATH: fixture.counterPath,
      GH_RECORD_DIR: fixture.recordDir,
      GH_TOKEN: prepare ? "test-read-token" : "",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: sourceRef,
      GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: sourceRunId,
      GITHUB_SHA: eventSha,
      GITHUB_STEP_SUMMARY: fixture.summaryPath,
      GITHUB_WORKFLOW_REF: sourceWorkflowRef,
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

function callEndpoint(fixture: Fixture, call: number): string {
  return fs.readFileSync(path.join(fixture.recordDir, `gh-endpoint-${call}.txt`), "utf8").trim();
}

function callInput(fixture: Fixture, call: number): string {
  return fs.readFileSync(path.join(fixture.recordDir, `gh-input-${call}.json`), "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Daily Brev image request workflow", () => {
  // source-shape-contract: security -- The daily release caller must keep tag provenance, attestation permissions, action pins, job order, and its dispatch credential on reviewed workflow boundaries
  it("attests one daily request before the isolated dispatch job (#9799)", () => {
    const workflow = readYaml<Workflow>(workflowPath);

    expect(workflow.on).toEqual({ push: { tags: ["v*.*.*"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "release-daily-brev-image-${{ github.ref }}",
      "cancel-in-progress": false,
    });
    expect(Object.keys(workflow.jobs)).toEqual([
      "attest-daily-image-request",
      "dispatch-daily-image",
    ]);

    const attest = workflow.jobs["attest-daily-image-request"];
    expect(attest.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(attest.if).toContain("github.event_name == 'push'");
    expect(attest.if).toContain("startsWith(github.ref, 'refs/tags/v')");
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
      "Check out daily release target",
      "Prepare daily image request",
      "Upload daily image request",
      "Attest daily image request",
    ]);
    expect(steps[0]).toMatchObject({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false },
    });
    expect(steps[1]).toEqual({
      name: "Prepare daily image request",
      env: {
        DAILY_IMAGE_DELETED: "${{ github.event.deleted }}",
        DAILY_IMAGE_REQUEST_PATH: "nemoclaw-daily-image-request.v1.json",
        DAILY_IMAGE_SHA: "${{ github.sha }}",
        GH_TOKEN: "${{ github.token }}",
      },
      run: "scripts/release-daily-brev-image.sh prepare-request",
    });
    expect(steps[2]).toEqual({
      name: "Upload daily image request",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "nemoclaw-daily-image-request-v1-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "nemoclaw-daily-image-request.v1.json",
        "if-no-files-found": "error",
        "retention-days": 30,
      },
    });
    expect(steps[3]).toEqual({
      name: "Attest daily image request",
      uses: "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      with: { "subject-path": "nemoclaw-daily-image-request.v1.json" },
    });

    const dispatch = workflow.jobs["dispatch-daily-image"];
    expect(dispatch.needs).toBe("attest-daily-image-request");
    expect(dispatch.if).toContain("success()");
    expect(dispatch.if).toContain("github.event.deleted == false");
    expect(dispatch.if).toContain("github.run_attempt == 1");
    expect(dispatch.permissions).toEqual({ contents: "read" });
    expect(dispatch["runs-on"]).toBe("ubuntu-latest");
    const dispatchSteps = dispatch.steps ?? [];
    expect(dispatchSteps).toHaveLength(2);
    expect(dispatchSteps[0]).toEqual({
      name: "Check out daily release target",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "${{ github.sha }}",
        "fetch-depth": 1,
        "persist-credentials": false,
      },
    });
    expect(dispatchSteps[1]).toEqual({
      name: "Dispatch daily image build",
      env: {
        DAILY_IMAGE_DELETED: "${{ github.event.deleted }}",
        DAILY_IMAGE_SHA: "${{ github.sha }}",
        NEMOCLAW_IMAGE_DISPATCH_TOKEN: "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
      },
      run: "scripts/release-daily-brev-image.sh dispatch-image",
    });
    expect(JSON.stringify(dispatchSteps[0])).not.toContain("NEMOCLAW_IMAGE_DISPATCH_TOKEN");
    expect(JSON.stringify(workflow).match(/\$\{\{ secrets\.[^}]+ \}\}/gu)).toEqual([
      "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}",
    ]);
    expect(JSON.stringify(workflow)).not.toContain("google-github-actions/auth");
  });
});

describe("Daily Brev image request", () => {
  it("writes the canonical verified-tag request bytes without credentials (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "prepare-request");

    expect(result.status).toBe(0);
    expect(callCount(fixture)).toBe(3);
    expect(callEndpoint(fixture, 1)).toBe(`repos/NVIDIA/NemoClaw/git/ref/tags/${releaseTag}`);
    expect(callEndpoint(fixture, 2)).toBe(`repos/NVIDIA/NemoClaw/git/tags/${tagObjectSha}`);
    expect(callEndpoint(fixture, 3)).toBe(`repos/NVIDIA/NemoClaw/compare/${eventSha}...main`);
    expect(callInput(fixture, 1)).toBe("");
    expect(callInput(fixture, 2)).toBe("");
    expect(callInput(fixture, 3)).toBe("");

    const expected = `${JSON.stringify({
      schemaVersion: 1,
      kind: "nemoclaw-daily-image-request",
      sourceRepository: "NVIDIA/NemoClaw",
      sourceWorkflow: workflowPath,
      event: "push",
      ref: sourceRef,
      runId: sourceRunId,
      runAttempt: 1,
      eventSha,
      releaseTag,
      tagObjectSha,
      targetRepository: "brevdev/nemoclaw-image",
      targetWorkflow: ".github/workflows/build-daily-image.yml",
      createdAt: fixedCreatedAt,
    })}\n`;
    const request = fs.readFileSync(fixture.requestPath, "utf8");
    expect(request).toBe(expected);
    expect(request.split("\n")).toHaveLength(2);
    expect(fs.statSync(fixture.requestPath).mode & 0o777).toBe(0o400);
    expect(fs.existsSync(fixture.summaryPath)).toBe(false);
    expect(`${request}${result.stdout}${result.stderr}`).not.toContain("test-read-token");
    expect(`${request}${result.stdout}${result.stderr}`).not.toContain("test-dispatch-token");
  });

  it.each([
    ["another repository", { GITHUB_REPOSITORY: "example/NemoClaw" }, "GITHUB_REPOSITORY"],
    ["a manual event", { GITHUB_EVENT_NAME: "workflow_dispatch" }, "GITHUB_EVENT_NAME"],
    ["a deleted tag", { DAILY_IMAGE_DELETED: "true" }, "DAILY_IMAGE_DELETED"],
    ["a branch", { GITHUB_REF: "refs/heads/main" }, "GITHUB_REF"],
    ["a prerelease", { GITHUB_REF: "refs/tags/v0.0.113-rc.1" }, "GITHUB_REF"],
    ["a leading-zero version", { GITHUB_REF: "refs/tags/v00.0.113" }, "GITHUB_REF"],
    [
      "another workflow ref",
      { GITHUB_WORKFLOW_REF: `NVIDIA/NemoClaw/.github/workflows/other.yaml@${sourceRef}` },
      "GITHUB_WORKFLOW_REF",
    ],
    ["a zero run ID", { GITHUB_RUN_ID: "0" }, "GITHUB_RUN_ID"],
    ["a workflow rerun", { GITHUB_RUN_ATTEMPT: "2" }, "GITHUB_RUN_ATTEMPT"],
    ["an uppercase event SHA", { GITHUB_SHA: "A".repeat(40) }, "GITHUB_SHA"],
    ["a missing event SHA binding", { DAILY_IMAGE_SHA: "" }, "DAILY_IMAGE_SHA is required"],
    ["another event SHA binding", { DAILY_IMAGE_SHA: "c".repeat(40) }, "must match GITHUB_SHA"],
  ])("rejects %s before reading GitHub tag state (#9799)", (_name, environment, message) => {
    const fixture = createFixture();

    const result = runScript(fixture, "prepare-request", environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
    expect(callCount(fixture)).toBe(0);
  });

  it("requires the job-scoped GitHub token before reading tag state (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "prepare-request", { GH_TOKEN: "" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GH_TOKEN is required to verify the daily release tag");
    expect(callCount(fixture)).toBe(0);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
  });

  it.each([
    ["a lightweight tag", { GH_REF_OBJECT_TYPE: "commit" }, "must be annotated"],
    ["an invalid tag-object SHA", { GH_TAG_OBJECT_SHA: "short" }, "invalid tag-object SHA"],
    ["a renamed tag object", { GH_OBJECT_TAG: "v0.0.112" }, "names v0.0.112"],
    ["an indirect tag", { GH_OBJECT_TYPE: "tag" }, "must point directly to a commit"],
    ["another commit", { GH_OBJECT_SHA: "c".repeat(40) }, "must point to GITHUB_SHA"],
    [
      "a non-valid verification reason",
      { GH_TAG_VERIFIED: "true", GH_VERIFICATION_REASON: "expired_key" },
      "verification reason must be valid",
    ],
    ["an unverified tag", { GH_TAG_VERIFIED: "false" }, "is not GitHub-Verified"],
    ["a commit outside main", { GH_COMPARE_STATUS: "diverged" }, "must be reachable from main"],
  ])("rejects %s before creating a request (#9799)", (_name, environment, message) => {
    const fixture = createFixture();

    const result = runScript(fixture, "prepare-request", environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
    expect(callCount(fixture)).toBeGreaterThan(0);
  });

  it("fails closed when GitHub cannot return the annotated tag object (#9799)", () => {
    const fixture = createFixture();
    const endpoint = `repos/NVIDIA/NemoClaw/git/tags/${tagObjectSha}`;

    const result = runScript(fixture, "prepare-request", { GH_FAIL_ENDPOINT: endpoint });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unable to inspect release tag object");
    expect(callCount(fixture)).toBe(2);
    expect(fs.existsSync(fixture.requestPath)).toBe(false);
  });

  it("requires a request location after validating the release tag (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "prepare-request", {
      DAILY_IMAGE_REQUEST_PATH: "",
      RUNNER_TEMP: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "RUNNER_TEMP or DAILY_IMAGE_REQUEST_PATH is required to locate the daily image request",
    );
    expect(callCount(fixture)).toBe(3);
  });

  it("refuses to overwrite an existing request (#9799)", () => {
    const fixture = createFixture();
    fs.mkdirSync(path.dirname(fixture.requestPath), { recursive: true });
    fs.writeFileSync(fixture.requestPath, "existing\n");

    const result = runScript(fixture, "prepare-request");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to overwrite existing daily image request");
    expect(fs.readFileSync(fixture.requestPath, "utf8")).toBe("existing\n");
  });
});

describe("Daily Brev image dispatch", () => {
  it("dispatches only the attested source run identity without waiting downstream (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "dispatch-image");

    expect(result.status).toBe(0);
    expect(callCount(fixture)).toBe(1);
    expect(callEndpoint(fixture, 1)).toBe(
      "repos/brevdev/nemoclaw-image/actions/workflows/build-daily-image.yml/dispatches",
    );
    expect(callArgs(fixture, 1)).toEqual([
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      "repos/brevdev/nemoclaw-image/actions/workflows/build-daily-image.yml/dispatches",
      "--input",
      "-",
      "--jq",
      "[.workflow_run_id, .html_url] | @tsv",
    ]);
    expect(callInput(fixture, 1)).toBe(
      `{"ref":"main","return_run_details":true,"inputs":{"requester_workflow_run_id":"${sourceRunId}","requester_workflow_run_attempt":"1"}}\n`,
    );
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain(`Release tag: \`${releaseTag}\``);
    expect(summary).toContain(`Event commit: \`${eventSha}\``);
    expect(summary).toContain(`Source run: \`${sourceRunId}\` (attempt \`1\`)`);
    expect(summary).toContain(
      "Target: `brevdev/nemoclaw-image/.github/workflows/build-daily-image.yml@main`",
    );
    expect(summary).toContain("Dispatch result: `accepted (HTTP 200)`");
    expect(summary).toContain(
      "Downstream run: [987654321](https://github.com/brevdev/nemoclaw-image/actions/runs/987654321)",
    );
    expect(`${result.stdout}${result.stderr}${summary}`).not.toContain("test-dispatch-token");
  });

  it("fails before dispatch when the credential is absent (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "dispatch-image", {
      NEMOCLAW_IMAGE_DISPATCH_TOKEN: "",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_IMAGE_DISPATCH_TOKEN is required");
    expect(callCount(fixture)).toBe(0);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain(
      "Dispatch result: `not attempted`",
    );
  });

  it.each([
    ["a deleted tag", { DAILY_IMAGE_DELETED: "true" }, "DAILY_IMAGE_DELETED"],
    ["a manual event", { GITHUB_EVENT_NAME: "workflow_dispatch" }, "GITHUB_EVENT_NAME"],
    ["a prerelease", { GITHUB_REF: "refs/tags/v0.0.113-rc.1" }, "GITHUB_REF"],
    ["a workflow rerun", { GITHUB_RUN_ATTEMPT: "2" }, "GITHUB_RUN_ATTEMPT"],
  ])("rejects %s before dispatch (#9799)", (_name, environment, message) => {
    const fixture = createFixture();

    const result = runScript(fixture, "dispatch-image", environment);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(callCount(fixture)).toBe(0);
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain(
      "Dispatch result: `not attempted`",
    );
  });

  it("does not retry an accepted dispatch with an invalid run identity (#9799)", () => {
    const fixture = createFixture();

    const result = runScript(fixture, "dispatch-image", { GH_DISPATCH_OUTPUT: "null\tnull" });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(1);
    expect(result.stderr).toContain("accepted the daily image dispatch");
    expect(result.stderr).toContain("will not be retried");
    const summary = fs.readFileSync(fixture.summaryPath, "utf8");
    expect(summary).toContain("Dispatch result: `accepted (remote run identity unavailable)`");
    expect(summary).toContain("Downstream run: `unavailable`");
  });

  it("does not retry an unconfirmed external write (#9799)", () => {
    const fixture = createFixture();
    const endpoint =
      "repos/brevdev/nemoclaw-image/actions/workflows/build-daily-image.yml/dispatches";

    const result = runScript(fixture, "dispatch-image", { GH_FAIL_ENDPOINT: endpoint });

    expect(result.status).not.toBe(0);
    expect(callCount(fixture)).toBe(1);
    expect(result.stderr).toContain("dispatch; it may have been accepted");
    expect(result.stderr).toContain("will not be retried");
    expect(fs.readFileSync(fixture.summaryPath, "utf8")).toContain(
      "Dispatch result: `failed (dispatch may have been accepted)`",
    );
  });
});
