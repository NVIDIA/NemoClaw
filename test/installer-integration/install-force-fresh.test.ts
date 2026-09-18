// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { createInstallerCheckout, runInstallerSourcedBody } from "../helpers/installer-run-fixture";
import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");

function installerCheckout(prefix: string) {
  const checkout = createInstallerCheckout(prefix);
  onTestFinished(() => checkout.remove());
  return checkout;
}

function callPayloadFunction(command: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; ${command}`], {
    cwd: path.join(import.meta.dirname, "../.."),
    encoding: "utf-8",
    env: {
      HOME: os.tmpdir(),
      PATH: TEST_SYSTEM_PATH,
      ...env,
    },
  });
}

it.each([
  ["public bootstrap", INSTALLER],
  ["versioned payload", INSTALLER_PAYLOAD],
])("documents the macOS-only destructive option in the %s help", (_surface, installer) => {
  const result = spawnSync("bash", [installer, "--help"], {
    cwd: path.join(import.meta.dirname, "../.."),
    encoding: "utf-8",
  });

  expect(result.status).toBe(0);
  const output = `${result.stdout}${result.stderr}`;
  expect(output).toMatch(/--force-fresh-install .*macOS only/u);
  expect(output).toMatch(/NEMOCLAW_FORCE_FRESH_INSTALL=1 .*macOS only/u);
});

it("detects a Homebrew-only OpenShell installation", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-detect-");
  writeExecutable(
    path.join(fakeBin, "brew"),
    `#!/usr/bin/env bash
if [ "$*" = "list --formula nvidia/openshell/openshell" ]; then exit 0; fi
exit 1
`,
  );

  const result = callPayloadFunction("force_fresh_install_has_existing_state && printf 'present'", {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("present");
});

it("detects Docker-only state only through an authoritative managed-image label", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-detect-docker-");
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
case "$*" in
  info) exit 0 ;;
  "ps -aq --filter label=io.nvidia.nemoclaw.managed-image.contract") printf '0123456789ab\n' ;;
  *) exit 1 ;;
esac
`,
  );

  const result = callPayloadFunction("force_fresh_install_has_existing_state && printf 'present'", {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("present");
});

it("does not treat an unlabeled prefix-matching Docker container as owned state", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-ignore-docker-");
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
case "$*" in
  info) exit 0 ;;
  "ps -aq --filter label=io.nvidia.nemoclaw.managed-image.contract") exit 0 ;;
  "volume ls --filter label=io.nvidia.nemoclaw.managed-startup.receipt=1 --format {{.Name}}") exit 0 ;;
  *) exit 1 ;;
esac
`,
  );

  const result = callPayloadFunction("force_fresh_install_has_existing_state", {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).not.toBe(0);
});

it("detects labelled Docker receipt-volume-only state", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-receipt-detect-");
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
case "$*" in
  info) exit 0 ;;
  "ps -aq --filter label=io.nvidia.nemoclaw.managed-image.contract") exit 0 ;;
  "volume ls --filter label=io.nvidia.nemoclaw.managed-startup.receipt=1 --format {{.Name}}")
    printf 'nemoclaw-managed-startup-receipt-volume-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
    ;;
  *) exit 1 ;;
esac
`,
  );

  const result = callPayloadFunction("force_fresh_install_has_existing_state", {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).toBe(0);
});

it("stops before cleanup when Docker is installed but unavailable", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout(
    "nemoclaw-force-fresh-docker-unavailable-",
  );
  const cleanupMarker = path.join(tmp, "cleanup-started");
  writeExecutable(path.join(fakeBin, "docker"), "#!/usr/bin/env bash\nexit 1\n");

  const result = callPayloadFunction(
    `
      warn() { :; }
      remove_macos_openshell_for_force_fresh_install() { touch "$CLEANUP_MARKER"; }
      prepare_force_fresh_uninstaller() { touch "$CLEANUP_MARKER"; }
      run_force_fresh_install_reset
    `,
    {
      CLEANUP_MARKER: cleanupMarker,
      HOME: tmp,
      PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
    },
  );

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("Docker is installed but unavailable");
  expect(fs.existsSync(cleanupMarker)).toBe(false);
});

it("runs destructive cleanup through the staged candidate CLI", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-cli-");
  const logPath = path.join(tmp, "node.log");
  const sourceRoot = path.join(tmp, "candidate");
  fs.mkdirSync(path.join(sourceRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "bin", "nemoclaw.js"), "// staged candidate\n");
  writeExecutable(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
printf 'destroy=%s args=%s\n' "\${NEMOCLAW_UNINSTALL_DESTROY_USER_DATA:-}" "$*" > "$FORCE_FRESH_LOG"
`,
  );

  const result = callPayloadFunction(`run_force_fresh_uninstaller ${JSON.stringify(sourceRoot)}`, {
    FORCE_FRESH_LOG: logPath,
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(logPath, "utf-8")).toBe(
    `destroy=1 args=${path.join(sourceRoot, "bin", "nemoclaw.js")} internal uninstall run-plan --yes --destroy-user-data --force-fresh-reset --all-gateway-ports\n`,
  );
});

it("stops when the staged candidate uninstaller fails", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-failure-");
  const sourceRoot = path.join(tmp, "candidate");
  fs.mkdirSync(path.join(sourceRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "bin", "nemoclaw.js"), "// staged candidate\n");
  writeExecutable(path.join(fakeBin, "node"), "#!/usr/bin/env bash\nexit 9\n");

  const result = callPayloadFunction(`run_force_fresh_uninstaller ${JSON.stringify(sourceRoot)}`, {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).not.toBe(0);
});

it("removes only Homebrew after the canonical uninstaller handles user-local binaries", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-brew-");
  const localBin = path.join(tmp, ".local", "bin");
  const logPath = path.join(tmp, "brew.log");
  fs.mkdirSync(localBin, { recursive: true });
  writeExecutable(path.join(localBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(path.join(localBin, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(path.join(localBin, "openshell-sandbox"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(path.join(localBin, "openshell-driver-vm"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    path.join(fakeBin, "brew"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FORCE_FRESH_LOG"
exit 0
`,
  );

  const result = callPayloadFunction("remove_macos_openshell_for_force_fresh_install", {
    FORCE_FRESH_LOG: logPath,
    HOME: tmp,
    PATH: `${localBin}:${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(logPath, "utf-8").trim().split("\n")).toEqual([
    "list --formula nvidia/openshell/openshell",
    "services stop nvidia/openshell/openshell",
    "uninstall --force nvidia/openshell/openshell",
  ]);
  expect(fs.existsSync(path.join(localBin, "openshell"))).toBe(true);
  expect(fs.existsSync(path.join(localBin, "openshell-gateway"))).toBe(true);
  expect(fs.existsSync(path.join(localBin, "openshell-sandbox"))).toBe(true);
  expect(fs.existsSync(path.join(localBin, "openshell-driver-vm"))).toBe(true);
}, 30_000);

it("stops when Homebrew cannot remove OpenShell", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-brew-fail-");
  writeExecutable(
    path.join(fakeBin, "brew"),
    `#!/usr/bin/env bash
if [ "$1" = "list" ]; then exit 0; fi
if [ "$1" = "services" ]; then exit 0; fi
exit 7
`,
  );

  const result = callPayloadFunction("remove_macos_openshell_for_force_fresh_install", {
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("Homebrew could not remove OpenShell");
});

it("runs cleanup before selecting fresh onboarding", () => {
  const result = callPayloadFunction(`
    warn() { :; }
    info() { :; }
    force_fresh_install_has_existing_state() { return 0; }
    force_fresh_install_source_root() { printf '/tmp/staged-candidate'; }
    prepare_force_fresh_uninstaller() { printf 'prepare:%s\\n' "$1"; }
    run_force_fresh_uninstaller() { printf 'uninstall:%s\\n' "$1"; }
    remove_macos_openshell_for_force_fresh_install() { printf 'openshell-reset\\n'; }
    run_force_fresh_install_reset
    printf 'fresh=%s env=%s reinstall=%s count=%s\\n' "$FRESH" "$NEMOCLAW_FRESH" "$NEMOCLAW_REINSTALL_CLI" "$_PREEXISTING_SANDBOX_COUNT"
  `);

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "prepare:/tmp/staged-candidate",
    "uninstall:/tmp/staged-candidate",
    "openshell-reset",
    "fresh=1 env=1 reinstall=1 count=0",
  ]);
});

it.each(["openshell-gateway", "openshell-sandbox", "openshell-driver-vm"])(
  "routes a standalone %s helper through canonical cleanup",
  (binary) => {
    const { root: tmp } = installerCheckout("nemoclaw-force-fresh-helper-detect-");
    const localBin = path.join(tmp, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    writeExecutable(path.join(localBin, binary), "#!/usr/bin/env bash\nexit 0\n");

    const result = callPayloadFunction(
      "force_fresh_install_has_existing_state && printf 'present'",
      { HOME: tmp },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("present");
  },
);

it("stops before package removal when managed uninstall rejects partial state", () => {
  const result = callPayloadFunction(`
    warn() { :; }
    info() { :; }
    force_fresh_install_has_existing_state() { return 0; }
    force_fresh_install_source_root() { printf '/tmp/staged-candidate'; }
    prepare_force_fresh_uninstaller() { :; }
    run_force_fresh_uninstaller() { return 9; }
    remove_macos_openshell_for_force_fresh_install() { printf 'openshell-reset\\n'; }
    run_force_fresh_install_reset
  `);

  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain("openshell-reset");
  expect(`${result.stdout}${result.stderr}`).toContain(
    "authoritative whole-host uninstall did not complete",
  );
});

it("bounds staged uninstaller preparation before destructive cleanup", () => {
  const { root: tmp } = installerCheckout("nemoclaw-force-fresh-timeout-");
  const cleanupMarker = path.join(tmp, "cleanup-started");
  const startedAt = performance.now();
  const result = callPayloadFunction(
    `
        NEMOCLAW_AGENT=hermes
        FORCE_FRESH_PREPARE_TIMEOUT_SECONDS=1
        force_fresh_install_has_existing_state() { return 0; }
        force_fresh_install_source_root() { printf '/tmp/staged-candidate'; }
        bash() { trap '' TERM; while :; do sleep 1; done; }
        run_force_fresh_uninstaller() { touch "$CLEANUP_MARKER"; }
        remove_macos_openshell_for_force_fresh_install() { touch "$CLEANUP_MARKER"; }
        run_force_fresh_install_reset
      `,
    { CLEANUP_MARKER: cleanupMarker, HOME: tmp },
  );
  const elapsedMs = performance.now() - startedAt;

  expect(result.status).not.toBe(0);
  expect(elapsedMs).toBeGreaterThanOrEqual(900);
  expect(elapsedMs).toBeLessThan(10_000);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "Force-fresh uninstaller preparation timed out before cleanup",
  );
  expect(fs.existsSync(cleanupMarker)).toBe(false);
}, 15_000);

it.each([
  ["flag", "--force-fresh-install", {}],
  ["environment variable", "", { NEMOCLAW_FORCE_FRESH_INSTALL: "1" }],
] as const)(
  "routes the public force-fresh %s through reset before CLI installation",
  (_source, forceFreshArg, extraEnv) => {
    const run = runInstallerSourcedBody(
      `
    set -e
    order=""
    record() { order="\${order}$1 "; }
    apply_persisted_automatic_gateway_port() { :; }
    validate_deferred_hermes_onboarding_request() { :; }
    load_station_vllm_conflict_helpers() { :; }
    consume_station_local_vllm_resume() { return 1; }
    resolve_nemoclaw_gateway_port() { printf '8080'; }
    preflight_explicit_express_flags() { :; }
    validate_installer_docker_target_before_host_changes() { :; }
    print_banner() { :; }
    preflight_usage_notice_prompt() { :; }
    prepare_installer_host() { :; }
    bash() { :; }
    prepare_installer_node_runtime() { :; }
    run_force_fresh_install_reset() { record reset; }
    ensure_station_express_pair() { :; }
    step() { :; }
    fix_npm_permissions() { :; }
    preflight_nemoclaw_acp_shim() { :; }
    preinstall_backup_and_retire_legacy_gateway() { record legacy-backup; }
    install_nemoclaw() { record install; }
    verify_nemoclaw() { _CLI_PATH=""; }
    require_reportable_openshell_version() { :; }
    command_exists() { return 1; }
    warn() { :; }
    finalize_install() { :; }
    clear_station_resume_after_completed_onboarding() { :; }
    uname() { printf 'Darwin'; }
    main ${forceFreshArg} --non-interactive --yes-i-accept-third-party-software
    record "fresh:$FRESH:$NEMOCLAW_FORCE_FRESH_INSTALL"
    printf '%s' "$order"
  `,
      { extraEnv: { ...extraEnv } },
    );
    onTestFinished(run.remove);

    expect(run.result.status, run.output).toBe(0);
    expect(run.result.stdout.trim()).toBe("reset install fresh:1:1");
    expect(run.result.stdout).not.toContain("legacy-backup");
  },
);

it("continues force-fresh installation when Homebrew fails after the pinned runtime lands", () => {
  const result = callPayloadFunction(`
    warn() { printf 'warn:%s\n' "$*"; }
    uname() { printf 'Darwin'; }
    observed_macos_openshell_install_method() { printf 'homebrew\n'; }
    spin_count=0
    spin() {
      spin_count=$((spin_count + 1))
      printf 'spin:%s\n' "$1"
      [ "$spin_count" -eq 2 ]
    }
    prefer_homebrew_openshell() { printf 'prefer:%s\n' "$1"; }
    install_nemoclaw_openshell_gateway_user_service() { printf 'service\n'; }
    FORCE_FRESH_INSTALL=1
    maybe_install_openshell_during_install force
  `);

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "spin:Installing OpenShell CLI",
    "spin:Verifying the installed OpenShell CLI",
    "warn:Homebrew reported an install failure after placing OpenShell; the pinned OpenShell verifier passed, so force-fresh installation will continue.",
    "prefer:verified-install",
    "service",
  ]);
});

it("rejects force-fresh installation outside macOS", () => {
  const result = callPayloadFunction(`
    error() { printf '%s' "$*" >&2; return 1; }
    uname() { printf 'Linux'; }
    FORCE_FRESH_INSTALL=1
    validate_force_fresh_install_platform
  `);

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "--force-fresh-install currently supports macOS only",
  );
});

it("rejects a staged source inside the state root", () => {
  const { root: tmp } = installerCheckout("nemoclaw-force-fresh-source-");
  const sourceRoot = path.join(tmp, ".nemoclaw", "source");
  fs.mkdirSync(path.join(sourceRoot, ".git"), { recursive: true });

  const result = callPayloadFunction(
    `NEMOCLAW_SOURCE_ROOT=${JSON.stringify(sourceRoot)}; force_fresh_install_source_root`,
    { HOME: tmp },
  );

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "must run from the versioned bootstrap checkout",
  );
}, 30_000);

it("keeps an unrelated ACP shim", () => {
  const { root: tmp } = installerCheckout("nemoclaw-force-fresh-acp-");
  const shimDir = path.join(tmp, ".local", "bin");
  const npmBin = path.join(tmp, "npm", "bin");
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(path.join(shimDir, "nemoclaw-acp"), "foreign executable\n");

  const result = callPayloadFunction(
    `
      warn() { :; }
      resolve_npm_bin() { printf '${npmBin}'; }
      preflight_nemoclaw_acp_shim
      printf '%s' "$_NEMOCLAW_FORCE_FRESH_SKIP_ACP_SHIM"
    `,
    {
      FORCE_FRESH_INSTALL: "1",
      HOME: tmp,
      NEMOCLAW_SHIM_DIR: shimDir,
    },
  );

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toBe("true");
  expect(fs.readFileSync(path.join(shimDir, "nemoclaw-acp"), "utf-8")).toBe("foreign executable\n");
}, 30_000);
