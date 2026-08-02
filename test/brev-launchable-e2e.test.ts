// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-e2e.sh");
const candidateSha = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function executable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture(
  options: {
    bootImage?: string;
    deleteFails?: boolean;
    e2eFails?: boolean;
    imageRepositorySha?: string;
    missingProvisionReceipt?: boolean;
    omitReceiptField?: "imageName" | "imageRepositorySha" | "project";
    provisionImageRepositorySha?: string;
    provisionSha?: string;
    ready?: boolean;
    receiptSha?: string;
    repoClean?: boolean;
    repoSha?: string;
    runtimeOverrides?: boolean;
    schemaVersion?: number;
    sourceRepository?: string;
    sourcePath?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-e2e-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const state = path.join(root, "workspace.json");
  const calls = path.join(root, "calls.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);

  executable(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
  executable(
    path.join(bin, "sleep"),
    '#!/usr/bin/env bash\nprintf "sleep %s\\n" "$*" >> "$FAKE_CALLS"\n',
  );
  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$FAKE_CALLS"
if [ "$1" = api ]; then
  case "$*" in
    *'/dispatches'*) exit 0 ;;
    *'/workflows/build-launchable-e2e-image.yml/runs'*)
      jq -cn --arg title "Build Launchable E2E image for NemoClaw $CANDIDATE_SHA ($CORRELATION_ID)" \
        '{workflow_runs:[{id:123,display_title:$title,head_branch:"main",created_at:"2099-01-01T00:00:00Z"}]}' ;;
    *'/actions/runs/123'*) jq -cn '{status:"completed",conclusion:"success"}' ;;
    *) exit 2 ;;
  esac
elif [ "$1 $2" = 'run download' ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then directory="$2"; break; fi
    shift
  done
  mkdir -p "$directory"
  jq -n --arg sha "$FAKE_RECEIPT_SHA" --arg correlation "$CORRELATION_ID" \
    --arg imageRepositorySha "$FAKE_IMAGE_REPOSITORY_SHA" \
    --arg omit "$FAKE_OMIT_RECEIPT_FIELD" '{
    kind:"nemoclaw-exact-image-manifest",nemoclawSha:$sha,correlationId:$correlation,
    requesterWorkflowRunId:"789",requesterWorkflowRunAttempt:1,
    imageRepository:"brevdev/nemoclaw-image",producerWorkflow:".github/workflows/build-launchable-e2e-image.yml",
    workflowRunId:"123",workflowRunAttempt:1,
    status:"READY",channel:"staging",variant:"cpu",observedFamily:"nemoclaw-brev-staging-cpu",
    project:"brevdevprod",imageName:"nemoclaw-test-image",imageRepositorySha:$imageRepositorySha
  } | if $omit == "" then . else del(.[$omit]) end' > "$directory/nemoclaw-image-manifest.v1.json"
else
  exit 2
fi
`,
  );
  executable(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'brev %s\\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  ls)
    if [ -f "$FAKE_STATE" ]; then cat "$FAKE_STATE"; else printf '{"workspaces":[]}\\n'; fi ;;
  create)
    if [ "$FAKE_READY" = 1 ]; then shell=READY; build=COMPLETED; else shell=STARTING; build=BUILDING; fi
    jq -cn --arg name "$INSTANCE_NAME" --arg shell "$shell" --arg build "$build" \
      '{workspaces:[{id:"ws-1",name:$name,status:"RUNNING",shell_status:$shell,build_status:$build}]}' > "$FAKE_STATE" ;;
  exec)
    case "$3" in
      *NEMOCLAW_BOOT_IMAGE*)
        printf 'NEMOCLAW_BOOT_IMAGE=%s\\n' "$FAKE_BOOT_IMAGE"
        printf '%s\\n' "$INSTANCE_NAME" ;;
      *repo_clean*)
        [ "$FAKE_MISSING_PROVISION_RECEIPT" != 1 ] || exit 2
        printf 'NEMOCLAW_IDENTITY='
        jq -cn --arg sourcePath "$FAKE_SOURCE_PATH" --arg repo "$FAKE_REPO_SHA" \
          --arg provision "$FAKE_PROVISION_SHA" \
          --arg sourceRepository "$FAKE_SOURCE_REPOSITORY" \
          --arg imageRepositorySha "$FAKE_PROVISION_IMAGE_REPOSITORY_SHA" \
          --argjson schemaVersion "$FAKE_SCHEMA_VERSION" --argjson clean "$FAKE_REPO_CLEAN" \
          --argjson overrides "$FAKE_RUNTIME_OVERRIDES" \
          '{schemaVersion:$schemaVersion,sourceRepository:$sourceRepository,sourcePath:$sourcePath,
            repoSha:$repo,provisionSha:$provision,
            imageRepositorySha:$imageRepositorySha,repoClean:$clean,runtimeOverrides:$overrides}'
        printf '%s\\n' "$INSTANCE_NAME" ;;
      *) exit 2 ;;
    esac ;;
  delete) [ "$FAKE_DELETE_FAILS" = 1 ] || rm -f "$FAKE_STATE" ;;
  refresh) ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
script="$(cat)"
grep -q 'NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable' <<<"$script"
grep -q 'NEMOCLAW_SOURCE_PATH=/opt/nemoclaw-image/NemoClaw' <<<"$script"
grep -q 'runtime-overrides.json' <<<"$script"
printf 'ssh preinstalled full-e2e.test.ts\\n' >> "$FAKE_CALLS"
printf 'remote output contains %s\\n' "$NVIDIA_INFERENCE_API_KEY"
[ "$FAKE_E2E_FAILS" != 1 ] || exit 7
printf 'NEMOCLAW_FULL_E2E_PASSED\\n'
`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_DELETE_TIMEOUT_SECONDS: "5",
    BREV_READY_TIMEOUT_SECONDS: "5",
    BREV_LAUNCHABLE_ID: "env-staging123",
    CANDIDATE_SHA: candidateSha,
    CORRELATION_ID: "11111111-1111-4111-8111-111111111111",
    FAKE_BOOT_IMAGE: options.bootImage ?? "projects/brevdevprod/global/images/nemoclaw-test-image",
    FAKE_CALLS: calls,
    FAKE_DELETE_FAILS: options.deleteFails ? "1" : "0",
    FAKE_E2E_FAILS: options.e2eFails ? "1" : "0",
    FAKE_IMAGE_REPOSITORY_SHA: options.imageRepositorySha ?? "b".repeat(40),
    FAKE_MISSING_PROVISION_RECEIPT: options.missingProvisionReceipt ? "1" : "0",
    FAKE_OMIT_RECEIPT_FIELD: options.omitReceiptField ?? "",
    FAKE_PROVISION_IMAGE_REPOSITORY_SHA:
      options.provisionImageRepositorySha ?? options.imageRepositorySha ?? "b".repeat(40),
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha,
    FAKE_READY: options.ready === false ? "0" : "1",
    FAKE_RECEIPT_SHA: options.receiptSha ?? candidateSha,
    FAKE_REPO_CLEAN: options.repoClean === false ? "false" : "true",
    FAKE_REPO_SHA: options.repoSha ?? candidateSha,
    FAKE_RUNTIME_OVERRIDES: options.runtimeOverrides ? "true" : "false",
    FAKE_SCHEMA_VERSION: String(options.schemaVersion ?? 1),
    FAKE_SOURCE_REPOSITORY: options.sourceRepository ?? "NVIDIA/NemoClaw",
    FAKE_SOURCE_PATH: options.sourcePath ?? "/opt/nemoclaw-image/NemoClaw",
    FAKE_STATE: state,
    GH_TOKEN: "github-test-token",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "789",
    INSTANCE_NAME: "nclaw-e2e-test-1",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test-value",
    POLL_SECONDS: "0",
    RUNNER_TEMP: root,
    WORK_DIR: workDir,
  };
  return { calls, env, state, workDir };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", env });
}

describe("focused staging Brev Launchable lane", () => {
  it("binds the producer run, verifies the clean booted SHA, runs E2E, and deletes (#6943)", () => {
    const { calls, env, state, workDir } = fixture();
    const result = run(env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).toContain("sleep 300");
    expect(commands.indexOf("sleep 300")).toBeLessThan(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
    );
    expect(commands).toContain("create nclaw-e2e-test-1 --launchable env-staging123");
    expect(commands).toContain("ssh preinstalled full-e2e.test.ts");
    expect(commands).not.toContain("nvapi-test-value");
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual([
      "cleanup.json",
      "full-e2e.log",
      "lane.log",
      "launchable-e2e.json",
    ]);
    expect(fs.readFileSync(path.join(workDir, "full-e2e.log"), "utf8")).not.toContain(
      "nvapi-test-value",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      candidateSha,
      fullE2e: "passed",
      producer: { runId: "123", status: "success" },
      boot: {
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        sourcePath: "/opt/nemoclaw-image/NemoClaw",
        repoSha: candidateSha,
        provisionSha: candidateSha,
        repoClean: true,
        runtimeOverrides: false,
      },
      workspace: { id: "ws-1" },
    });
  });

  it("blocks E2E for a wrong receipt, incomplete readiness, or booted checkout mismatch", () => {
    const receipt = fixture({ receiptSha: "b".repeat(40) });
    const receiptResult = run(receipt.env);
    expect(receiptResult.status).not.toBe(0);
    expect(receiptResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(receipt.calls, "utf8")).not.toMatch(/brev create|full-e2e\.test\.ts/u);

    for (const malformed of [
      fixture({ omitReceiptField: "project" }),
      fixture({ omitReceiptField: "imageName" }),
      fixture({ imageRepositorySha: "not-a-sha" }),
    ]) {
      const malformedResult = run(malformed.env);
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stderr).toContain("producer receipt does not match the candidate");
      expect(fs.readFileSync(malformed.calls, "utf8")).not.toMatch(
        /brev create|full-e2e\.test\.ts/u,
      );
    }

    const unready = fixture({ ready: false });
    const unreadyResult = run({ ...unready.env, BREV_READY_TIMEOUT_SECONDS: "1" });
    expect(unreadyResult.status).not.toBe(0);
    expect(fs.readFileSync(unready.calls, "utf8")).not.toMatch(/brev exec|full-e2e\.test\.ts/u);
    expect(fs.existsSync(unready.state)).toBe(false);

    const wrongImage = fixture({
      bootImage: "projects/brevdevprod/global/images/wrong-image",
    });
    const wrongImageResult = run(wrongImage.env);
    expect(wrongImageResult.status).not.toBe(0);
    expect(wrongImageResult.stderr).toContain("booted image does not match the producer handoff");
    expect(fs.readFileSync(wrongImage.calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(fs.existsSync(wrongImage.state)).toBe(false);

    for (const boot of [
      fixture({ repoSha: "b".repeat(40) }),
      fixture({ provisionSha: "b".repeat(40) }),
      fixture({ provisionImageRepositorySha: "c".repeat(40) }),
      fixture({ repoClean: false }),
      fixture({ runtimeOverrides: true }),
      fixture({ schemaVersion: 2 }),
      fixture({ sourceRepository: "example/NemoClaw" }),
      fixture({ sourcePath: "/home/ubuntu/NemoClaw" }),
    ]) {
      const bootResult = run(boot.env);
      expect(bootResult.status).not.toBe(0);
      expect(bootResult.stderr).toContain(
        "booted image runtime does not match the producer handoff",
      );
      expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
      expect(fs.existsSync(boot.state)).toBe(false);
    }
  });

  it("reports E2E failure only after verified workspace cleanup", () => {
    const { env, state, workDir } = fixture({ e2eFails: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("preserves the booted image when the provision receipt is missing", () => {
    const { calls, env, state, workDir } = fixture({ missingProvisionReceipt: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      candidateSha,
      boot: { bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image" },
      fullE2e: "pending",
    });
  });

  it("fails the lane when workspace deletion cannot be verified", () => {
    const { env, state } = fixture({ deleteFails: true });
    const result = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "1", POLL_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still exists after deletion");
    expect(fs.existsSync(state)).toBe(true);
  });
});
