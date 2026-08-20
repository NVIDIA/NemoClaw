// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "./helpers/installer-sourced-env";

type DeclarationMode =
  | "absent"
  | "externally-supervised"
  | "invalid"
  | "nemoclaw-managed"
  | "whitespace";
type DeclarationDriftPoint = "after-backup" | "before-backup";

const SOURCE_ROOT = path.join(import.meta.dirname, "..");

function persistGatewayManagementDeclaration(
  root: string,
  declaration: object,
  filename = "gateway-management.json",
): string {
  const declarationPath = path.join(root, filename);
  fs.writeFileSync(declarationPath, `${JSON.stringify(declaration)}\n`);
  return declarationPath;
}

function readEffects(effectLog: string): string[] {
  return fs.existsSync(effectLog)
    ? fs.readFileSync(effectLog, "utf-8").trim().split("\n").filter(Boolean)
    : [];
}

function writeGatewayManagementDeclaration(root: string, mode: DeclarationMode): string | null {
  const declaration =
    mode === "invalid"
      ? {
          version: 1,
          mode: "nemoclaw-managed",
          requiredCapabilities: [],
          "private-field-name": "provider-secret-value",
        }
      : mode === "externally-supervised"
        ? {
            version: 1,
            mode,
            endpoint: "http://127.0.0.1:8080",
            stateDir: "/var/lib/openshell/external",
            supervisor: {
              kind: "systemd-user",
              serviceName: "external-gateway.service",
              execPath: "/opt/openshell/bin/openshell-gateway",
            },
            requiredCapabilities: [],
          }
        : { version: 1, mode, requiredCapabilities: [] };
  return mode === "absent"
    ? null
    : mode === "whitespace"
      ? "   "
      : persistGatewayManagementDeclaration(root, declaration);
}

function installerEnv(
  home: string,
  declarationPath: string | null,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
    PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    SOURCE_ROOT,
    ...extra,
  };
  delete env.NEMOCLAW_GATEWAY_MANAGEMENT;
  delete env.NEMOCLAW_OPENSHELL_UPGRADE_PREPARED;
  delete env.NEMOCLAW_SINGLE_SESSION;
  delete env.SYSTEMD_UNIT_PATH;
  delete env.XDG_BIN_HOME;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  delete env.XDG_RUNTIME_DIR;
  return {
    ...env,
    ...(declarationPath ? { NEMOCLAW_GATEWAY_MANAGEMENT: declarationPath } : {}),
  };
}

function runManagedServiceStage(mode: DeclarationMode, rejectNode = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-service-stage-"));
  const home = path.join(root, "home");
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const servicePath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  const declarationPath = writeGatewayManagementDeclaration(root, mode);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
NEMOCLAW_OPENSHELL_GATEWAY_BIN="$GATEWAY_BIN"
${rejectNode ? "node() { return 91; }" : ""}
uname() { printf '%s\\n' Linux; }
resolve_nemoclaw_gateway_port() { printf '%s\\n' 8080; }
upstream_openshell_gateway_user_service_installed() { return 1; }
inspect_noncanonical_openshell_gateway_user_services() { return 0; }
info() { :; }
install_nemoclaw_openshell_gateway_user_service
`,
    ],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf-8",
      env: installerEnv(home, declarationPath, { GATEWAY_BIN: gatewayBin }),
    },
  );

  return {
    output: `${result.stdout}${result.stderr}`,
    result,
    serviceExists: fs.existsSync(servicePath),
  };
}

function runOpenShellInstall(mode: DeclarationMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-openshell-install-"));
  const home = path.join(root, "home");
  const effectLog = path.join(root, "effects.log");
  const openshellBin = path.join(home, ".local", "bin", "openshell");
  const originalContents = "#!/usr/bin/env bash\nprintf 'existing OpenShell CLI\\n'\n";
  fs.mkdirSync(path.dirname(openshellBin), { recursive: true });
  writeExecutable(openshellBin, originalContents);
  const declarationPath = writeGatewayManagementDeclaration(root, mode);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
spin() {
  printf '%s\\n' install-openshell-cli >> "$EFFECT_LOG"
  printf '%s\\n' '#!/usr/bin/env bash' 'printf '\''replaced OpenShell CLI\\n'\''' > "$OPENSHELL_BIN"
  chmod +x "$OPENSHELL_BIN"
}
prefer_user_local_openshell() { printf '%s\\n' select-installed-cli >> "$EFFECT_LOG"; }
install_nemoclaw_openshell_gateway_user_service() { printf '%s\\n' stage-managed-service >> "$EFFECT_LOG"; }
maybe_install_openshell_during_install force
`,
    ],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf-8",
      env: installerEnv(home, declarationPath, {
        EFFECT_LOG: effectLog,
        OPENSHELL_BIN: openshellBin,
      }),
    },
  );

  return {
    effects: readEffects(effectLog),
    openshellContents: fs.readFileSync(openshellBin, "utf-8"),
    originalContents,
    output: `${result.stdout}${result.stderr}`,
    result,
  };
}

function runPreOnboardingInstallPhases(mode: DeclarationMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-install-phases-"));
  const home = path.join(root, "home");
  const effectLog = path.join(root, "effects.log");
  const declarationPath = writeGatewayManagementDeclaration(root, mode);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
maybe_offer_express_install() { :; }
validate_station_pair_selection() { :; }
ensure_station_express_host() { :; }
prepare_portable_experimental_runtime_override() { :; }
ensure_docker() { :; }
bash() { :; }
step() { :; }
install_nodejs() { printf '%s\\n' install-node >> "$EFFECT_LOG"; }
ensure_supported_runtime() { printf '%s\\n' check-runtime >> "$EFFECT_LOG"; }
ensure_openshell_build_deps() { printf '%s\\n' check-openshell-build-deps >> "$EFFECT_LOG"; }
resolve_pending_express_wsl_provider() { :; }
ensure_station_express_pair() { printf '%s\\n' prepare-station-pair >> "$EFFECT_LOG"; }
fix_npm_permissions() { printf '%s\\n' fix-npm-permissions >> "$EFFECT_LOG"; }
preinstall_backup_and_retire_legacy_gateway() { :; }
install_nemoclaw() { :; }
verify_nemoclaw() { :; }
require_reportable_openshell_version() { :; }
prepare_installer_host
install_nemoclaw_before_onboarding
`,
    ],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf-8",
      env: installerEnv(home, declarationPath, { EFFECT_LOG: effectLog }),
    },
  );

  return {
    effects: readEffects(effectLog),
    output: `${result.stdout}${result.stderr}`,
    result,
  };
}

function runLegacyGatewayRetirement(
  mode: DeclarationMode,
  driftPoint?: DeclarationDriftPoint,
  competingService = false,
  managerUnavailable = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-external-retirement-"));
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const effectLog = path.join(root, "effects.log");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "sandboxes.json"),
    '{"sandboxes":{"alpha":{"name":"alpha"}}}\n',
  );
  const declarationPath = writeGatewayManagementDeclaration(root, mode);
  const driftDeclarationPath = persistGatewayManagementDeclaration(
    root,
    { version: 1, mode: "nemoclaw-managed", requiredCapabilities: ["gateway.health"] },
    "gateway-management-drift.json",
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `
source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
uname() { printf '%s\\n' Linux; }
nemoclaw_state_dir() { printf '%s\\n' "$STATE_DIR"; }
resolve_nemoclaw_gateway_port() { printf '%s\\n' 8080; }
nemoclaw_gateway_name() { printf '%s\\n' nemoclaw; }
registered_sandbox_count() { printf '%s\\n' 1; }
require_openshell_compatible_sandbox_names() { :; }
command_exists() { [ "$1" = openshell ]; }
installed_openshell_version() { printf '%s\\n' 0.0.36; }
confirm_experimental_openshell_gateway_upgrade() {
  [ "$DRIFT_POINT" != before-backup ] || cp "$DRIFT_DECLARATION_PATH" "$NEMOCLAW_GATEWAY_MANAGEMENT"
  return 0
}
confirm_legacy_managed_image_recovery() { :; }
run_preupgrade_backup() {
  printf '%s\\n' backup-all >> "$EFFECT_LOG"
  [ "$DRIFT_POINT" != after-backup ] || cp "$DRIFT_DECLARATION_PATH" "$NEMOCLAW_GATEWAY_MANAGEMENT"
}
resolve_current_openshell_version_range() { printf '%s\\n' '0.0.85 0.0.85'; }
inspect_noncanonical_openshell_gateway_user_services() {
  if [ "$MANAGER_UNAVAILABLE" = 1 ]; then
    return 2
  fi
  if [ "$COMPETING_SERVICE" = 1 ]; then
    NONCANONICAL_OPENSHELL_GATEWAY_SERVICE_ERROR="A competing OpenShell gateway service is active."
    return 3
  fi
  return 0
}
openshell() { printf 'openshell %s\\n' "$*" >> "$EFFECT_LOG"; return 0; }
info() { :; }
preinstall_backup_and_retire_legacy_gateway
`,
    ],
    {
      cwd: SOURCE_ROOT,
      encoding: "utf-8",
      env: installerEnv(home, declarationPath, {
        DRIFT_DECLARATION_PATH: driftDeclarationPath,
        DRIFT_POINT: driftPoint ?? "",
        EFFECT_LOG: effectLog,
        STATE_DIR: stateDir,
        COMPETING_SERVICE: competingService ? "1" : "0",
        MANAGER_UNAVAILABLE: managerUnavailable ? "1" : "0",
      }),
    },
  );

  return {
    effects: readEffects(effectLog),
    output: `${result.stdout}${result.stderr}`,
    result,
  };
}

describe("installer external gateway supervision", () => {
  it("does not stage a managed gateway service for an externally supervised gateway (#9705)", () => {
    const fixture = runManagedServiceStage("externally-supervised");

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.serviceExists).toBe(false);
  });

  it.each([
    ["an explicit NemoClaw-managed declaration", "nemoclaw-managed"],
    ["no gateway management declaration", "absent"],
  ] as const)("stages the managed gateway service with %s (#9705)", (_context, mode) => {
    const fixture = runManagedServiceStage(mode);

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.serviceExists).toBe(true);
  });

  it("does not back up or retire an externally supervised gateway (#9705)", () => {
    const fixture = runLegacyGatewayRetirement("externally-supervised");

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.effects).toEqual([]);
  });

  it("does not replace OpenShell or stage a service for an externally supervised gateway (#9705)", () => {
    const fixture = runOpenShellInstall("externally-supervised");

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.effects).toEqual([]);
    expect(fixture.openshellContents).toBe(fixture.originalContents);
  });

  it("rejects an invalid declaration before staging a managed gateway service (#9705)", () => {
    const fixture = runManagedServiceStage("invalid");

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.serviceExists).toBe(false);
    expect(fixture.output).toContain("Invalid gateway management declaration");
    expect(fixture.output).not.toContain("private-field-name");
    expect(fixture.output).not.toContain("provider-secret-value");
  });

  it("validates a nonempty declaration value before staging a managed service (#9705)", () => {
    const fixture = runManagedServiceStage("whitespace", true);

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.serviceExists).toBe(false);
    expect(fixture.output).toContain("Invalid gateway management declaration");
  });

  it("rejects an invalid declaration before backing up or retiring a gateway (#9705)", () => {
    const fixture = runLegacyGatewayRetirement("invalid");

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.effects).toEqual([]);
    expect(fixture.output).toContain("Invalid gateway management declaration");
    expect(fixture.output).not.toContain("private-field-name");
    expect(fixture.output).not.toContain("provider-secret-value");
  });

  it.each([
    [
      "skips OpenShell build dependencies for external supervision",
      "externally-supervised",
      ["install-node", "check-runtime", "prepare-station-pair", "fix-npm-permissions"],
    ],
    [
      "checks OpenShell build dependencies for managed supervision",
      "nemoclaw-managed",
      [
        "install-node",
        "check-runtime",
        "check-openshell-build-deps",
        "prepare-station-pair",
        "fix-npm-permissions",
      ],
    ],
    [
      "checks OpenShell build dependencies when no declaration exists",
      "absent",
      [
        "install-node",
        "check-runtime",
        "check-openshell-build-deps",
        "prepare-station-pair",
        "fix-npm-permissions",
      ],
    ],
  ] as const)("%s after Node setup (#9705)", (_context, mode, expectedEffects) => {
    const fixture = runPreOnboardingInstallPhases(mode);

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.effects).toEqual(expectedEffects);
  });

  it("rejects an invalid declaration before mutable runtime setup (#9705)", () => {
    const fixture = runPreOnboardingInstallPhases("invalid");

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.effects).toEqual(["install-node", "check-runtime"]);
    expect(fixture.output).toContain("Invalid gateway management declaration");
    expect(fixture.output).not.toContain("private-field-name");
    expect(fixture.output).not.toContain("provider-secret-value");
  });

  it.each([
    ["an explicit NemoClaw-managed declaration", "nemoclaw-managed"],
    ["no gateway management declaration", "absent"],
  ] as const)("backs up and retires the legacy gateway with %s (#9705)", (_context, mode) => {
    const fixture = runLegacyGatewayRetirement(mode);

    expect(fixture.result.status, fixture.output).toBe(0);
    expect(fixture.effects).toEqual(["backup-all", "openshell gateway destroy -g nemoclaw"]);
  });

  it("backs up but does not retire a gateway when another service can claim its port (#9705)", () => {
    const fixture = runLegacyGatewayRetirement("nemoclaw-managed", undefined, true);

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.effects).toEqual(["backup-all"]);
    expect(fixture.output).toContain("competing OpenShell gateway service");
  });

  it("backs up but does not retire a gateway when the user manager is unavailable (#9705)", () => {
    const fixture = runLegacyGatewayRetirement("nemoclaw-managed", undefined, false, true);

    expect(fixture.result.status, fixture.output).toBe(1);
    expect(fixture.effects).toEqual(["backup-all"]);
    expect(fixture.output).toContain("before retiring the legacy OpenShell gateway");
  });

  it.each([
    ["before backup", "before-backup", []],
    ["after backup", "after-backup", ["backup-all"]],
  ] as const)(
    "stops %s when the gateway management declaration changes (#9705)",
    (_context, driftPoint, expectedEffects) => {
      const fixture = runLegacyGatewayRetirement("nemoclaw-managed", driftPoint);

      expect(fixture.result.status, fixture.output).toBe(1);
      expect(fixture.effects).toEqual(expectedEffects);
      expect(fixture.output).toContain("changed during installation");
    },
  );
});
