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
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "hermes-e2e job must use the shared hosted-compatible model default",
          "hermes-gpu-startup job must run on the native RTX PRO 6000 GPU runner",
          "hermes-gpu-startup job must remain explicit-only behind generate-matrix",
          "hermes-gpu-startup strategy must keep fail-fast disabled",
          "hermes-gpu-startup strategy must serialize GPU scenarios",
          "hermes-gpu-startup matrix must run exactly the native, fallback, and compatibility-only scenarios",
          "hermes-gpu-startup job must set E2E_ARTIFACT_DIR=${{ github.workspace }}/e2e-artifacts/live/hermes-gpu-startup/${{ matrix.scenario }}",
          "hermes-gpu-startup job must set E2E_HERMES_GPU_STARTUP_SCENARIO=${{ matrix.scenario }}",
          "hermes-gpu-startup job must not set E2E_DEFAULT_ENABLED; the trusted inventory owns its explicit-only classification",
          "hermes-gpu-startup job must leave NEMOCLAW_DOCKER_GPU_PATCH unset so the scenario harness owns route selection",
          "hermes-gpu-startup job env must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup job env must not consume repository secrets",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose COMPATIBLE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not expose NVIDIA_INFERENCE_API_KEY",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not consume repository secrets",
          "hermes-gpu-startup fallback Docker mutation, Vitest, and restore must share one step",
          "hermes-gpu-startup fallback Docker mutation must remain under same-step cleanup traps",
          "hermes-gpu-startup fallback Docker fixture must retain its source-boundary rationale",
          "hermes-gpu-startup independent Docker recovery step must always run",
          "hermes-gpu-startup independent Docker recovery step must discover and restore cancelled fallback state",
          "hermes-gpu-startup fallback Docker fixture must reject permissive 0644 file modes",
          "hermes-gpu-startup step must run the dedicated Hermes GPU startup test",
          "hermes-gpu-startup step 'Run Hermes GPU startup live Vitest test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not run the hosted Hermes E2E test",
          "hermes-gpu-startup step 'Unexpected hosted test' must not consume repository secrets",
          "hermes-gpu-startup upload must use a scenario-specific artifact name",
          "hermes-gpu-startup upload must use the scenario-specific artifact path",
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
    const trustedCheckout = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Checkout trusted Hermes GPU runtime fixture",
    );
    trustedCheckout.with.ref = "${{ inputs.checkout_sha }}";
    trustedCheckout.with.path = ".trusted-hermes-gpu-fixture";
    trustedCheckout.with["sparse-checkout"] = "tools/e2e";
    trustedCheckout.with["sparse-checkout-cone-mode"] = true;

    const trustedInstall = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Install trusted Hermes GPU runtime fixture",
    );
    trustedInstall.run = trustedInstall.run.replace("-m 0500", "-m 0555");
    trustedInstall.env.BASH_ENV = "$GITHUB_WORKSPACE/pr-controlled.bash";
    const reassertNode = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Reassert trusted Node runtime",
    );
    reassertNode.with["node-version"] = "20";

    const gpuRun = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Run Hermes GPU startup live Vitest test",
    );
    gpuRun.shell = "bash";
    gpuRun.run = gpuRun.run.replaceAll(
      "run_trusted_fixture",
      "bash tools/e2e/hermes-gpu-docker-runtime-fixture.sh",
    );
    gpuRun.run = gpuRun.run.replace(
      "trusted_state_root=/var/lib/nemoclaw-e2e",
      'trusted_state_root="$RUNNER_TEMP"',
    );

    const gpuRecovery = gpuJob.steps.find(
      (step: { name?: string }) =>
        step.name === "Recover Docker daemon after Hermes GPU fallback fixture",
    );
    gpuRecovery.env.BASH_ENV = "$GITHUB_WORKSPACE/pr-controlled.bash";
    gpuRecovery.run = gpuRecovery.run
      .replaceAll("run_trusted_fixture", "bash tools/e2e/hermes-gpu-docker-runtime-fixture.sh")
      .replace(
        'if ! /usr/bin/sudo /usr/bin/find "$trusted_state_root"',
        'while true; do break; done < <(/usr/bin/sudo /usr/bin/find "$trusted_state_root"',
      );

    const gpuCleanup = gpuJob.steps.find(
      (step: { name?: string }) => step.name === "Remove trusted Hermes GPU runtime fixture",
    );
    gpuCleanup.if = "${{ success() }}";
    gpuCleanup.env.E2E_HERMES_GPU_STARTUP_SCENARIO = "native";

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-provenance-boundary-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    try {
      fs.writeFileSync(workflowPath, YAML.stringify(workflow));
      expect(validateHermesGpuStartupWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "hermes-gpu-startup trusted fixture checkout must use credential-free NVIDIA/NemoClaw workflow_sha provenance",
          "hermes-gpu-startup trusted fixture checkout must use its run-specific exact-file sparse path",
          "hermes-gpu-startup trusted fixture install must prove workflow_sha provenance and install root:root mode 0500",
          "hermes-gpu-startup must reassert pinned Node after PR build code and before its live test",
          "hermes-gpu-startup live test must reassert its trusted shell environment",
          "hermes-gpu-startup live test must invoke only the installed trusted fixture via sudo",
          "hermes-gpu-startup fallback snapshot state must remain private and root-owned",
          "hermes-gpu-startup live test must not invoke the PR-workspace Docker fixture source",
          "hermes-gpu-startup independent Docker recovery step must discover and restore cancelled fallback state",
          "hermes-gpu-startup recovery must not invoke the PR-workspace Docker fixture source",
          "hermes-gpu-startup recovery must reassert scenario and clear shell startup state",
          "hermes-gpu-startup recovery must propagate trusted state discovery failures",
          "hermes-gpu-startup installed trusted fixture must be removed in an always step immediately after recovery",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restores daemon content, mode, UID, GID, and runtime before cleanup (#6110)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-fixture-success-"));
    const stateDir = path.join(tmp, "hermes-gpu-fallback-docker-runtime.123.1.fallback.ABC123");
    const daemonJson = path.join(tmp, "daemon.json");
    const binDir = path.join(tmp, "bin");
    const sudoLog = path.join(tmp, "sudo.log");
    const originalContent = '{"default-runtime":"nvidia","registry-mirrors":["private"]}\n';
    const user = os.userInfo();
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.mkdirSync(binDir);
      fs.writeFileSync(daemonJson, '{"default-runtime":"runc"}\n', { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "daemon.json.original"), originalContent, {
        mode: 0o600,
      });
      fs.writeFileSync(
        path.join(stateDir, "daemon.json.metadata"),
        `640 ${user.uid} ${user.gid}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(stateDir, "default-runtime.original"), "nvidia\n", {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(stateDir, "capture.complete"), "", { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "default-runtime.modified"), "", { mode: 0o600 });
      fs.writeFileSync(
        path.join(binDir, "sudo"),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_SUDO_LOG"\nexec "$@"\n',
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(binDir, "docker"),
        '#!/usr/bin/env bash\nif [ "${1:-}" = info ] && [ "${2:-}" = --format ]; then echo nvidia; fi\nexit 0\n',
        { mode: 0o700 },
      );
      fs.writeFileSync(path.join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o700,
      });
      writeGnuStatShim(binDir);

      const result = spawnSync("bash", [DOCKER_FIXTURE_PATH, "restore", stateDir, daemonJson], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_SUDO_LOG: sudoLog,
          NEMOCLAW_E2E_FIXTURE_DAEMON_JSON: daemonJson,
          NEMOCLAW_E2E_FIXTURE_STATE_ROOT: tmp,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("nvidia\n");
      expectPathMissing(stateDir);
      expect(fs.readFileSync(daemonJson, "utf8")).toBe(originalContent);
      const restoredStat = fs.statSync(daemonJson);
      expect(restoredStat.mode & 0o777).toBe(0o640);
      expect(restoredStat.uid).toBe(user.uid);
      expect(restoredStat.gid).toBe(user.gid);
      expect(fs.readFileSync(sudoLog, "utf8")).toContain(
        `chown ${user.uid}:${user.gid} ${daemonJson}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes the private snapshot when daemon restoration cannot be proven (#6110)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-fixture-failure-"));
    const stateDir = path.join(tmp, "hermes-gpu-fallback-docker-runtime.123.1.fallback.ABC123");
    const daemonJson = path.join(tmp, "daemon.json");
    const binDir = path.join(tmp, "bin");
    const user = os.userInfo();
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.mkdirSync(binDir);
      fs.writeFileSync(daemonJson, '{"default-runtime":"runc"}\n', { mode: 0o600 });
      fs.writeFileSync(
        path.join(stateDir, "daemon.json.original"),
        '{"default-runtime":"nvidia"}\n',
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(stateDir, "daemon.json.metadata"),
        `600 ${user.uid} ${user.gid}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(stateDir, "default-runtime.original"), "nvidia\n", {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(stateDir, "capture.complete"), "", { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "default-runtime.modified"), "", { mode: 0o600 });
      fs.writeFileSync(
        path.join(binDir, "sudo"),
        '#!/usr/bin/env bash\nif [ "${1:-}" = install ]; then exit 42; fi\nexec "$@"\n',
        { mode: 0o700 },
      );
      fs.writeFileSync(
        path.join(binDir, "docker"),
        '#!/usr/bin/env bash\nif [ "${1:-}" = info ] && [ "${2:-}" = --format ]; then echo runc; fi\nexit 0\n',
        { mode: 0o700 },
      );
      fs.writeFileSync(path.join(binDir, "systemctl"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o700,
      });
      writeGnuStatShim(binDir);

      const result = spawnSync("bash", [DOCKER_FIXTURE_PATH, "restore", stateDir, daemonJson], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NEMOCLAW_E2E_FIXTURE_DAEMON_JSON: daemonJson,
          NEMOCLAW_E2E_FIXTURE_STATE_ROOT: tmp,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain("Failed to prove restoration of the Docker daemon");
      expectPathMissing(stateDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
