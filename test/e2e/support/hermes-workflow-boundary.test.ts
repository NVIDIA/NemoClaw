// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateHermesGpuStartupWorkflowBoundary } from "../../../tools/e2e/hermes-gpu-startup-workflow-boundary.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";

const WORKFLOW_PATH = ".github/workflows/e2e.yaml";
const DOCKER_FIXTURE_PATH = "tools/e2e/hermes-gpu-docker-runtime-fixture.sh";

function expectPathMissing(filePath: string): void {
  let statError: unknown;
  try {
    fs.statSync(filePath);
  } catch (error) {
    statError = error;
  }
  expect(statError).toMatchObject({ code: "ENOENT" });
}

function writeGnuStatShim(binDir: string): void {
  fs.writeFileSync(
    path.join(binDir, "stat"),
    `#!/usr/bin/env bash
if [ "\${1:-}" != -c ]; then exec /usr/bin/stat "$@"; fi
node - "\${2:-}" "\${3:-}" <<'NODE'
const fs = require("node:fs");
const [format, file] = process.argv.slice(2);
const stat = fs.statSync(file);
process.stdout.write(format
  .replaceAll("%a", (stat.mode & 0o7777).toString(8))
  .replaceAll("%u", String(stat.uid))
  .replaceAll("%g", String(stat.gid)) + "\\n");
NODE
`,
    { mode: 0o700 },
  );
}

function createRestoreHarness(
  originalContent: string,
  originalMode: "600" | "640",
  sudoScript: string,
  restoredRuntime: "nvidia" | "runc",
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-fixture-"));
  const stateDir = path.join(tmp, "hermes-gpu-fallback-docker-runtime.123.1.fallback.ABC123");
  const daemonJson = path.join(tmp, "daemon.json");
  const binDir = path.join(tmp, "bin");
  const { uid, gid } = os.userInfo();
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(binDir);
  fs.writeFileSync(daemonJson, '{"default-runtime":"runc"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "daemon.json.original"), originalContent, { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "daemon.json.metadata"), `${originalMode} ${uid} ${gid}\n`, {
    mode: 0o600,
  });
  for (const [name, content] of [
    ["default-runtime.original", "nvidia\n"],
    ["capture.complete", ""],
    ["default-runtime.modified", ""],
  ]) {
    fs.writeFileSync(path.join(stateDir, name), content, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(binDir, "sudo"), sudoScript, { mode: 0o700 });
  fs.writeFileSync(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = info ] && [ "\${2:-}" = --format ]; then echo ${restoredRuntime}; fi
exit 0
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(path.join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o700,
  });
  writeGnuStatShim(binDir);
  return { binDir, daemonJson, gid, stateDir, tmp, uid };
}

function runRestoreFixture(
  harness: ReturnType<typeof createRestoreHarness>,
  env: Record<string, string> = {},
) {
  return spawnSync("bash", [DOCKER_FIXTURE_PATH, "restore", harness.stateDir, harness.daemonJson], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      NEMOCLAW_E2E_FIXTURE_DAEMON_JSON: harness.daemonJson,
      NEMOCLAW_E2E_FIXTURE_STATE_ROOT: harness.tmp,
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

describe("Hermes E2E workflow boundary", () => {
  it("accepts the trusted runtime fixture provenance boundary (#6110)", () => {
    expect(validateHermesGpuStartupWorkflowBoundary()).toEqual([]);
  });

  it("rejects hosted Hermes model and hermetic GPU-startup boundary drift", () => {
    const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8"));
    workflow.jobs["hermes-e2e"].env.NEMOCLAW_MODEL = "minimaxai/minimax-m2.7";
    const gpuJob = workflow.jobs["hermes-gpu-startup"];
    gpuJob["runs-on"] = "ubuntu-latest";
    gpuJob.if = "${{ always() }}";
    gpuJob.strategy["fail-fast"] = true;
    gpuJob.strategy["max-parallel"] = 2;
    gpuJob.strategy.matrix.scenario = ["native"];
    gpuJob.env.E2E_ARTIFACT_DIR = "e2e-artifacts/shared";
    gpuJob.env.E2E_HERMES_GPU_STARTUP_SCENARIO = "native";
    gpuJob.env.E2E_DEFAULT_ENABLED = "0";
    gpuJob.env.NEMOCLAW_DOCKER_GPU_PATCH = "1";
    gpuJob.env.NEMOCLAW_E2E_USE_HOSTED_INFERENCE = "1";
    gpuJob.env.UNRELATED_SECRET = "${{ github.ref == 'refs/heads/main' && secrets.FOO || '' }}";
    const gpuRun = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Run Hermes GPU startup live Vitest test",
    );
    gpuRun.env = {
      COMPATIBLE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    };
    gpuRun.run = "npx vitest run --project e2e-live test/e2e/live/hermes-e2e.test.ts";
    const gpuRecovery = gpuJob.steps.find(
      (step: { name?: string }) =>
        step.name === "Recover Docker daemon after Hermes GPU fallback fixture",
    );
    gpuRecovery.if = "${{ success() }}";
    gpuRecovery.run = "sudo install -m 0644 daemon.json.original /etc/docker/daemon.json";
    gpuJob.steps.push(
      { name: "Prepare no-GPU native fallback fixture", run: "sudo true" },
      { name: "Restore Docker default runtime after fallback fixture", run: "sudo true" },
    );
    const gpuUpload = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Upload Hermes GPU startup artifacts",
    );
    gpuUpload.with = {
      name: "e2e-hermes-gpu-startup",
      path: "e2e-artifacts/live/hermes-gpu-startup/",
    };
    gpuJob.steps.push({
      name: "Unexpected hosted test",
      run: "npx vitest run --project e2e-live test/e2e/live/hermes-e2e.test.ts",
      with: {
        token: "${{ github.ref == 'refs/heads/main' && secrets.FOO || '' }}",
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toHaveLength(33);
      expect(errors).toEqual(
        expect.arrayContaining([
          "hermes-e2e job must use the shared hosted-compatible model default",
          "hermes-gpu-startup job must run on the native RTX PRO 6000 GPU runner",
          "hermes-gpu-startup job must remain explicit-only behind generate-matrix",
          "hermes-gpu-startup job must leave NEMOCLAW_DOCKER_GPU_PATCH unset so the scenario harness owns route selection",
          "hermes-gpu-startup job env must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup job env must not consume repository secrets",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose COMPATIBLE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_INFERENCE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not consume repository secrets",
          "hermes-gpu-startup step must run the dedicated Hermes GPU startup test",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not consume repository secrets",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects permissive backups and success-gated private-state cleanup (#6110)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-fixture-boundary-"));
    const fixturePath = path.join(tmp, "fixture.sh");
    try {
      const insecureFixture = fs
        .readFileSync(DOCKER_FIXTURE_PATH, "utf8")
        .replace(
          'install -m 0600 /dev/null "$state_dir/daemon.json.original"',
          'install -m 0644 /dev/null "$state_dir/daemon.json.original"',
        )
        .replace(
          'rm -rf -- "$state_dir"',
          'if [ "$restore_failed" -eq 0 ]; then rm -rf -- "$state_dir"; fi',
        )
        .replace(
          "expected_daemon_json=/etc/docker/daemon.json",
          "expected_daemon_json=/tmp/pr-controlled-daemon.json",
        );
      fs.writeFileSync(fixturePath, insecureFixture);

      expect(validateHermesGpuStartupWorkflowBoundary(WORKFLOW_PATH, fixturePath)).toEqual(
        expect.arrayContaining([
          "hermes-gpu-startup Docker runtime fixture must match its trusted SHA-256",
          "hermes-gpu-startup fallback Docker fixture must reject permissive 0644 file modes",
          "hermes-gpu-startup Docker runtime fixture must pin privileged state and daemon paths",
          "hermes-gpu-startup Docker runtime fixture must remove private state before reporting restore failure",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses an out-of-bound restore without removing the supplied path (#6110)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-invalid-restore-"));
    const expectedRoot = path.join(tmp, "expected-state-root");
    const victim = path.join(tmp, "outside-state-root");
    const daemonJson = path.join(tmp, "daemon.json");
    try {
      fs.mkdirSync(expectedRoot);
      fs.mkdirSync(victim);
      const result = spawnSync("bash", [DOCKER_FIXTURE_PATH, "restore", victim, daemonJson], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_E2E_FIXTURE_DAEMON_JSON: daemonJson,
          NEMOCLAW_E2E_FIXTURE_STATE_ROOT: expectedRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing Docker restore outside");
      expect(fs.statSync(victim).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects trusted fixture provenance and invocation drift (#6110)", () => {
    const workflow = YAML.parse(fs.readFileSync(WORKFLOW_PATH, "utf8"));
    const gpuJob = workflow.jobs["hermes-gpu-startup"];
    const step = (name: string) =>
      gpuJob.steps.find((candidate: { name?: string }) => candidate.name === name);
    step("Checkout trusted Hermes GPU runtime fixture").with.ref = "${{ inputs.checkout_sha }}";
    const trustedInstall = step("Install trusted Hermes GPU runtime fixture");
    const shaCheck = `printf '%s  %s\\n' "$TRUSTED_FIXTURE_SHA256" "$trusted_fixture" \\
  | /usr/bin/sudo /usr/bin/sha256sum -c -
`;
    trustedInstall.env.TRUSTED_FIXTURE_SHA256 = "0".repeat(64);
    trustedInstall.run = trustedInstall.run
      .replace(shaCheck, "")
      .replace("set -euo pipefail\n", `set -euo pipefail\n${shaCheck}`)
      .replace("-m 0500", "-m 0555");
    step("Run Hermes GPU startup live Vitest test").run =
      "bash tools/e2e/hermes-gpu-docker-runtime-fixture.sh";
    step("Recover Docker daemon after Hermes GPU fallback fixture").run =
      "done < <(bash tools/e2e/hermes-gpu-docker-runtime-fixture.sh)";
    step("Remove trusted Hermes GPU runtime fixture").if = "${{ success() }}";

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-provenance-boundary-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateHermesGpuStartupWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "hermes-gpu-startup trusted fixture setup must use immutable root-owned workflow code",
          "hermes-gpu-startup live test must use trusted runtime, fixture, and root-owned state",
          "hermes-gpu-startup independent trusted recovery must always propagate failures",
          "hermes-gpu-startup installed trusted fixture must be removed in an always step immediately after recovery",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restores daemon content, mode, UID, GID, and runtime before cleanup (#6110)", () => {
    const originalContent = '{"default-runtime":"nvidia","registry-mirrors":["private"]}\n';
    const harness = createRestoreHarness(
      originalContent,
      "640",
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_SUDO_LOG"\nexec "$@"\n',
      "nvidia",
    );
    const sudoLog = path.join(harness.tmp, "sudo.log");
    try {
      const result = runRestoreFixture(harness, { FAKE_SUDO_LOG: sudoLog });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("nvidia\n");
      expectPathMissing(harness.stateDir);
      expect(fs.readFileSync(harness.daemonJson, "utf8")).toBe(originalContent);
      const restoredStat = fs.statSync(harness.daemonJson);
      expect(restoredStat.mode & 0o777).toBe(0o640);
      expect(restoredStat.uid).toBe(harness.uid);
      expect(restoredStat.gid).toBe(harness.gid);
      expect(fs.readFileSync(sudoLog, "utf8")).toContain(
        `chown ${harness.uid}:${harness.gid} ${harness.daemonJson}`,
      );
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });

  it("removes the private snapshot when daemon restoration cannot be proven (#6110)", () => {
    const harness = createRestoreHarness(
      '{"default-runtime":"nvidia"}\n',
      "600",
      '#!/usr/bin/env bash\nif [ "${1:-}" = install ]; then exit 42; fi\nexec "$@"\n',
      "runc",
    );
    try {
      const result = runRestoreFixture(harness);

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Failed to prove restoration of the Docker daemon");
      expectPathMissing(harness.stateDir);
    } finally {
      fs.rmSync(harness.tmp, { recursive: true, force: true });
    }
  });
});
