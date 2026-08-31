// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { isSupportedGatewayDockerHost } from "../../src/lib/domain/docker-host";
import {
  createInstallerCheckout,
  runInstallerSourcedBody,
} from "../helpers/installer-run-fixture";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

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

function writePersistedDockerContext(tmp: string, currentContext: string): string {
  const dockerConfig = path.join(tmp, "docker-config");
  fs.mkdirSync(dockerConfig);
  fs.writeFileSync(
    path.join(dockerConfig, "config.json"),
    JSON.stringify({ currentContext }),
  );
  return dockerConfig;
}

function installerSupportsDockerHost(value: string | undefined): boolean {
  const run = runInstallerSourcedBody("installer_docker_host_has_supported_shape", {
    extraEnv: value === undefined ? {} : { DOCKER_HOST: value },
  });
  onTestFinished(run.remove);
  expect([0, 1], run.result.stderr).toContain(run.result.status);
  return run.result.status === 0;
}

function runRecoveryBeforeOnboard(
  preexistingCount: number,
  recoveryExitCode: number | [first: number, second: number],
  options: {
    detectedExpressPlatform?: string;
    dockerContext?: string;
    dockerHost?: string;
    hostPreflightExitCode?: number;
    includeNodeOnPath?: boolean;
    interactive?: boolean;
    orphanedRecovery?: boolean;
    persistedDockerContext?: string;
    portableProfile?: boolean;
    registryJson?: string;
    realCompletionSummary?: boolean;
    recordInstallPhases?: boolean;
    recordPreinstall?: boolean;
    recordRuntimeTarget?: boolean;
    recoveryLogWriteFails?: boolean;
    shellNeedsReload?: boolean;
    singleSession?: boolean;
    stationExpressSelected?: boolean;
    stationResumeLoaded?: boolean;
    prepareState?: (tmp: string) => void;
  } = {},
): { status: number | null; calls: string[]; output: string } {
  const checkout = createInstallerCheckout("nemoclaw-install-recovery-order-");
  onTestFinished(checkout.remove);
  const tmp = checkout.root;
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
  const dockerConfig =
    options.persistedDockerContext === undefined
      ? undefined
      : writePersistedDockerContext(tmp, options.persistedDockerContext);
  options.prepareState?.(tmp);
  fs.writeFileSync(
    path.join(payloadDir, "setup-jetson.sh"),
    `#!/usr/bin/env bash
if [[ "\${RECORD_INSTALL_PHASES:-}" = "1" ]]; then
  printf 'setup-jetson-started\n' >> "${callLog}"
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
if [[ "\${RECORD_RUNTIME_TARGET:-}" = "1" ]]; then
  printf 'cli-target=host:%s,context:%s argv=%s\n' "\${DOCKER_HOST-unset}" "\${DOCKER_CONTEXT-unset}" "$*" >> "${callLog}"
fi
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
    needs_shell_reload() { return ${options.shellNeedsReload ? 0 : 1}; }
    print_cli_path_refresh_actions() { printf 'PATH_REFRESH_ACTION\n'; }
    command_exists() {
      [[ "$1" == "docker" ]] && return 1
      command -v "$1" >/dev/null 2>&1
    }
    detect_express_platform() { printf '%s' "$DETECTED_EXPRESS_PLATFORM"; }
    record_install_phase() {
      if [[ "$RECORD_INSTALL_PHASES" = "1" ]]; then
        printf '%s\n' "$1" >> "${callLog}"
      fi
    }
    ensure_docker() { record_install_phase ensure-docker-started; }
    ensure_openshell_build_deps() { :; }
    maybe_offer_express_install() {
      ${options.stationExpressSelected ? '_SELECTED_EXPRESS_PLATFORM="DGX Station"' : ":"}
    }
    prepare_portable_experimental_runtime_override() {
      [[ "\${NEMOCLAW_EXPERIMENTAL_PROFILE:-}" == "portable" ]] || return 0
      unset DOCKER_CONTEXT
      export DOCKER_HOST=unix:///run/user/4242/podman/podman.sock
      if [[ "$RECORD_RUNTIME_TARGET" = "1" ]]; then
        record_install_phase "portable-target=host:\${DOCKER_HOST},context:\${DOCKER_CONTEXT-unset}"
      fi
    }
    sleep() { printf 'sleep=%s\n' "$*" >> "${callLog}"; }
    step() { :; }
    install_nodejs() {
      record_install_phase node-install-started
      export PATH="$NODE_BIN_DIR:$PATH"
    }
    ensure_supported_runtime() { record_install_phase runtime-check-started; }
    fix_npm_permissions() { record_install_phase npm-permissions-started; }
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
    ensure_station_express_host() {
      if [[ "$RECORD_RUNTIME_TARGET" = "1" && "\${_SELECTED_EXPRESS_PLATFORM:-}" == "DGX Station" ]]; then
        record_install_phase "station-target=host:\${DOCKER_HOST-unset},context:\${DOCKER_CONTEXT-unset}"
      fi
    }
    ensure_station_express_pair() { :; }
    run_onboard() { "${cli}" onboard; }
    restore_onboard_forward_after_post_checks() { return 0; }
    ${options.realCompletionSummary ? "" : "print_done() { printf 'PRINT_DONE\\n'; }"}
    main ${options.interactive ? "" : "--non-interactive --yes-i-accept-third-party-software"} ${options.portableProfile ? "--experimental-profile portable" : ""}
  `;
  const run = runInstallerSourcedBody(snippet, {
    extraEnv: {
      DETECTED_EXPRESS_PLATFORM: options.detectedExpressPlatform ?? "",
      ...(options.dockerContext !== undefined ? { DOCKER_CONTEXT: options.dockerContext } : {}),
      ...(dockerConfig === undefined ? {} : { DOCKER_CONFIG: dockerConfig }),
      ...(options.dockerHost !== undefined ? { DOCKER_HOST: options.dockerHost } : {}),
      NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
      NODE_BIN_DIR: path.dirname(process.execPath),
      ...(options.singleSession ? { NEMOCLAW_SINGLE_SESSION: "1" } : {}),
      RECORD_INSTALL_PHASES: options.recordInstallPhases ? "1" : "",
      RECORD_PREINSTALL: options.recordPreinstall ? "1" : "",
      RECORD_RUNTIME_TARGET: options.recordRuntimeTarget ? "1" : "",
      RECOVERY_LOG_WRITE_FAILS: options.recoveryLogWriteFails ? "1" : "",
    },
    home: tmp,
    includeNodeOnPath: options.includeNodeOnPath ?? true,
  });
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return { status: run.result.status, calls, output: run.output };
}

describe("install.sh pre-existing sandbox recovery ordering (#6114)", () => {
  it.each([
    ["an unset value", undefined],
    ["an empty value", ""],
    ["a whitespace-only value", " \t "],
    ["an absolute Unix socket", "unix:///var/run/docker.sock"],
    ["a padded absolute Unix socket", "  unix:///var/run/docker.sock\t"],
    ["a TCP endpoint", "tcp://203.0.113.10:2375"],
    ["an SSH endpoint", "ssh://user@example.test"],
    ["a relative Unix socket", "unix://relative/docker.sock"],
    ["an empty Unix socket path", "unix://"],
    ["a newline-bearing Unix socket", "unix:///var/run/docker.sock\n"],
    ["a carriage-return-bearing Unix socket", "unix:///var/run/docker.sock\r"],
    ["a quote-bearing Unix socket", "unix:///tmp/bad'sock"],
  ] as const)("keeps the early Docker host gate aligned for %s", (_name, value) => {
    expect(installerSupportsDockerHost(value)).toBe(isSupportedGatewayDockerHost(value));
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

  it("normalizes a padded Docker socket before recovery", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost: "  unix:///var/run/docker.sock\t",
      recordRuntimeTarget: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain(
      "cli-target=host:unix:///var/run/docker.sock,context:unset argv=upgrade-sandboxes --auto",
    );
    expect(result.output).toContain("Existing sandboxes recovered; skipping generic onboarding");
  });

  it("treats a whitespace-only Docker host as unset", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost: " \t ",
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

  it("defers a persisted default Docker context until Node.js is installed", () => {
    const result = runRecoveryBeforeOnboard(0, 0, {
      includeNodeOnPath: false,
      persistedDockerContext: "default",
      recordInstallPhases: true,
      recordPreinstall: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain("ensure-docker-started");
    expect(result.calls).toContain("node-install-started");
    expect(result.calls).toContain("preinstall-backup-retirement");
    expect(result.calls).toContain("host-preflight");
    expect(result.output).not.toContain("Docker context does not select the local default target");
  });

  it("rejects a deferred remote Docker context before recovery", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      includeNodeOnPath: false,
      persistedDockerContext: "remote-context",
      recordInstallPhases: true,
      recordPreinstall: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toContain("ensure-docker-started");
    expect(result.calls).toContain("node-install-started");
    expect(result.calls).not.toContain("preinstall-backup-retirement");
    expect(result.calls).not.toContain(
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    );
    expect(result.output).toContain("Docker context does not select the local default target");
  });

  it.each([
    ["a TCP DOCKER_HOST endpoint", "tcp://203.0.113.10:2375"],
    ["an SSH DOCKER_HOST endpoint", "ssh://user@example.test"],
    ["a relative DOCKER_HOST socket", "unix://relative/docker.sock"],
    ["an empty DOCKER_HOST socket path", "unix://"],
    ["a newline-bearing DOCKER_HOST socket", "unix:///var/run/docker.sock\n"],
    ["a carriage-return-bearing DOCKER_HOST socket", "unix:///var/run/docker.sock\r"],
    ["a quote-bearing DOCKER_HOST socket", "unix:///tmp/bad'sock"],
  ])("rejects %s before sandbox recovery", (_name, dockerHost) => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerHost,
      recordInstallPhases: true,
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
  });

  it("reports an invalid fresh-install Docker target without implying recovery state", () => {
    const result = runRecoveryBeforeOnboard(0, 0, {
      dockerHost: "tcp://203.0.113.10:2375",
      recordInstallPhases: true,
      recordPreinstall: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain(
      "DOCKER_HOST is not a supported absolute local Unix socket endpoint",
    );
    expect(result.output).not.toContain("Sandbox recovery did not start");
  });

  it.each([
    ["an explicit remote context", { dockerContext: "remote-context" }],
    ["a persisted remote context", { persistedDockerContext: "remote-context" }],
  ])("rejects %s before sandbox recovery", (_name, dockerTarget) => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      ...dockerTarget,
      recordInstallPhases: true,
      recordPreinstall: true,
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain("Docker context does not select the local default target");
    expect(result.output).toContain("docker context use default");
  });

  it.each([
    ["a TCP endpoint", "tcp://203.0.113.10:2375"],
    ["an SSH endpoint", "ssh://user@example.test"],
  ])("lets the portable profile replace %s before recovery", (_name, dockerHost) => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      dockerContext: "remote-context",
      dockerHost,
      portableProfile: true,
      recordInstallPhases: true,
      recordPreinstall: true,
      recordRuntimeTarget: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls[0]).toBe(
      "portable-target=host:unix:///run/user/4242/podman/podman.sock,context:unset",
    );
    expect(result.calls).toContain("preinstall-backup-retirement");
    expect(result.calls).toContain(
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    );
    expect(result.calls).toContain(
      "cli-target=host:unix:///run/user/4242/podman/podman.sock,context:unset argv=upgrade-sandboxes --auto",
    );
  });

  it.each([
    ["a TCP endpoint", "tcp://203.0.113.10:2375"],
    ["an SSH endpoint", "ssh://user@example.test"],
  ])("lets DGX Station replace %s before recovery", (_name, dockerHost) => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      detectedExpressPlatform: "DGX Station",
      dockerContext: "remote-context",
      dockerHost,
      recordInstallPhases: true,
      recordPreinstall: true,
      recordRuntimeTarget: true,
      stationExpressSelected: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls[0]).toBe("station-target=host:unset,context:default");
    expect(result.calls).toContain("preinstall-backup-retirement");
    expect(result.calls).toContain(
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    );
    expect(result.calls).toContain(
      "cli-target=host:unset,context:default argv=upgrade-sandboxes --auto",
    );
  });

  it("does not report an orphaned sandbox as recovered when output recording fails", () => {
    const result = runRecoveryBeforeOnboard(2, 0, {
      orphanedRecovery: true,
      realCompletionSummary: true,
      recoveryLogWriteFails: true,
      shellNeedsReload: true,
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
    expect(result.output.indexOf("PATH_REFRESH_ACTION")).toBeLessThan(
      result.output.indexOf("upgrade-sandboxes --check"),
    );
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
