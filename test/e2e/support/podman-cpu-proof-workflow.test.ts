// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type PodmanProofWorkflow = Workflow & {
  on: { pull_request: { paths: string[]; types: string[] } };
  permissions: Record<string, string>;
};

function workflow(): PodmanProofWorkflow {
  return readYaml(".github/workflows/podman-cpu-proof.yaml") as PodmanProofWorkflow;
}

function proofJob(): WorkflowJob {
  const job = workflow().jobs["podman-cpu-lifecycle"];
  expect(job).toBeDefined();
  return job!;
}

function delegationJob(): WorkflowJob {
  const job = workflow().jobs["portable-cpu-delegation"];
  expect(job).toBeDefined();
  return job!;
}

function namedStep(name: string): WorkflowStep {
  const step = proofJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing Podman CPU proof step '${name}'`).toBeDefined();
  return step!;
}

function namedDelegationStep(name: string): WorkflowStep {
  const step = delegationJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing CPU delegation proof step '${name}'`).toBeDefined();
  return step!;
}

describe("native Podman CPU proof workflow", () => {
  // source-shape-contract: security -- Checkout binding and package pins bind the credential-free Podman proof to the commit under review and its runtime bytes
  it("runs as a credential-free PR workflow bound to the commit under review", () => {
    const parsed = workflow();
    const job = proofJob();

    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.on.pull_request.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(parsed.on.pull_request.paths).toContain("src/lib/adapters/podman/**");
    expect(parsed.on.pull_request.paths).toContain("src/lib/onboard/docker-driver-gateway-*.ts");
    expect(parsed.on.pull_request.paths).toContain("src/lib/onboard/managed-bootstrap/podman-*.ts");
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/experimental/portable-demo-lifecycle.ts",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/runtime-provider/container-state-mutation.ts",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/runtime-provider/docker-state-mutation.ts",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/experimental/portable-cpu-delegation-preflight*.ts",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/experimental/portable-host-preparation*.ts",
    );
    expect(parsed.on.pull_request.paths).toContain("scripts/install-openshell.sh");
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
    );
    expect(parsed.on.pull_request.paths).toContain("test/e2e/live/podman-cpu-lifecycle-helpers.ts");
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/live/podman-cpu-lifecycle-policy.yaml",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/registry/native-runtime-qualification.ts",
    );
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/live/portable-cpu-delegation-proof.test.ts",
    );
    expect(job.name).toBe("Rootless Podman CPU lifecycle with Docker disabled");
    expect(job["runs-on"]).toBe("ubuntu-26.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(job.env?.E2E_SOURCE_REVISION).toBe("${{ github.event.pull_request.head.sha }}");
    expect(job.env?.NEMOCLAW_OPENSHELL_PIN_VERSION).toBe("0.0.101");
    expect(job.env?.PODMAN_APT_VERSION).toBe("5.7.0+ds2-3build1");
    expect(namedStep("Checkout").with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
    });
    expect(namedStep("Build shared sandbox-name contract").run).toBe(
      "npm run build:policy-boundary",
    );
    const installPodman = namedStep("Install Podman 5 runtime").run ?? "";
    expect(installPodman).toContain("apt-get install --yes");
    expect(installPodman).toContain("passt");
    expect(installPodman).toContain("uidmap");
    expect(installPodman).toContain('"podman=$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$package_version" = "$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$version" = "podman version 5.7.0"');
    const installOpenShell = namedStep("Install pinned OpenShell runtime").run ?? "";
    expect(installOpenShell).toContain("env -u GH_TOKEN -u GITHUB_TOKEN");
    expect(installOpenShell).toContain("bash scripts/install-openshell.sh");
    expect(installOpenShell).toContain("$HOME/.local/bin");
    expect(readRepoText(".github/workflows/podman-cpu-proof.yaml")).not.toContain("${{ secrets.");
    const delegation = delegationJob();
    const prepare =
      namedDelegationStep("Prepare CPU controller settings without service delegation").run ?? "";
    const reject =
      namedDelegationStep(
        "Verify missing delegation blocks portable configuration and service activation",
      ).run ?? "";
    const admit =
      namedDelegationStep("Apply administrator delegation and prove admission").run ?? "";
    const diagnostics = namedDelegationStep("Capture CPU delegation failure diagnostics");
    const cleanup = namedDelegationStep("Restore the user manager boundary");

    expect(delegation.name).toBe("Portable CPU delegation admission on Ubuntu 22.04");
    expect(delegation["runs-on"]).toBe("ubuntu-22.04");
    expect(delegation["timeout-minutes"]).toBe(15);
    expect(delegation.env?.E2E_CPU_DELEGATION_USER).toBe("nemoclaw-e2e");
    expect(delegation.env?.E2E_TARGET_ID).toBe("portable-cpu-delegation");
    expect(delegation.env?.E2E_SOURCE_REVISION).toBe("${{ github.event.pull_request.head.sha }}");
    expect(delegation.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(namedDelegationStep("Checkout").with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.event.pull_request.head.sha }}",
    });
    expect(namedDelegationStep("Build shared sandbox-name contract").run).toBe(
      "npm run build:policy-boundary",
    );
    expect(prepare).toContain('useradd --create-home --shell /bin/bash --comment "$user_comment"');
    expect(prepare).toContain("CPUWeight=100");
    expect(prepare.match(/CPUWeight=100/gu)).toHaveLength(2);
    expect(prepare).not.toContain("CPUAccounting=yes");
    expect(prepare).toContain('grep -qw cpu "$user_slice_controllers"');
    expect(prepare).toContain("trap cleanup_failed_prepare EXIT");
    expect(prepare).toContain("Preparation rollback was incomplete");
    expect(prepare).toContain("created_user=1");
    expect(prepare).toContain('test -L "$drop_in"');
    expect(prepare).toContain("E2E_CPU_DELEGATION_USER_CREATED=1");
    expect(prepare).toContain("E2E_CPU_DELEGATION_USER_CLAIMED=1");
    expect(prepare).toContain("E2E_CPU_DELEGATION_USER_COMMENT");
    expect(prepare).toContain("E2E_CPU_DELEGATION_HOME");
    expect(prepare).toContain("E2E_SOURCE_CACHE_DIR");
    expect(prepare).toContain("E2E_SOURCE_CACHE_MARKER");
    expect(prepare).toContain("E2E_WORKSPACE_TRAVERSE_MARKER");
    expect(prepare).toContain('sudo chmod o+x -- "$workspace_path"');
    expect(prepare).toContain('test -x "$GITHUB_WORKSPACE/node_modules/.bin/vitest"');
    expect(prepare).toContain('source_cache_parent="$GITHUB_WORKSPACE/node_modules/.cache"');
    expect(prepare).toContain("cannot traverse the source-loader cache parent");
    expect(prepare).toContain('sudo mkdir -m 0700 -- "$source_cache_dir"');
    expect(prepare).toContain('sudo chown "$uid:$uid" -- "$source_cache_dir"');
    expect(prepare).toContain("Source-loader cache already exists");
    expect(prepare).toContain("E2E_CPU_SLICE_DROP_IN_DIR_CREATED=1");
    expect(prepare).toContain("E2E_CPU_SLICE_DROP_IN_DIR_MARKER");
    expect(prepare).toContain('slice_drop_in_dir="/etc/systemd/system/user-${uid}.slice.d"');
    expect(prepare).not.toContain('slice_drop_in_dir="/run/systemd/system/user-${uid}.slice.d"');
    expect(prepare).toContain(
      'app_slice_drop_in="/etc/systemd/user/app.slice.d/90-nemoclaw-cpu-controller.conf"',
    );
    expect(prepare).toContain("E2E_APP_SLICE_DROP_IN_DIR_CREATED=1");
    expect(prepare).toContain("E2E_APP_SLICE_DROP_IN_DIR_MARKER");
    expect(prepare).toContain("E2E_APP_SLICE_DROP_IN_MARKER");
    expect(prepare).toContain("app.slice proof drop-in already exists");
    expect(prepare).toContain("E2E_CPU_DELEGATION_DROP_IN_DIR_MARKER");
    const userClaim = prepare.indexOf("E2E_CPU_DELEGATION_USER_CLAIMED=1");
    const userCreate = prepare.indexOf("useradd --create-home");
    const cachePathReceipt = prepare.indexOf("E2E_SOURCE_CACHE_DIR=%s");
    const cacheCreate = prepare.indexOf('sudo mkdir -m 0700 -- "$source_cache_dir"');
    expect(userClaim).toBeGreaterThan(-1);
    expect(userCreate).toBeGreaterThan(userClaim);
    expect(cachePathReceipt).toBeGreaterThan(-1);
    expect(cacheCreate).toBeGreaterThan(cachePathReceipt);
    expect(prepare).toContain('mktemp "$slice_drop_in_dir/.nemoclaw-cpu-controller.XXXXXX"');
    expect(prepare).toContain('ln -- "$slice_drop_in_temp" "$slice_drop_in"');
    expect(prepare).toContain("printf '%s\\n' \"$slice_drop_in_id\"");
    expect(prepare).toContain("Delegate=memory pids");
    expect(prepare).toContain('mktemp "$drop_in_dir/.nemoclaw-cpu-delegation.XXXXXX"');
    expect(prepare).toContain('ln -- "$drop_in_temp" "$drop_in"');
    expect(prepare).toContain("printf '%s\\n' \"$drop_in_id\"");
    expect(prepare).toContain("prepare-user-manager-diagnostics.txt");
    expect(prepare).toContain("trap - EXIT");
    expect(prepare).toContain('loginctl enable-linger "$E2E_CPU_DELEGATION_USER"');
    expect(prepare).toContain('systemctl start "user@${uid}.service"');
    expect(reject).not.toContain("Delegate=memory pids");
    expect(reject).not.toContain('systemctl restart "user@${E2E_CPU_DELEGATION_UID}.service"');
    expect(reject).toContain('sudo --user "$E2E_CPU_DELEGATION_USER"');
    expect(reject).toContain("env -i");
    expect(reject).toContain("E2E_CPU_DELEGATION_STATE=missing");
    expect(reject).toContain('"E2E_CPU_DELEGATION_UID=$E2E_CPU_DELEGATION_UID"');
    expect(reject).toContain("./node_modules/.bin/vitest run --no-cache --project e2e-live");
    expect(reject).toContain("portable-cpu-delegation-proof.test.ts");
    expect(reject).not.toContain("systemctl --user start app.slice");
    expect(admit).toContain("Delegate=cpu memory pids");
    expect(admit).toContain("CPU delegation proof drop-in identity changed before admission");
    expect(admit).toContain("app.slice proof drop-in identity changed before admission");
    expect(admit).toContain("expected_drop_in_id");
    expect(admit).toContain("expected_app_slice_drop_in_id");
    const stopUserManager = admit.indexOf(
      'systemctl stop "user@${E2E_CPU_DELEGATION_UID}.service"',
    );
    const reloadSystemManager = admit.indexOf("systemctl daemon-reload", stopUserManager);
    const startUserManager = admit.indexOf(
      'systemctl start "user@${E2E_CPU_DELEGATION_UID}.service"',
    );
    expect(stopUserManager).toBeGreaterThan(-1);
    expect(reloadSystemManager).toBeGreaterThan(stopUserManager);
    expect(startUserManager).toBeGreaterThan(reloadSystemManager);
    expect(admit).not.toContain('systemctl restart "user@${E2E_CPU_DELEGATION_UID}.service"');
    expect(admit).toContain("systemctl --no-pager --full status");
    expect(admit).toContain("journalctl --no-pager --unit");
    expect(admit).toContain("python3 test/e2e/lib/redact-text.py");
    expect(admit).toContain('sudo --user "$E2E_CPU_DELEGATION_USER"');
    expect(admit).toContain("env -i");
    expect(admit).toContain("E2E_CPU_DELEGATION_STATE=delegated");
    expect(admit).toContain('"E2E_CPU_DELEGATION_UID=$E2E_CPU_DELEGATION_UID"');
    expect(admit).toContain("./node_modules/.bin/vitest run --no-cache --project e2e-live");
    expect(admit).toContain("portable-cpu-delegation-proof.test.ts");
    expect(admit).not.toContain("systemctl --user start app.slice");
    expect(diagnostics.if).toBe("failure()");
    expect(diagnostics.run).toContain("systemctl --no-pager --full status");
    expect(diagnostics.run).toContain("journalctl --no-pager --unit");
    expect(diagnostics.run).toContain("python3 test/e2e/lib/redact-text.py");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain(
      'drop_in="/etc/systemd/system/user@.service.d/90-nemoclaw-cpu-delegation.conf"',
    );
    expect(cleanup.run).toContain("remove_owned_drop_in");
    expect(cleanup.run).toContain("remove_owned_directory");
    expect(cleanup.run).toContain("ownership marker is invalid");
    expect(cleanup.run).toContain("whose identity changed");
    expect(cleanup.run).toContain("whose ownership comment changed");
    expect(cleanup.run).toContain("stat -Lc '%d:%i'");
    expect(cleanup.run).toContain('sudo rm -f -- "$target"');
    expect(cleanup.run).toContain('"${E2E_CPU_SLICE_DROP_IN:-}"');
    expect(cleanup.run).toContain('sudo rmdir -- "$target"');
    expect(cleanup.run).toContain('"app.slice proof drop-in"');
    expect(cleanup.run).toContain('"app.slice proof drop-in directory"');
    expect(cleanup.run).toContain("E2E_APP_SLICE_DROP_IN_DIR_MARKER");
    expect(cleanup.run).toContain('loginctl disable-linger "$E2E_CPU_DELEGATION_USER"');
    expect(cleanup.run).toContain('loginctl terminate-user "$E2E_CPU_DELEGATION_USER"');
    expect(cleanup.run).toContain('userdel --remove "$E2E_CPU_DELEGATION_USER"');
    expect(cleanup.run).toContain("Source-loader cache ownership marker is invalid");
    expect(cleanup.run).toContain("source-loader cache whose identity changed");
    expect(cleanup.run).toContain('sudo rm -rf --one-file-system -- "$source_cache_dir"');
    expect(cleanup.run).toContain("Source-loader cache remained after cleanup");
    expect(cleanup.run).toContain("source_cache_cleanup_failed=1");
    expect(cleanup.run).toContain("Preserving the source-loader cache receipt for cleanup retry");
    expect(cleanup.run).toContain('"CPU delegation proof drop-in"');
    expect(cleanup.run).toContain('"CPU slice proof drop-in"');
    expect(cleanup.run).toContain('"CPU slice proof drop-in directory"');
    expect(cleanup.run).toContain("E2E_CPU_SLICE_DROP_IN_DIR_MARKER");
    expect(cleanup.run).toContain('"CPU delegation proof drop-in directory"');
    expect(cleanup.run).toContain("CPU delegation proof user remained after cleanup");
    expect(cleanup.run).toContain('sudo chown -R "$(id -u):$(id -g)" "$E2E_ARTIFACT_DIR"');
    expect(cleanup.run).toContain("E2E_WORKSPACE_TRAVERSE_MARKER");
    expect(cleanup.run).toContain('sudo chmod "$original_mode" -- "$workspace_path"');
    expect(cleanup.run).toContain("workspace_restore_failed=1");
    expect(cleanup.run).toContain("Preserving the workspace mode receipt for manual cleanup retry");
    const delegationProof = readRepoText("test/e2e/live/portable-cpu-delegation-proof.test.ts");
    expect(delegationProof).toContain('from "../fixtures/e2e-test.ts"');
    expect(delegationProof).not.toContain('from "vitest"');
    expect(delegationProof).toContain('"rev-parse", "HEAD"');
    expect(delegationProof).toContain("e2ePhases");
    expect(delegationProof).toContain("process.env.E2E_CPU_DELEGATION_STATE");
    expect(delegationProof).toContain("process.getuid?.()");
    expect(delegationProof).not.toContain("process.argv");
    expect(delegationProof).not.toContain("main();");
  });

  it("preserves the workspace mode receipt when preparation rollback cannot restore a mode", () => {
    const prepare =
      namedDelegationStep("Prepare CPU controller settings without service delegation").run ?? "";
    const functionStart = prepare.indexOf("cleanup_failed_prepare() {");
    const functionEnd = prepare.indexOf("\ntrap cleanup_failed_prepare EXIT", functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const cleanupFunction = prepare.slice(functionStart, functionEnd);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workspace-mode-retry-"));
    const marker = path.join(fixture, "workspace-modes");
    fs.writeFileSync(marker, "755\t/checkout-parent\n", { mode: 0o600 });

    const script = [
      "set -u",
      cleanupFunction,
      "created_user=0",
      'E2E_CPU_DELEGATION_USER="nemoclaw-e2e"',
      'user_comment="proof-owner"',
      'uid=""',
      'slice_drop_in_temp=""',
      'drop_in_temp=""',
      'app_slice_drop_in_temp=""',
      'source_cache_id=""',
      'drop_in_id=""',
      'app_slice_drop_in_id=""',
      'slice_drop_in_id=""',
      "created_app_slice_drop_in_dir=0",
      "created_slice_drop_in_dir=0",
      'drop_in_dir_id=""',
      'workspace_traverse_marker="$1"',
      "sudo() {",
      '  if [ "$1" = chmod ]; then',
      "    return 75",
      "  fi",
      "  return 0",
      "}",
      "(false)",
      "cleanup_failed_prepare",
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script, "bash", marker], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Preserving the workspace mode receipt");
      expect(fs.readFileSync(marker, "utf8")).toBe("755\t/checkout-parent\n");
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("preserves the workspace mode receipt when final cleanup cannot restore a mode", () => {
    const cleanup = namedDelegationStep("Restore the user manager boundary").run ?? "";
    const blockStart = cleanup.indexOf(
      'workspace_traverse_marker="${E2E_WORKSPACE_TRAVERSE_MARKER:-}"',
    );
    const blockEnd = cleanup.indexOf('\nexit "$cleanup_failed"', blockStart);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const cleanupBlock = cleanup.slice(blockStart, blockEnd);
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-final-mode-retry-"));
    const marker = path.join(fixture, "workspace-modes");
    fs.writeFileSync(marker, "755\t/checkout-parent\n", { mode: 0o600 });

    const script = [
      "set -u",
      "cleanup_failed=0",
      'E2E_WORKSPACE_TRAVERSE_MARKER="$1"',
      "sudo() {",
      '  if [ "$1" = chmod ]; then',
      "    return 75",
      "  fi",
      '  command "$@"',
      "}",
      cleanupBlock,
      'exit "$cleanup_failed"',
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script, "bash", marker], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Preserving the workspace mode receipt for manual cleanup retry",
      );
      expect(fs.readFileSync(marker, "utf8")).toBe("755\t/checkout-parent\n");
    } finally {
      fs.rmSync(fixture, { force: true, recursive: true });
    }
  });

  it.each(["invalid-marker", "identity-changed", "remove-failed"] as const)(
    "preserves the source-cache receipt when final cleanup reports %s",
    (scenario) => {
      const cleanup = namedDelegationStep("Restore the user manager boundary").run ?? "";
      const blockStart = cleanup.indexOf('source_cache_dir="${E2E_SOURCE_CACHE_DIR:-}"');
      const blockEnd = cleanup.indexOf("\nsudo systemctl daemon-reload", blockStart);
      expect(blockStart).toBeGreaterThanOrEqual(0);
      expect(blockEnd).toBeGreaterThan(blockStart);
      const cleanupBlock = cleanup.slice(blockStart, blockEnd);
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cache-retry-"));
      const cache = path.join(fixture, "source-cache");
      const marker = path.join(fixture, "source-cache-id");
      fs.mkdirSync(cache);
      const metadata = fs.statSync(cache);
      const actualIdentity = `${String(metadata.dev)}:${String(metadata.ino)}`;
      const markerContents = {
        "identity-changed": "999999:999999\n",
        "invalid-marker": "invalid\n",
        "remove-failed": `${actualIdentity}\n`,
      }[scenario];
      const expectedError = {
        "identity-changed": "whose identity changed",
        "invalid-marker": "ownership marker is invalid",
        "remove-failed": "Source-loader cache remained after cleanup",
      }[scenario];
      const failRemove = scenario === "remove-failed" ? "1" : "0";
      fs.writeFileSync(marker, markerContents, { mode: 0o600 });

      const script = [
        "set -u",
        "cleanup_failed=0",
        'E2E_SOURCE_CACHE_DIR="$1"',
        'E2E_SOURCE_CACHE_MARKER="$2"',
        'ACTUAL_CACHE_ID="$3"',
        'FAIL_CACHE_RM="$4"',
        "sudo() {",
        '  if [ "$1" = test ]; then',
        "    shift",
        '    command test "$@"',
        "    return",
        "  fi",
        '  if [ "$1" = stat ]; then',
        "    printf '%s\\n' \"$ACTUAL_CACHE_ID\"",
        "    return 0",
        "  fi",
        '  if [ "$1" = rm ] && [ "$FAIL_CACHE_RM" = 1 ]; then',
        "    return 75",
        "  fi",
        '  command "$@"',
        "}",
        cleanupBlock,
        'exit "$cleanup_failed"',
      ].join("\n");

      try {
        const result = spawnSync(
          "bash",
          ["-c", script, "bash", cache, marker, actualIdentity, failRemove],
          { encoding: "utf8" },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(expectedError);
        expect(result.stderr).toContain(
          "Preserving the source-loader cache receipt for cleanup retry",
        );
        expect(fs.readFileSync(marker, "utf8")).toBe(markerContents);
        expect(fs.statSync(cache).isDirectory()).toBe(true);
      } finally {
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );

  it("pins one rootless socket and fails closed on Docker use", () => {
    const installGuard = namedStep("Install Docker invocation guard").run ?? "";
    const disableDocker = namedStep("Disable Docker daemon and socket").run ?? "";
    const startPodman = namedStep("Start exact rootless Podman API socket").run ?? "";
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(installGuard).toContain("exit 97");
    expect(installGuard).toContain("DOCKER_HOST=");
    expect(disableDocker).toContain("systemctl stop docker.service docker.socket");
    expect(disableDocker).toContain("pkill -TERM -x dockerd");
    expect(disableDocker).toContain("docker-absence-boundary.json");
    expect(disableDocker).toContain('source_revision="$(git rev-parse HEAD)"');
    expect(disableDocker).toContain('test "$source_revision" = "$E2E_SOURCE_REVISION"');
    expect(disableDocker).toContain("candidate-execution-prerequisites.json");
    expect(disableDocker).toContain("Docker socket remained available after Docker shutdown");
    const correctPastaPolicy = namedStep("Apply Ubuntu pasta signal policy correction").run ?? "";
    expect(correctPastaPolicy).toContain("/etc/apparmor.d/usr.bin.pasta");
    expect(correctPastaPolicy).toContain("signal (receive) peer=podman,");
    expect(correctPastaPolicy).toContain('apparmor_parser -r "$pasta_profile"');
    expect(startPodman).toContain("umask 077");
    expect(startPodman).toContain('socket_path="$runtime_dir/podman/podman.sock"');
    expect(startPodman).toContain('default_rootless_network_cmd = "pasta"');
    expect(startPodman).toContain("rootlessNetworkCmd");
    expect(startPodman).toContain("CONTAINERS_CONF");
    expect(startPodman).toContain('podman system service --time=0 "unix://$socket_path"');
    expect(startPodman).toContain("E2E_PODMAN_SOCKET");
    expect(scripts).not.toMatch(/\bdocker\s+(?:build|info|login|pull|run)\b/u);
    expect(scripts).not.toContain("podman-docker");
  });

  it("runs the real pinned OpenShell activation proof without synthetic fixtures", () => {
    const proof = namedStep(
      "Prove pinned OpenShell activation and registered-agent Podman CPU lifecycle",
    );
    const diagnostics = namedStep("Capture failed Podman lifecycle diagnostics");
    const cleanup = namedStep("Clean up rootless Podman runtime");
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(proof.run).toBe(
      "npx vitest run --project e2e-live test/e2e/live/podman-cpu-lifecycle.test.ts",
    );
    const liveSource = readRepoText("test/e2e/live/podman-cpu-lifecycle.test.ts");
    const authorityIndex = liveSource.indexOf("expect(candidateAuthority())");
    const enginesIndex = liveSource.indexOf("let runtimeEngines = engines()");
    expect(authorityIndex).toBeGreaterThanOrEqual(0);
    expect(enginesIndex).toBeGreaterThanOrEqual(0);
    expect(authorityIndex).toBeLessThan(enginesIndex);
    expect(scripts).not.toContain("podman create");
    expect(scripts).not.toContain("openshell-sandbox-$sandbox_name");
    expect(scripts).not.toContain("openshell.sandbox-name");
    expect(diagnostics.if).toBe("failure()");
    expect(diagnostics.run).toContain('podman --url "$endpoint" inspect');
    expect(diagnostics.run).toContain(
      "npx --no-install tsx test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
    );
    expect(diagnostics.run).toContain("managed-container-summary.json");
    expect(diagnostics.run).not.toContain("podman-ps.txt");
    expect(diagnostics.run).not.toContain("-inspect.json");
    expect(diagnostics.run).not.toMatch(/podman\s+--url\s+"\$endpoint"\s+logs\b/u);
    expect(diagnostics.run).not.toContain("container-$container_id.log");
    expect(diagnostics.run).toContain("podman-secrets.txt");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("--filter label=openshell.managed=true");
    expect(cleanup.run).toContain('podman --url "$endpoint" rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" volume rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" secret rm');
    expect(cleanup.run).toContain('podman --url "$endpoint" network rm openshell-docker');
  });
});
