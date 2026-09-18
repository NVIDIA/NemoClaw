// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { createInstallerCheckout } from "../helpers/installer-run-fixture";
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

function callBootstrapFunction(command: string, env: Record<string, string | undefined> = {}) {
  return spawnSync("bash", ["-c", `source "${INSTALLER}" 2>/dev/null; ${command}`], {
    cwd: path.join(import.meta.dirname, "../.."),
    encoding: "utf-8",
    env: {
      HOME: os.tmpdir(),
      PATH: TEST_SYSTEM_PATH,
      ...env,
    },
  });
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

it("documents the destructive force-fresh install option", () => {
  const result = spawnSync("bash", [INSTALLER, "--help"], {
    cwd: path.join(import.meta.dirname, "../.."),
    encoding: "utf-8",
  });

  expect(result.status).toBe(0);
  const output = `${result.stdout}${result.stderr}`;
  expect(output).toContain("--force-fresh-install");
  expect(output).toContain("NEMOCLAW_FORCE_FRESH_INSTALL=1");
});

it("recognizes force-fresh intent from the flag or environment", () => {
  const result = callBootstrapFunction(`
    bootstrap_force_fresh_install_requested --force-fresh-install && printf 'flag\\n'
    NEMOCLAW_FORCE_FRESH_INSTALL=1
    bootstrap_force_fresh_install_requested && printf 'environment\\n'
    unset NEMOCLAW_FORCE_FRESH_INSTALL
    if bootstrap_force_fresh_install_requested; then exit 9; fi
    printf 'absent\\n'
  `);

  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual(["flag", "environment", "absent"]);
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
    `destroy=1 args=${path.join(sourceRoot, "bin", "nemoclaw.js")} internal uninstall run-plan --yes --destroy-user-data --all-gateway-ports\n`,
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

it("removes only NemoClaw and OpenShell Docker resources", () => {
  const { root: tmp, binDir: fakeBin } = installerCheckout("nemoclaw-force-fresh-docker-");
  const logPath = path.join(tmp, "docker.log");
  writeExecutable(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
case "$*" in
  info) exit 0 ;;
  "ps -a --format {{.ID}} {{.Image}} {{.Names}}")
    printf '%s\n' 'aaaaaaaaaaaa unrelated openshell-default--demo' '999999999999 82913f8e3281 random-name' 'bbbbbbbbbbbb unrelated keep-me'
    ;;
  "ps -aq --filter label=io.nvidia.nemoclaw.managed-image.contract") printf '%s\n' '999999999999' ;;
  "volume ls --format {{.Name}}") printf '%s\n' 'openshell-cluster-nemoclaw' 'keep-volume' ;;
  "network ls --format {{.ID}} {{.Name}}") printf '%s\n' 'cccccccccccc nemoclaw-net' 'dddddddddddd keep-net' ;;
  "images --format {{.ID}} {{.Repository}}") printf '%s\n' 'eeeeeeeeeeee ghcr.io/nvidia/nemoclaw/hermes-sandbox' 'ffffffffffff unrelated' ;;
  *) printf '%s\n' "$*" >> "$FORCE_FRESH_LOG" ;;
esac
`,
  );

  const result = callPayloadFunction("remove_force_fresh_docker_resources", {
    FORCE_FRESH_LOG: logPath,
    HOME: tmp,
    PATH: `${fakeBin}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(logPath, "utf-8").trim().split("\n")).toEqual([
    "rm -f aaaaaaaaaaaa",
    "rm -f 999999999999",
    "volume rm -f -- openshell-cluster-nemoclaw",
    "network rm cccccccccccc",
    "rmi -f eeeeeeeeeeee",
  ]);
});

it("removes Homebrew and standalone OpenShell installations", () => {
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
  expect(fs.existsSync(path.join(localBin, "openshell"))).toBe(false);
  expect(fs.existsSync(path.join(localBin, "openshell-gateway"))).toBe(false);
  expect(fs.existsSync(path.join(localBin, "openshell-sandbox"))).toBe(false);
  expect(fs.existsSync(path.join(localBin, "openshell-driver-vm"))).toBe(false);
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
    remove_force_fresh_install_state() { printf 'force-state-reset\\n'; }
    remove_macos_openshell_for_force_fresh_install() { printf 'openshell-reset\\n'; }
    run_force_fresh_install_reset
    printf 'fresh=%s env=%s reinstall=%s count=%s\\n' "$FRESH" "$NEMOCLAW_FRESH" "$NEMOCLAW_REINSTALL_CLI" "$_PREEXISTING_SANDBOX_COUNT"
  `);

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "prepare:/tmp/staged-candidate",
    "uninstall:/tmp/staged-candidate",
    "force-state-reset",
    "openshell-reset",
    "fresh=1 env=1 reinstall=1 count=0",
  ]);
});

it("continues force cleanup when managed uninstall rejects partial state", () => {
  const result = callPayloadFunction(`
    warn() { :; }
    info() { :; }
    force_fresh_install_has_existing_state() { return 0; }
    force_fresh_install_source_root() { printf '/tmp/staged-candidate'; }
    prepare_force_fresh_uninstaller() { :; }
    run_force_fresh_uninstaller() { return 9; }
    remove_force_fresh_install_state() { printf 'force-state-reset\\n'; }
    remove_macos_openshell_for_force_fresh_install() { printf 'openshell-reset\\n'; }
    run_force_fresh_install_reset
  `);

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual(["force-state-reset", "openshell-reset"]);
});

it("rejects force cleanup outside supported state roots", () => {
  const result = callPayloadFunction('remove_force_fresh_state_path "$HOME/Documents"', {
    HOME: os.tmpdir(),
  });

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "Refusing force-fresh cleanup outside the supported user state roots",
  );
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
