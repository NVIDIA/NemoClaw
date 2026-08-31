// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

function writePendingStationReceiptRetirement(tmp: string): void {
  fs.writeFileSync(
    path.join(tmp, ".nemoclaw", "onboard-session.json"),
    JSON.stringify({
      version: 1,
      status: "complete",
      resumable: false,
      stationExpressIntent: null,
      stationExpressReceiptRetirement: "0123456789abcdef0123456789abcdef",
    }),
  );
}

function runPayloadOnlyRecoveryBootstrap(dockerHost: string): {
  output: string;
  status: number | null;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-payload-bootstrap-"));
  const payloadRoot = path.join(tmp, "payload-only");
  const childPayload = path.join(tmp, "child-install.sh");
  const callLog = path.join(tmp, "calls.log");
  const dockerHostContract = path.join(
    path.dirname(INSTALLER_PAYLOAD),
    "..",
    "src",
    "lib",
    "domain",
    "docker-host.ts",
  );
  fs.mkdirSync(payloadRoot);
  fs.writeFileSync(
    childPayload,
    `#!/usr/bin/env bash
set -euo pipefail
NEMOCLAW_VERSIONED_INSTALLER_PAYLOAD=1
source_root="$(cd "$(dirname "$0")/.." && pwd)"
node --experimental-strip-types --no-warnings -e '
  const validator = require(process.argv[1]).isSupportedGatewayDockerHost;
  process.exit(validator(process.argv[2]) ? 0 : 10);
' "$source_root/src/lib/domain/docker-host.ts" "$DOCKER_HOST"
printf 'ref=%s tag=%s bootstrap=%s host=%s recovery-started\n' "$NEMOCLAW_INSTALL_REF" "$NEMOCLAW_INSTALL_TAG" "$NEMOCLAW_BOOTSTRAP_PAYLOAD" "$DOCKER_HOST" > "$BOOTSTRAP_CALL_LOG"
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -e
source "$INSTALLER_PAYLOAD" >/dev/null
NEMOCLAW_SOURCE_ROOT="$PAYLOAD_ROOT"
resolve_release_tag() { printf 'refs/tags/payload-test'; }
clone_nemoclaw_ref() {
  destination="$2"
  mkdir -p "$destination/scripts" "$destination/src/lib/domain"
  cp "$CHILD_PAYLOAD" "$destination/scripts/install.sh"
  cp "$DOCKER_HOST_CONTRACT" "$destination/src/lib/domain/docker-host.ts"
}
standalone_installer_payload_needs_checkout --non-interactive
bootstrap_standalone_installer_payload --non-interactive
`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        BOOTSTRAP_CALL_LOG: callLog,
        CHILD_PAYLOAD: childPayload,
        DOCKER_HOST: dockerHost,
        DOCKER_HOST_CONTRACT: dockerHostContract,
        INSTALLER_PAYLOAD,
        NEMOCLAW_BOOTSTRAP_PAYLOAD: "",
        PAYLOAD_ROOT: payloadRoot,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}${fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf-8") : ""}`;
  fs.rmSync(tmp, { force: true, recursive: true });
  return { output, status: result.status };
}

function runRecoveryBeforeOnboard(
  preexistingCount: number,
  recoveryExitCode: number | [first: number, second: number],
  options: {
    dockerHost?: string;
    hostPreflightExitCode?: number;
    interactive?: boolean;
    orphanedRecovery?: boolean;
    registryJson?: string;
    realCompletionSummary?: boolean;
    recordPreinstall?: boolean;
    recoveryLogWriteFails?: boolean;
    singleSession?: boolean;
    sourceRoot?: string;
    stationExpressSelected?: boolean;
    stationResumeLoaded?: boolean;
    prepareState?: (tmp: string) => void;
  } = {},
): { status: number | null; calls: string[]; output: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-recovery-order-"));
  const cli = path.join(tmp, "nemoclaw");
  const callLog = path.join(tmp, "calls.log");
  const recoveryCallLog = path.join(tmp, "recovery-calls.log");
  const [firstRecoveryExitCode, secondRecoveryExitCode] = Array.isArray(recoveryExitCode)
    ? recoveryExitCode
    : [recoveryExitCode, recoveryExitCode];
  const payloadDir = path.join(tmp, "payload");
  const payloadLibDir = path.join(payloadDir, "lib");
  fs.mkdirSync(payloadDir);
  fs.mkdirSync(payloadLibDir);
  fs.copyFileSync(
    path.join(path.dirname(INSTALLER_PAYLOAD), "lib", "station-vllm-conflict.sh"),
    path.join(payloadLibDir, "station-vllm-conflict.sh"),
  );
  fs.mkdirSync(path.join(tmp, ".nemoclaw"));
  fs.chmodSync(path.join(tmp, ".nemoclaw"), 0o700);
  fs.writeFileSync(
    path.join(tmp, ".nemoclaw", "sandboxes.json"),
    options.registryJson ?? '{"sandboxes":{}}',
  );
  options.prepareState?.(tmp);
  fs.writeFileSync(path.join(payloadDir, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
printf 'restore=%s confirmed=%s argv=%s\n' "\${NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE:-}" "\${NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES:-}" "$*" >> "${callLog}"
if [ "\${1:-}" = "upgrade-sandboxes" ]; then
  recovery_call=0
  if [ -f "${recoveryCallLog}" ]; then
    read -r recovery_call < "${recoveryCallLog}"
  fi
  recovery_call=$((recovery_call + 1))
  printf '%s\n' "$recovery_call" > "${recoveryCallLog}"
  if [ "$recovery_call" -eq 1 ]; then
    recovery_status=${firstRecoveryExitCode}
  else
    recovery_status=${secondRecoveryExitCode}
  fi
  if [ "$recovery_status" -ne 0 ]; then
    printf "Failed to recover 'broken-box': prepared backup restore failed\n" >&2
  elif [ "${options.orphanedRecovery ? "1" : "0"}" = "1" ]; then
    printf "1 recorded sandbox(es) were not found on their recorded gateway\n"
  fi
  exit "$recovery_status"
fi
exit 0
`,
    { mode: 0o755 },
  );

  const snippet = `
    set -e
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
    ${options.sourceRoot === undefined ? "" : `NEMOCLAW_SOURCE_ROOT="${options.sourceRoot}"`}
    _CLI_BIN=nemoclaw
    _UPGRADE_SANDBOXES_FAILED=false
    _STATION_EXPRESS_RESUME_LOADED=${options.stationResumeLoaded ? "1" : ""}
    SCRIPT_DIR="${payloadDir}"
    info() { printf 'INFO:%s\n' "$*"; }
    warn() { printf 'WARN:%s\n' "$*"; }
    error() { printf 'ERROR:%s\n' "$*" >&2; exit 1; }
    tee() {
      if [[ "$RECOVERY_LOG_WRITE_FAILS" = "1" ]]; then
        cat >/dev/null
        return 1
      fi
      command tee "$@"
    }
    print_banner() { :; }
    preflight_usage_notice_prompt() { :; }
    ensure_docker() { :; }
    ensure_openshell_build_deps() { :; }
    maybe_offer_express_install() {
      ${options.stationExpressSelected ? '_SELECTED_EXPRESS_PLATFORM="DGX Station"' : ":"}
    }
    sleep() { printf 'sleep=%s\n' "$*" >> "${callLog}"; }
    step() { :; }
    install_nodejs() { :; }
    ensure_supported_runtime() { :; }
    fix_npm_permissions() { :; }
    preinstall_backup_and_retire_legacy_gateway() {
      if [[ "$RECORD_PREINSTALL" = "1" ]]; then
        printf 'preinstall-backup-retirement\n' >> "${callLog}"
      fi
      _PREEXISTING_SANDBOX_COUNT=${preexistingCount}
      _LEGACY_MANAGED_RECOVERY_NAMES_JSON='["legacy-box"]'
    }
    install_nemoclaw() { :; }
    verify_nemoclaw() { _CLI_PATH="${cli}"; }
    run_installer_host_preflight() {
      printf 'host-preflight\n' >> "${callLog}"
      return ${options.hostPreflightExitCode ?? 0}
    }
    ensure_station_express_host() { :; }
    ensure_station_express_pair() { :; }
    run_onboard() { "${cli}" onboard; }
    restore_onboard_forward_after_post_checks() { return 0; }
    ${options.realCompletionSummary ? "" : "print_done() { printf 'PRINT_DONE\\n'; }"}
    main ${options.interactive ? "" : "--non-interactive --yes-i-accept-third-party-software"}
  `;
  const childEnv = { ...process.env };
  delete childEnv.DOCKER_HOST;
  delete childEnv.NEMOCLAW_SINGLE_SESSION;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: {
      ...childEnv,
      BASH_ENV: "",
      ...(options.dockerHost !== undefined ? { DOCKER_HOST: options.dockerHost } : {}),
      ENV: "",
      HOME: tmp,
      NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
      ...(options.singleSession ? { NEMOCLAW_SINGLE_SESSION: "1" } : {}),
      RECORD_PREINSTALL: options.recordPreinstall ? "1" : "",
      RECOVERY_LOG_WRITE_FAILS: options.recoveryLogWriteFails ? "1" : "",
    },
  });
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return { status: result.status, calls, output: `${result.stdout}${result.stderr}` };
}

describe("install.sh pre-existing sandbox recovery ordering (#6114)", () => {
  it("bootstraps a payload-only installer before recovery through a supported Docker socket", () => {
    const result = runPayloadOnlyRecoveryBootstrap("unix:///var/run/docker.sock");

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      "ref=refs/tags/payload-test tag=refs/tags/payload-test bootstrap=1 host=unix:///var/run/docker.sock recovery-started",
    );
  });

  it("rejects an unsupported Docker host after payload-only bootstrap before recovery", () => {
    const result = runPayloadOnlyRecoveryBootstrap("tcp://203.0.113.10:2375");

    expect(result.status).toBe(10);
    expect(result.output).not.toContain("recovery-started");
  });

  it("recovers through a supported Docker socket without generic onboarding", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost: "unix:///var/run/docker.sock",
      recordPreinstall: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      "preinstall-backup-retirement",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.output).toContain("Existing sandboxes recovered; skipping generic onboarding");
  });

  it.each([
    ["a TCP DOCKER_HOST endpoint", "tcp://203.0.113.10:2375"],
    ["an SSH DOCKER_HOST endpoint", "ssh://user@example.test"],
    ["a relative DOCKER_HOST socket", "unix://relative/docker.sock"],
    ["a newline-bearing DOCKER_HOST socket", "unix:///var/run/docker.sock\n"],
  ])("rejects %s before sandbox recovery", (_name, dockerHost) => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost,
      recordPreinstall: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain(
      "DOCKER_HOST is not a supported absolute local Unix socket endpoint",
    );
    expect(result.output).toContain(
      "Unset DOCKER_HOST or set it to an absolute local Unix socket URL",
    );
    expect(result.output).toContain("Sandbox recovery did not start");
  });

  it("stops before pre-install recovery when the DOCKER_HOST contract is unavailable", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost: "unix:///var/run/docker.sock",
      recordPreinstall: true,
      sourceRoot: "/nonexistent/nemoclaw-source",
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain("Rerun the installer from a complete NemoClaw source checkout");
    expect(result.output).toContain("Sandbox recovery did not start");
  });

  it("does not report an orphaned sandbox as recovered when output recording fails", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      orphanedRecovery: true,
      realCompletionSummary: true,
      recoveryLogWriteFails: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.calls).not.toContain("onboard");
    expect(result.output).toContain(
      "The recovery command succeeded, but NemoClaw could not inspect its output",
    );
    expect(result.output).toContain("upgrade-sandboxes --check");
    expect(result.output).not.toContain("Existing sandboxes were recovered and upgraded");
    expect(result.output).not.toContain("No new sandbox onboarding was needed");
  });

  it("does not gate pre-existing recovery on generic host admission", () => {
    const result = runRecoveryBeforeOnboard(2, 0, { hostPreflightExitCode: 1 });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.output).toContain("Existing sandboxes recovered; skipping generic onboarding");
  });

  it.each([
    ["a selected Station Express attempt", { stationExpressSelected: true }],
    ["a loaded Station receipt", { stationResumeLoaded: true }],
    [
      "a pending Station receipt retirement",
      { prepareState: writePendingStationReceiptRetirement },
    ],
  ])("invokes the CLI reconciler after recovery when there is %s", (_name, options) => {
    const result = runRecoveryBeforeOnboard(2, 0, options);

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "host-preflight",
      "restore=1 confirmed= argv=onboard",
    ]);
    expect(result.output).toContain(
      "Existing sandboxes recovered; reconciling DGX Station Express onboarding state",
    );
  });

  it("keeps host admission before Station reconciliation", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      hostPreflightExitCode: 1,
      stationExpressSelected: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "host-preflight",
    ]);
    expect(result.output).toContain("Skipping onboarding until the host prerequisites above are fixed");
  });

  it("fails interactive DGX Station reconciliation when host admission fails", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      hostPreflightExitCode: 1,
      interactive: true,
      stationExpressSelected: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "host-preflight",
    ]);
    expect(result.output).toContain("DGX Station reconciliation did not run");
    expect(result.output).not.toContain("PRINT_DONE");
  });

  it("stops before onboarding when any automatic recovery fails", () => {
    const result = runRecoveryBeforeOnboard(2, 7);

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.output).toContain("Failed to recover 'broken-box'");
    expect(result.output).toContain("Generic onboarding will not run");
    expect(result.output).toContain(
      "Installation incomplete: one or more existing sandboxes failed to upgrade",
    );
  });

  it("stops before onboarding when a sandbox fails during the stability window (#7091)", () => {
    const result = runRecoveryBeforeOnboard(2, [0, 7]);

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.output).toContain("Verifying pre-existing sandboxes remain healthy");
    expect(result.output).toContain("Failed to recover 'broken-box'");
    expect(result.output).toContain("Generic onboarding will not run");
  });

  it("leaves fresh installs unchanged", () => {
    const result = runRecoveryBeforeOnboard(0, 7);

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["host-preflight", "restore=1 confirmed= argv=onboard"]);
  });

  it("does not treat a route-only reservation as an existing session (#6500)", () => {
    const result = runRecoveryBeforeOnboard(0, 7, {
      registryJson: '{"sandboxes":{"tm":{"name":"tm","pendingRouteReservation":true}}}',
      singleSession: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["host-preflight", "restore=1 confirmed= argv=onboard"]);
    expect(result.output).not.toContain("Existing sandbox sessions detected");
  });

  it("stops before onboarding when the existing registry cannot be inspected", () => {
    const result = runRecoveryBeforeOnboard(0, 0, {
      registryJson: '{"sandboxes":{"broken":null}}',
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain(
      "Could not inspect the existing sandbox registry. Onboarding was not started.",
    );
  });
});
