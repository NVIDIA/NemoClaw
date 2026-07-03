// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

function runRecoveryBeforeOnboard(
  preexistingCount: number,
  recoveryExitCode: number,
): { status: number | null; calls: string[]; output: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-recovery-order-"));
  const cli = path.join(tmp, "nemoclaw");
  const callLog = path.join(tmp, "calls.log");
  const payloadDir = path.join(tmp, "payload");
  fs.mkdirSync(payloadDir);
  fs.writeFileSync(path.join(payloadDir, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env bash
printf 'restore=%s argv=%s\n' "\${NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE:-}" "$*" >> "${callLog}"
if [ "\${1:-}" = "upgrade-sandboxes" ]; then
  if [ ${recoveryExitCode} -ne 0 ]; then
    printf "Failed to recover 'broken-box': prepared backup restore failed\n" >&2
  fi
  exit ${recoveryExitCode}
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
    SCRIPT_DIR="${payloadDir}"
    info() { printf 'INFO:%s\n' "$*"; }
    warn() { printf 'WARN:%s\n' "$*"; }
    error() { printf 'ERROR:%s\n' "$*" >&2; exit 1; }
    print_banner() { :; }
    preflight_usage_notice_prompt() { :; }
    ensure_docker() { :; }
    ensure_openshell_build_deps() { :; }
    maybe_offer_express_install() { :; }
    step() { :; }
    install_nodejs() { :; }
    ensure_supported_runtime() { :; }
    fix_npm_permissions() { :; }
    preinstall_backup_and_retire_legacy_gateway() {
      _PREEXISTING_SANDBOX_COUNT=${preexistingCount}
    }
    install_nemoclaw() { :; }
    verify_nemoclaw() { _CLI_PATH="${cli}"; }
    run_installer_host_preflight() { return 0; }
    run_onboard() { "${cli}" onboard; }
    restore_onboard_forward_after_post_checks() { return 0; }
    print_done() { printf 'PRINT_DONE\n'; }
    main --non-interactive --yes-i-accept-third-party-software
  `;
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: {
      ...process.env,
      BASH_ENV: "",
      ENV: "",
      HOME: tmp,
      NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE: "1",
    },
  });
  const calls = fs.existsSync(callLog)
    ? fs.readFileSync(callLog, "utf-8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  return { status: result.status, calls, output: `${result.stdout}${result.stderr}` };
}

describe("install.sh pre-existing sandbox recovery ordering (#6114)", () => {
  it("runs automatic recovery before generic onboarding", () => {
    const result = runRecoveryBeforeOnboard(2, 0);

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual([
      "restore=1 argv=upgrade-sandboxes --auto",
      "restore=1 argv=onboard",
    ]);
  });

  it("stops before onboarding when any automatic recovery fails", () => {
    const result = runRecoveryBeforeOnboard(2, 7);

    expect(result.status).toBe(1);
    expect(result.calls).toEqual(["restore=1 argv=upgrade-sandboxes --auto"]);
    expect(result.output).toContain("Failed to recover 'broken-box'");
    expect(result.output).toContain("Generic onboarding will not run");
    expect(result.output).toContain(
      "Installation incomplete: one or more existing sandboxes failed to upgrade",
    );
  });

  it("leaves fresh installs unchanged", () => {
    const result = runRecoveryBeforeOnboard(0, 7);

    expect(result.status, result.output).toBe(0);
    expect(result.calls).toEqual(["restore=1 argv=onboard"]);
  });
});
