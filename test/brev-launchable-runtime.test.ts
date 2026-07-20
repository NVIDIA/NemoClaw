// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-runtime.sh");
const candidateSha = "a".repeat(40);
const roots: string[] = [];

type FixtureOptions = {
  bootImageId?: string;
  deleteMode?: "remove" | "retain";
  e2eStatus?: "failed" | "passed";
  imageLabelSha?: string;
  provisionSha?: string;
  repoSha?: string;
  workspaceMode?: "pending" | "ready";
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function executable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-runtime-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const home = path.join(root, "home");
  const state = path.join(root, "state.json");
  const log = path.join(root, "brev.log");
  const e2eExecuted = path.join(root, "e2e-executed");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);
  fs.mkdirSync(path.join(home, "NemoClaw", ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, "NemoClaw", "node_modules", ".bin"), { recursive: true });

  executable(
    path.join(home, "NemoClaw", "node_modules", ".bin", "vitest"),
    `#!/usr/bin/env bash
set -euo pipefail
: > "$FAKE_E2E_EXECUTED"
result="$E2E_ARTIFACT_DIR/brev-launchable-cloud-openclaw-onboard-inference-cli-operations-and-cleanup/target-result.json"
mkdir -p "$(dirname "$result")"
jq -n --arg status "$FAKE_E2E_STATUS" '{
  firstAgentTurn:{commandMs:125,responseChars:24,status:$status},
  id:"brev-launchable-cloud-openclaw",
  runner:"vitest",
  securityPosture:{configureGuard:true,hostNonRoot:true,rcFilesLocked:true,runtimeProxyEnvLocked:true,startupLogClean:true},
  status:$status
}' > "$result"
[ "$FAKE_E2E_STATUS" = passed ]
`,
  );
  executable(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
  executable(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_BREV_LOG"
case "$1" in
  ls)
    if [ -f "$FAKE_BREV_STATE" ]; then cat "$FAKE_BREV_STATE"; else printf '{"workspaces":[]}\n'; fi
    ;;
  create)
    if [ "$FAKE_BREV_WORKSPACE_MODE" = pending ]; then
      printf '{"workspaces":[{"name":"%s","status":"PROVISIONING","shell_status":"PENDING","health_status":"PENDING","build_status":"PENDING"}]}\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    else
      printf '{"workspaces":[{"name":"%s","status":"RUNNING","shell_status":"READY","health_status":"HEALTHY","build_status":"COMPLETED"}]}\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    fi
    ;;
  exec) shift 3; bash -c "$*" ;;
  copy)
    source_path="\${2#*:}"
    cp -R "$source_path"/. "$3"/
    ;;
  delete) [ "$FAKE_BREV_DELETE_MODE" = retain ] || rm -f "$FAKE_BREV_STATE" ;;
  refresh) ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "sudo"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" != -n ] || shift
if [ "\${1:-}" = cat ] && [ "\${2:-}" = /etc/nemoclaw/provision.json ]; then
  jq -cn --arg sha "$FAKE_PROVISION_SHA" '{gitSha:$sha}'
  exit 0
fi
exec "$@"
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'diff --quiet --no-ext-diff HEAD --'*) exit 0 ;;
  *'diff --cached --quiet --no-ext-diff HEAD --'*) exit 0 ;;
  *'rev-parse HEAD'*) printf '%s\n' "$FAKE_REPO_SHA" ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
for value in "$@"; do
  case "$value" in
    */project/project-id) printf 'brevdevprod\n'; exit 0 ;;
    */instance/zone) printf 'projects/1/zones/us-central1-a\n'; exit 0 ;;
    */instance/disks/0/device-name) printf 'disk-1\n'; exit 0 ;;
    */instance/service-accounts/default/token) printf '{"access_token":"token"}\n'; exit 0 ;;
    https://compute.googleapis.com/*/disks/*)
      jq -cn --arg id "$FAKE_BOOT_IMAGE_ID" '{sourceImage:"https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a",sourceImageId:$id}'
      exit 0
      ;;
    https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a)
      jq -cn --arg sha "$FAKE_IMAGE_LABEL_SHA" '{name:"image-a",id:"123456789",selfLink:"https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a",status:"READY",labels:{"nemoclaw-sha":$sha,channel:"staging",variant:"cpu"}}'
      exit 0
      ;;
  esac
done
exit 2
`,
  );
  for (const [name, body] of [
    ["node", "printf '%s\\n' 'nvidia/test-model'"],
    ["brev-quickstart", "exit 0"],
    ["nemoclaw", "exit 0"],
    ["openshell", "exit 0"],
    ["docker", "exit 0"],
    ["openclaw", "exit 0"],
  ] as const) {
    executable(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_LAUNCHABLE_ID: "env-staging123",
    CANDIDATE_SHA: candidateSha,
    FAKE_BOOT_IMAGE_ID: options.bootImageId ?? "123456789",
    FAKE_BREV_DELETE_MODE: options.deleteMode ?? "remove",
    FAKE_BREV_LOG: log,
    FAKE_BREV_STATE: state,
    FAKE_BREV_WORKSPACE_MODE: options.workspaceMode ?? "ready",
    FAKE_E2E_EXECUTED: e2eExecuted,
    FAKE_E2E_STATUS: options.e2eStatus ?? "passed",
    FAKE_IMAGE_LABEL_SHA: options.imageLabelSha ?? candidateSha,
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha.slice(0, 7),
    FAKE_REPO_SHA: options.repoSha ?? candidateSha,
    HOME: home,
    INSTANCE_NAME: "nclaw-e2e-test-1",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test-value",
    WORK_DIR: workDir,
    BREV_POLL_SECONDS: "0",
  };
  return { e2eExecuted, env, log, workDir };
}

function run(mode: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT, mode], { cwd: REPO_ROOT, encoding: "utf8", env });
}

describe("Brev Launchable E2E runtime", () => {
  it("deploys the configured Launchable, verifies the exact image, runs full E2E, and cleans up", () => {
    const { env, log, workDir } = fixture();
    expect(run("deploy", env).status).toBe(0);
    const e2e = run("run", env);
    expect(e2e.status, [e2e.stderr, e2e.stdout].join("\n")).toBe(0);
    expect(run("cleanup", env).status).toBe(0);

    const commands = fs.readFileSync(log, "utf8");
    expect(commands).toContain(
      "create nclaw-e2e-test-1 --launchable env-staging123 --detached --timeout 900",
    );
    expect(commands).toContain("test/e2e/live/full-e2e.test.ts");
    expect(commands).toContain("NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable");
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "brev-cleanup-evidence.json"), "utf8")),
    ).toMatchObject({ terminalState: "ABSENT" });
  });

  it("rejects a baked checkout for a different candidate before E2E", () => {
    const { e2eExecuted, env } = fixture({ repoSha: "b".repeat(40) });
    const result = run("run", env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match candidate");
    expect(fs.existsSync(e2eExecuted)).toBe(false);
  });

  it.each([
    ["image ID", { bootImageId: "987654321" }],
    ["candidate label", { imageLabelSha: "b".repeat(40) }],
  ] as const)("rejects a mismatched boot %s before E2E", (_name, options) => {
    const { e2eExecuted, env } = fixture(options);
    const result = run("run", env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("boot image does not match");
    expect(fs.existsSync(e2eExecuted)).toBe(false);
  });

  it("reports a failing full E2E result", () => {
    const { env } = fixture({ e2eStatus: "failed" });
    const result = run("run", env);
    expect(result.status).not.toBe(0);
  });

  it("times out when the workspace never becomes ready", () => {
    const { env } = fixture({ workspaceMode: "pending" });
    const result = run("deploy", {
      ...env,
      BREV_POLL_SECONDS: "1",
      BREV_READY_TIMEOUT_SECONDS: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not become ready");
  });

  it("fails cleanup while the workspace still exists", () => {
    const { env } = fixture({ deleteMode: "retain" });
    expect(run("deploy", env).status).toBe(0);
    const result = run("cleanup", {
      ...env,
      BREV_DELETE_TIMEOUT_SECONDS: "1",
      BREV_POLL_SECONDS: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still exists");
  });
});
