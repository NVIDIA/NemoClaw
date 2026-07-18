// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

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

function runRecoveryBeforeOnboard(
  preexistingCount: number,
  recoveryExitCode: number | [first: number, second: number],
  options: {
    registryJson?: string;
    singleSession?: boolean;
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
  fs.mkdirSync(payloadDir);
  fs.mkdirSync(path.join(tmp, ".nemoclaw"));
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
    _CLI_BIN=nemoclaw
    _UPGRADE_SANDBOXES_FAILED=false
    _STATION_EXPRESS_RESUME_LOADED=${options.stationResumeLoaded ? "1" : ""}
    SCRIPT_DIR="${payloadDir}"
    info() { printf 'INFO:%s\n' "$*"; }
    warn() { printf 'WARN:%s\n' "$*"; }
    error() { printf 'ERROR:%s\n' "$*" >&2; exit 1; }
    print_banner() { :; }
    preflight_usage_notice_prompt() { :; }
    ensure_docker() { :; }
    ensure_openshell_build_deps() { :; }
    maybe_offer_express_install() { :; }
    sleep() { printf 'sleep=%s\n' "$*" >> "${callLog}"; }
    step() { :; }
    install_nodejs() { :; }
    ensure_supported_runtime() { :; }
    fix_npm_permissions() { :; }
    preinstall_backup_and_retire_legacy_gateway() {
      _PREEXISTING_SANDBOX_COUNT=${preexistingCount}
      _LEGACY_MANAGED_RECOVERY_NAMES_JSON='["legacy-box"]'
    }
    install_nemoclaw() { :; }
    verify_nemoclaw() { _CLI_PATH="${cli}"; }
    run_installer_host_preflight() { return 0; }
    run_onboard() { "${cli}" onboard; }
    restore_onboard_forward_after_post_checks() { return 0; }
    print_done() { printf 'PRINT_DONE\n'; }
    main --non-interactive --yes-i-accept-third-party-software
  `;
  const childEnv = { ...process.env };
  delete childEnv.NEMOCLAW_SINGLE_SESSION;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: {
      ...childEnv,
      BASH_ENV: "",
      ENV: "",
      HOME: tmp,
      NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
      ...(options.singleSession ? { NEMOCLAW_SINGLE_SESSION: "1" } : {}),
    },
  });
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return { status: result.status, calls, output: `${result.stdout}${result.stderr}` };
}

describe("install.sh pre-existing sandbox recovery ordering (#6114)", () => {
  it("uses successful automatic recovery instead of generic onboarding", () => {
    const result = runRecoveryBeforeOnboard(2, 0);

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
      "sleep=10",
      'restore=1 confirmed=["legacy-box"] argv=upgrade-sandboxes --auto',
    ]);
    expect(result.output).toContain("Existing sandboxes recovered; skipping generic onboarding");
  });

  it.each([
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
      "restore=1 confirmed= argv=onboard",
    ]);
    expect(result.output).toContain(
      "Existing sandboxes recovered; reconciling DGX Station Express onboarding state",
    );
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
    expect(result.calls).toEqual(["restore=1 confirmed= argv=onboard"]);
  });

  it("does not treat a route-only reservation as an existing session (#6500)", () => {
    const result = runRecoveryBeforeOnboard(0, 7, {
      registryJson: '{"sandboxes":{"tm":{"name":"tm","pendingRouteReservation":true}}}',
      singleSession: true,
    });

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["restore=1 confirmed= argv=onboard"]);
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
