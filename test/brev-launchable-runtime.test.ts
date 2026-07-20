// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-runtime.sh");
const roots: string[] = [];
const candidateSha = "a".repeat(40);

type FixtureOptions = {
  bootImageId?: string;
  bootImageSelfLink?: string;
  deleteMode?: "remove" | "retain";
  evidenceMode?:
    | "duplicate"
    | "failed-turn"
    | "fifo"
    | "malformed"
    | "oversized"
    | "symlink"
    | "valid"
    | "wrong-path";
  lsMode?: "ok" | "fail" | "fail-once" | "malformed";
  model?: string;
  provisionSha?: string;
  repoSha?: string;
  supportsLaunchableMode?: boolean;
  trackedDrift?: "index" | "none" | "worktree";
  workspaceMode?: "ready" | "pending";
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeExecutable(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function fixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-runtime-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const home = path.join(root, "home");
  const state = path.join(root, "state.json");
  const lsCount = path.join(root, "ls-count");
  const log = path.join(root, "brev.log");
  const e2eExecuted = path.join(root, "e2e-executed");
  const manifest = path.join(workDir, "validated-manifest.v1.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);
  fs.mkdirSync(path.join(home, "NemoClaw", ".git"), { recursive: true });
  fs.mkdirSync(path.join(home, "NemoClaw", "test", "e2e", "live"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "NemoClaw", "test", "e2e", "live", "full-e2e.test.ts"),
    options.supportsLaunchableMode === false
      ? "// legacy full E2E fixture\n"
      : 'const mode = process.env.NEMOCLAW_E2E_SETUP_MODE; const target = "brev-launchable-cloud-openclaw";\n',
  );
  fs.mkdirSync(path.join(home, "NemoClaw", "node_modules", ".bin"), { recursive: true });
  writeExecutable(
    path.join(home, "NemoClaw", "node_modules", ".bin", "vitest"),
    `#!/usr/bin/env bash
set -euo pipefail
artifact_dir="$E2E_ARTIFACT_DIR/brev-launchable-cloud-openclaw-onboard-inference-cli-operations-and-cleanup"
: > "$FAKE_E2E_EXECUTED"
write_result() {
  mkdir -p "$(dirname "$1")"
  jq -n '{
    firstAgentTurn:{commandMs:125,responseChars:24,status:"passed"},
    id:"brev-launchable-cloud-openclaw",
    runner:"vitest",
    securityPosture:{
      configureGuard:true,
      entrypoint:{capBnd:"0",capEff:"0",dangerousBoundingCapabilities:[],dangerousEffectiveCapabilities:[],noNewPrivs:"1",uid:"1000"},
      hostNonRoot:true,
      rcFilesLocked:true,
      runtimeProxyEnvLocked:true,
      startupLogClean:true
    },
    status:"passed"
  }' > "$1"
}
case "$FAKE_EVIDENCE_MODE" in
  valid) write_result "$artifact_dir/target-result.json" ;;
  duplicate)
    write_result "$artifact_dir/target-result.json"
    write_result "$E2E_ARTIFACT_DIR/duplicate/target-result.json"
    ;;
  malformed)
    mkdir -p "$artifact_dir"
    jq -n '{id:"brev-launchable-cloud-openclaw",runner:"vitest",status:"passed"}' > "$artifact_dir/target-result.json"
    ;;
  failed-turn)
    write_result "$artifact_dir/target-result.json"
    jq '.firstAgentTurn.status = "failed"' "$artifact_dir/target-result.json" > "$artifact_dir/result.tmp"
    mv "$artifact_dir/result.tmp" "$artifact_dir/target-result.json"
    ;;
  fifo) write_result "$artifact_dir/target-result.json" ;;
  oversized)
    write_result "$artifact_dir/target-result.json"
    dd if=/dev/null of="$artifact_dir/oversized.bin" bs=1 seek=104857601 2>/dev/null
    ;;
  symlink)
    mkdir -p "$artifact_dir"
    write_result "$artifact_dir/real-result.json"
    ln -s real-result.json "$artifact_dir/target-result.json"
    ;;
  wrong-path) write_result "$E2E_ARTIFACT_DIR/wrong/target-result.json" ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(path.join(bin, "timeout"), '#!/usr/bin/env bash\nshift\nexec "$@"\n');
  writeExecutable(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_BREV_LOG"
case "$1" in
  ls)
    [ "$FAKE_BREV_LS_MODE" != fail ] || exit 9
    if [ "$FAKE_BREV_LS_MODE" = fail-once ] && [ ! -f "$FAKE_BREV_LS_COUNT" ]; then
      : >"$FAKE_BREV_LS_COUNT"
      exit 9
    fi
    if [ "$FAKE_BREV_LS_MODE" = malformed ]; then printf '{}\\n'; exit 0; fi
    if [ -f "$FAKE_BREV_STATE" ]; then cat "$FAKE_BREV_STATE"; else printf '{"workspaces":[]}\\n'; fi
    ;;
  create)
    if [ "$FAKE_BREV_WORKSPACE_MODE" = pending ]; then
      printf '{"workspaces":[{"id":"ws-1","name":"%s","status":"PROVISIONING","shell_status":"PENDING","health_status":"PENDING","build_status":"PENDING"}]}\\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    else
      printf '{"workspaces":[{"id":"ws-1","name":"%s","status":"RUNNING","shell_status":"READY","health_status":"HEALTHY","build_status":"COMPLETED"}]}\\n' "$INSTANCE_NAME" > "$FAKE_BREV_STATE"
    fi
    ;;
  exec)
    shift 3
    bash -c "$*"
    ;;
  copy)
    source_path="\${2#*:}"
    destination="$3"
    cp -R "$source_path"/. "$destination"/
    [ "$FAKE_EVIDENCE_MODE" != fifo ] || mkfifo "$destination/untrusted.fifo"
    ;;
  delete) [ "$FAKE_BREV_DELETE_MODE" = retain ] || rm -f "$FAKE_BREV_STATE" ;;
  refresh) ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "sudo"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" != -n ] || shift
if [ "\${1:-}" = cat ] && [ "\${2:-}" = /etc/nemoclaw/provision.json ]; then
  jq -cn --arg sha "$FAKE_PROVISION_SHA" '{gitSha:$sha,version:"0.0.0"}'
  exit 0
fi
exec "$@"
`,
  );
  writeExecutable(
    path.join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'diff --cached --quiet --no-ext-diff HEAD --'*) [ "$FAKE_TRACKED_DRIFT" != index ] ;;
  *'diff --quiet --no-ext-diff HEAD --'*) [ "$FAKE_TRACKED_DRIFT" != worktree ] ;;
  *'rev-parse HEAD'*) printf '%s\\n' "$FAKE_REPO_SHA" ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
for value in "$@"; do
  case "$value" in
    */project/project-id) printf 'brevdevprod\\n'; exit 0 ;;
    */instance/zone) printf 'projects/1/zones/us-central1-a\\n'; exit 0 ;;
    */instance/disks/0/device-name) printf 'disk-1\\n'; exit 0 ;;
    */instance/service-accounts/default/token) printf '{"access_token":"token"}\\n'; exit 0 ;;
    https://compute.googleapis.com/*)
      jq -cn --arg sourceImage "$FAKE_BOOT_IMAGE_SELF_LINK" --arg sourceImageId "$FAKE_BOOT_IMAGE_ID" '{sourceImage:$sourceImage,sourceImageId:$sourceImageId}'
      exit 0
      ;;
    https://inference.local/*) printf '{"choices":[{"message":{"content":"PONG"}}]}\\n'; exit 0 ;;
  esac
done
exit 2
`,
  );
  writeExecutable(
    path.join(bin, "openshell"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --version ]; then printf 'openshell 1.0\\n'; exit 0; fi
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
[ "\${1:-}" = -- ] && shift
exec "$@"
`,
  );
  for (const [name, body] of [
    ["brev-quickstart", "printf 'Ready!\\n'"],
    ["docker", "exit 0"],
    ["nemoclaw", "exit 0"],
    ["node", "printf '%s\\n' \"$FAKE_MODEL\""],
    ["openclaw", 'printf \'{"payloads":[{"text":"42"}]}\\n\''],
  ] as const) {
    writeExecutable(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  }
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      imageName: "image-a",
      imageId: "123456789",
      imageSelfLink:
        "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a",
    })}\n`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_LAUNCHABLE_ID: "env-staging123",
    CANDIDATE_SHA: candidateSha,
    FAKE_BOOT_IMAGE_ID: options.bootImageId ?? "123456789",
    FAKE_BOOT_IMAGE_SELF_LINK:
      options.bootImageSelfLink ??
      "https://www.googleapis.com/compute/v1/projects/brevdevprod/global/images/image-a",
    FAKE_BREV_DELETE_MODE: options.deleteMode ?? "remove",
    FAKE_BREV_LS_MODE: options.lsMode ?? "ok",
    FAKE_BREV_LOG: log,
    FAKE_BREV_LS_COUNT: lsCount,
    FAKE_BREV_STATE: state,
    FAKE_E2E_EXECUTED: e2eExecuted,
    FAKE_EVIDENCE_MODE: options.evidenceMode ?? "valid",
    FAKE_MODEL: options.model ?? "nvidia/test-model",
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha.slice(0, 7),
    FAKE_REPO_SHA: options.repoSha ?? candidateSha,
    FAKE_TRACKED_DRIFT: options.trackedDrift ?? "none",
    FAKE_BREV_WORKSPACE_MODE: options.workspaceMode ?? "ready",
    HOME: home,
    INSTANCE_NAME: "nclaw-e2e-test-1",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test-value",
    VALIDATED_MANIFEST: manifest,
    WORK_DIR: workDir,
    BREV_POLL_SECONDS: "0",
  };
  return { e2eExecuted, env, log, workDir };
}

function run(mode: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT, mode], { cwd: REPO_ROOT, encoding: "utf8", env });
}

describe("exact staging Brev Launchable runtime", () => {
  it("deploys only the configured Launchable, proves identity, runs the existing E2E, and deletes", () => {
    const { env, log, workDir } = fixture();
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(
      qualification.status,
      [qualification.stderr, qualification.stdout, fs.readFileSync(log, "utf8")].join("\n"),
    ).toBe(0);
    expect(run("cleanup", env).status).toBe(0);

    const commands = fs.readFileSync(log, "utf8");
    expect(commands).toContain(
      "create nclaw-e2e-test-1 --launchable env-staging123 --detached --timeout 900",
    );
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(commands).toContain("test/e2e/live/full-e2e.test.ts");
    expect(commands).toContain("NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable");
    expect(commands).toContain("NEMOCLAW_E2E_SECURITY_POSTURE=1");
    expect(commands).toContain("E2E_TARGET_ID=brev-launchable-cloud-openclaw");
    expect(commands.indexOf("rev-parse HEAD")).toBeLessThan(
      commands.indexOf("test/e2e/live/full-e2e.test.ts"),
    );
    expect(fs.existsSync(path.join(workDir, "brev-identity-evidence.json"))).toBe(true);
    expect(fs.existsSync(path.join(workDir, "brev-launchable-e2e-evidence.json"))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "brev-launchable-e2e-evidence.json"), "utf8")),
    ).toMatchObject({
      artifacts: {
        fileCount: expect.any(Number),
        targetResultPath:
          "brev-launchable-cloud-openclaw-onboard-inference-cli-operations-and-cleanup/target-result.json",
        targetResultSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        totalBytes: expect.any(Number),
      },
      setupMode: "preinstalled-launchable",
    });
    expect(
      fs.existsSync(
        path.join(
          workDir,
          "brev-launchable-cloud-openclaw",
          "brev-launchable-cloud-openclaw-onboard-inference-cli-operations-and-cleanup",
          "target-result.json",
        ),
      ),
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "brev-cleanup-evidence.json"), "utf8")),
    ).toMatchObject({ terminalState: "ABSENT", workspaceName: "nclaw-e2e-test-1" });
  });

  it("fails closed on a baked SHA mismatch before onboarding", () => {
    const { env, log } = fixture({ repoSha: "b".repeat(40) });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(
      [qualification.stderr, qualification.stdout, fs.readFileSync(log, "utf8")].join("\n"),
    ).toContain("does not match candidate");
    expect(fs.readFileSync(log, "utf8")).not.toContain("test/e2e/live/full-e2e.test.ts");
    expect(run("cleanup", env).status).toBe(0);
  });

  it.each([
    "index",
    "worktree",
  ] as const)("fails closed on tracked %s drift before executing the E2E harness", (trackedDrift) => {
    const { e2eExecuted, env } = fixture({ trackedDrift });
    const qualification = run("qualify", env);

    expect(qualification.status).not.toBe(0);
    expect([qualification.stderr, qualification.stdout].join("\n")).toContain(
      trackedDrift === "index" ? "staged changes" : "tracked worktree changes",
    );
    expect(fs.existsSync(e2eExecuted)).toBe(false);
  });

  it("fails closed on a boot-image mismatch before onboarding", () => {
    const { env, log } = fixture({ bootImageId: "987654321" });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(qualification.stderr).toContain("workspace boot disk does not match accepted image");
    expect(fs.readFileSync(log, "utf8")).not.toContain("test/e2e/live/full-e2e.test.ts");
    expect(run("cleanup", env).status).toBe(0);
  });

  it("fails rather than reinstalling when the candidate full E2E lacks Launchable mode", () => {
    const { env, workDir } = fixture({ supportsLaunchableMode: false });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(fs.readFileSync(path.join(workDir, "brev-launchable-e2e.log"), "utf8")).toContain(
      "does not support preinstalled Launchable setup",
    );
    expect(fs.existsSync(path.join(workDir, "brev-launchable-e2e-evidence.json"))).toBe(false);
    expect(run("cleanup", env).status).toBe(0);
  });

  it("rejects an unsafe image-derived model before executing the E2E harness", () => {
    const { e2eExecuted, env, workDir } = fixture();
    const injectionMarker = `${e2eExecuted}-model-injection`;
    env.FAKE_MODEL = `nvidia/model'; touch ${injectionMarker}; #`;
    const qualification = run("qualify", env);

    expect(qualification.status).not.toBe(0);
    expect(fs.readFileSync(path.join(workDir, "brev-launchable-e2e.log"), "utf8")).toContain(
      "Launchable cloud model is not a safe model ID",
    );
    expect(fs.existsSync(e2eExecuted)).toBe(false);
    expect(fs.existsSync(injectionMarker)).toBe(false);
  });

  it.each([
    "duplicate",
    "failed-turn",
    "fifo",
    "malformed",
    "oversized",
    "symlink",
    "wrong-path",
  ] as const)("rejects %s copied E2E evidence", (evidenceMode) => {
    const { e2eExecuted, env, workDir } = fixture({ evidenceMode });
    const qualification = run("qualify", env);

    expect(qualification.status).not.toBe(0);
    expect(fs.existsSync(e2eExecuted)).toBe(true);
    expect(fs.existsSync(path.join(workDir, "brev-launchable-e2e-evidence.json"))).toBe(false);
  });

  it("fails when workspace readiness does not reach its deadline", () => {
    const { env } = fixture({ workspaceMode: "pending" });
    const deploy = run("deploy", {
      ...env,
      BREV_POLL_SECONDS: "1",
      BREV_READY_TIMEOUT_SECONDS: "1",
    });

    expect(deploy.status).not.toBe(0);
    expect(deploy.stderr).toContain(
      "Brev workspace did not become structurally ready before the deadline",
    );
    expect(run("cleanup", env).status).toBe(0);
  });

  it.each(["fail", "malformed"] as const)("fails closed when Brev inventory is %s", (lsMode) => {
    const { env, log } = fixture({ lsMode });
    const deploy = run("deploy", env);
    expect(deploy.status).not.toBe(0);
    expect(deploy.stderr).toContain("unable to inventory Brev workspaces before deploy");
    expect(fs.readFileSync(log, "utf8")).not.toContain("create ");
  });

  it("retries cleanup when the initial Brev inventory request fails", () => {
    const { env, workDir } = fixture({ lsMode: "fail-once" });
    const cleanup = run("cleanup", env);

    expect(cleanup.status, [cleanup.stderr, cleanup.stdout].join("\n")).toBe(0);
    expect(cleanup.stderr).toContain("brev ls failed before cleanup");
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "brev-cleanup-evidence.json"), "utf8")),
    ).toMatchObject({ terminalState: "ABSENT", workspaceName: "nclaw-e2e-test-1" });
  });

  it("fails cleanup when the workspace remains after the deletion deadline", () => {
    const { env } = fixture({ deleteMode: "retain" });
    expect(run("deploy", env).status).toBe(0);
    const cleanup = run("cleanup", {
      ...env,
      BREV_DELETE_TIMEOUT_SECONDS: "1",
      BREV_POLL_SECONDS: "1",
    });

    expect(cleanup.status).not.toBe(0);
    expect(cleanup.stderr).toContain("Brev workspace still exists after cleanup deadline");
  });

  it("rejects an empty provision SHA before onboarding", () => {
    const { env, log } = fixture({ provisionSha: "" });
    expect(run("deploy", env).status).toBe(0);
    const qualification = run("qualify", env);
    expect(qualification.status).not.toBe(0);
    expect(qualification.stderr).toContain("provision metadata SHA must be a lowercase Git SHA");
    expect(fs.readFileSync(log, "utf8")).not.toContain("test/e2e/live/full-e2e.test.ts");
    expect(run("cleanup", env).status).toBe(0);
  });
});
