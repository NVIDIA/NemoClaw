// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-activation-diagnostic-"));
  tempRoots.push(root);
  return root;
}

function runInstallHelper(home: string, body: string, env: NodeJS.ProcessEnv = {}) {
  const platformBin = path.join(home, "test-platform-bin");
  fs.mkdirSync(platformBin, { recursive: true });
  writeExecutable(path.join(platformBin, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n");
  const { PATH: injectedPath, ...injectedEnv } = env;
  return spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        `source ${JSON.stringify(INSTALLER)}`,
        "systemd_user_service_system_unit_roots() { :; }",
        body,
      ].join("\n"),
    ],
    {
      cwd: home,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${platformBin}:${injectedPath ?? `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`}`,
        XDG_CONFIG_HOME: "",
        XDG_CONFIG_DIRS: path.join(home, "empty-xdg-config-dirs"),
        XDG_DATA_DIRS: path.join(home, "empty-xdg-data-dirs"),
        XDG_DATA_HOME: "",
        XDG_RUNTIME_DIR: path.join(home, "runtime"),
        SYSTEMD_UNIT_PATH: "",
        NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        ...injectedEnv,
      },
      timeout: 30_000,
    },
  );
}

function createCanonicalActivation(home: string, configHome: string): string {
  const activationPath = path.join(
    configHome,
    "systemd",
    "user",
    "default.target.wants",
    "openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(activationPath), { recursive: true });
  fs.symlinkSync(path.join(home, "missing-canonical-unit.service"), activationPath);
  return activationPath;
}

function writeUnavailableSystemctlStub(home: string) {
  const bin = path.join(home, "unavailable-systemctl-bin");
  const log = path.join(home, "unavailable-systemctl.log");
  const busctlLog = path.join(home, "unavailable-busctl.log");
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      "printf 'Failed to connect to bus: No medium found\\n' >&2",
      "exit 1",
      "",
    ].join("\n"),
  );
  return { bin, busctlLog, log };
}

function writeReachableCanonicalSystemctlStub(
  home: string,
  options: {
    active: boolean;
    environmentLeakMarker?: string;
    execStart?: string;
    fragmentPath?: string;
    metadataDiagnostic?: string;
    metadataStatus?: number;
    port: number | null;
    serviceName: string;
  },
) {
  const bin = path.join(home, "reachable-systemctl-bin");
  const log = path.join(home, "reachable-systemctl.log");
  const managerRoot = path.join(home, "manager-unit-root");
  const gatewayBin = "/usr/local/bin/openshell-gateway";
  const execStart =
    options.execStart ??
    (options.port === null
      ? `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`
      : `{ path=${gatewayBin} ; argv[]=${gatewayBin} --port=${options.port} ; }`);
  const fragmentPath = options.fragmentPath ?? path.join(home, `foreign-${options.serviceName}`);
  const metadataStatus = options.metadataStatus ?? 0;
  const leakCheck = options.environmentLeakMarker
    ? [
        'if [[ -n "${NEMOCLAW_TEST_SENTINEL_SECRET:-}" ]]; then',
        `  printf '%s\\n' "$NEMOCLAW_TEST_SENTINEL_SECRET" > ${JSON.stringify(options.environmentLeakMarker)}`,
        "fi",
      ]
    : [];
  fs.mkdirSync(managerRoot, { recursive: true });
  options.active ||
    (() => {
      const activationPath = path.join(managerRoot, "default.target.wants", options.serviceName);
      fs.mkdirSync(path.dirname(activationPath), { recursive: true });
      fs.symlinkSync(path.join(home, `missing-${options.serviceName}`), activationPath);
    })();
  fs.mkdirSync(bin, { recursive: true });
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      ...leakCheck,
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  "--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager")',
      ...(options.active
        ? [
            `    printf '%s\\n' ${JSON.stringify(`${options.serviceName} loaded active running test service`)}`,
          ]
        : []),
      "    ;;",
      `  "--user show ${options.serviceName} --property=ExecStart --property=ActiveState --property=UnitFileState")`,
      ...(metadataStatus === 0
        ? [
            `    printf '%s\\n' ${JSON.stringify(`ExecStart=${execStart}`)}`,
            `    printf '%s\\n' ${JSON.stringify(`ActiveState=${options.active ? "active" : "inactive"}`)}`,
            `    printf '%s\\n' ${JSON.stringify(`UnitFileState=${options.active ? "disabled" : "static"}`)}`,
          ]
        : [
            `    printf '%s\\n' ${JSON.stringify(options.metadataDiagnostic ?? "metadata failed")} >&2`,
            `    exit ${metadataStatus}`,
          ]),
      "    ;;",
      `  "--user show ${options.serviceName} --property=FragmentPath --property=ExecStart --property=ActiveState --property=UnitFileState")`,
      ...(metadataStatus === 0
        ? [
            `    printf '%s\\n' ${JSON.stringify(`FragmentPath=${fragmentPath}`)}`,
            `    printf '%s\\n' ${JSON.stringify(`ExecStart=${execStart}`)}`,
            `    printf '%s\\n' ${JSON.stringify(`ActiveState=${options.active ? "active" : "inactive"}`)}`,
            `    printf '%s\\n' ${JSON.stringify(`UnitFileState=${options.active ? "disabled" : "static"}`)}`,
          ]
        : [
            `    printf '%s\\n' ${JSON.stringify(options.metadataDiagnostic ?? "metadata failed")} >&2`,
            `    exit ${metadataStatus}`,
          ]),
      "    ;;",
      "  *) exit 97 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(bin, "busctl"),
    [
      "#!/usr/bin/env bash",
      ...leakCheck,
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({ type: "as", data: [managerRoot] }))}`,
      "",
    ].join("\n"),
  );
  options.environmentLeakMarker
    ? writeExecutable(
        path.join(bin, "node"),
        [
          "#!/usr/bin/env bash",
          ...leakCheck,
          `exec ${JSON.stringify(process.execPath)} "$@"`,
          "",
        ].join("\n"),
      )
    : undefined;
  return { bin, log };
}

function writeChangedCanonicalIdentitySystemctlStub(
  home: string,
  servicePath: string,
  gatewayBin: string,
  sentinel: string,
) {
  const bin = path.join(home, "changed-identity-systemctl-bin");
  const log = path.join(home, "changed-identity-systemctl.log");
  const stopMarker = path.join(home, "changed-identity-stop");
  const managerRoot = path.join(home, "changed-identity-manager-root");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(managerRoot, { recursive: true });
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  "--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager")',
      "    printf '%s\\n' 'nemoclaw-openshell-gateway.service loaded active running test service'",
      "    ;;",
      '  "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --property=ExecStart --property=ActiveState --property=UnitFileState")',
      `    printf '%s\\n' ${JSON.stringify(`FragmentPath=${servicePath}`)}`,
      `    printf '%s\\n' ${JSON.stringify(`ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`)}`,
      "    printf '%s\\n' 'ActiveState=active'",
      "    printf '%s\\n' 'UnitFileState=disabled'",
      "    ;;",
      '  "--user is-active --quiet nemoclaw-openshell-gateway.service")',
      "    ;;",
      '  "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value")',
      `    printf '%s\\n' ${JSON.stringify(path.join(home, "foreign-" + sentinel + ".service"))}`,
      "    ;;",
      '  "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value")',
      `    printf '%s\\n' ${JSON.stringify(`{ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`)}`,
      "    ;;",
      '  "--user stop nemoclaw-openshell-gateway.service")',
      `    printf 'stopped\\n' > ${JSON.stringify(stopMarker)}`,
      "    ;;",
      "  *) exit 97 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(bin, "busctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' ${JSON.stringify(JSON.stringify({ type: "as", data: [managerRoot] }))}`,
      "",
    ].join("\n"),
  );
  return { bin, log, stopMarker };
}

it.each([
  ["active upstream", "openshell-gateway.service", true],
  ["activation-linked NemoClaw", "nemoclaw-openshell-gateway.service", false],
] as const)(
  "blocks a canonical %s service on the selected custom port (#9705)",
  (_case, serviceName, active) => {
    const home = makeTempRoot();
    const lifecycleMarker = path.join(home, "gateway-lifecycle-effect");
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      port: 18_080,
      serviceName,
    });

    const result = runInstallHelper(
      home,
      [
        "require_no_competing_openshell_gateway_user_service 18080",
        `printf 'changed\\n' > ${JSON.stringify(lifecycleMarker)}`,
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("selected port 18080");
    expect(calls).toContain(`show ${serviceName}`);
    expect(calls).not.toContain("property=Environment");
    expect(fs.existsSync(lifecycleMarker)).toBe(false);
  },
);

it.each([
  ["active upstream", "openshell-gateway.service", true],
  ["activation-linked NemoClaw", "nemoclaw-openshell-gateway.service", false],
] as const)(
  "allows a canonical %s service on a proved different port (#9705)",
  (_case, serviceName, active) => {
    const home = makeTempRoot();
    const lifecycleMarker = path.join(home, "gateway-lifecycle-effect");
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      port: 9090,
      serviceName,
    });

    const result = runInstallHelper(
      home,
      [
        "require_no_competing_openshell_gateway_user_service 18080",
        `printf 'qualified\\n' > ${JSON.stringify(lifecycleMarker)}`,
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls).toContain(`show ${serviceName}`);
    expect(calls).not.toContain("property=Environment");
    expect(fs.readFileSync(lifecycleMarker, "utf-8")).toBe("qualified\n");
  },
);

it.each([
  ["active upstream", "openshell-gateway.service", true],
  ["activation-linked NemoClaw", "nemoclaw-openshell-gateway.service", false],
] as const)(
  "blocks a canonical %s custom-port service with ambiguous port metadata (#9705)",
  (_case, serviceName, active) => {
    const home = makeTempRoot();
    const lifecycleMarker = path.join(home, "gateway-lifecycle-effect");
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      port: null,
      serviceName,
    });

    const result = runInstallHelper(
      home,
      [
        "require_no_competing_openshell_gateway_user_service 18080",
        `printf 'changed\\n' > ${JSON.stringify(lifecycleMarker)}`,
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("ambiguous port configuration");
    expect(fs.existsSync(lifecycleMarker)).toBe(false);
  },
);

it.each([
  ["active upstream", "openshell-gateway.service", true],
  ["activation-linked NemoClaw", "nemoclaw-openshell-gateway.service", false],
] as const)(
  "blocks a canonical %s service whose effective definition is foreign at the default port (#9705)",
  (_case, serviceName, active) => {
    const home = makeTempRoot();
    const lifecycleMarker = path.join(home, "gateway-lifecycle-effect");
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      port: 8080,
      serviceName,
    });

    const result = runInstallHelper(
      home,
      [
        "require_no_competing_openshell_gateway_user_service 8080",
        `printf 'changed\\n' > ${JSON.stringify(lifecycleMarker)}`,
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("selected port 8080");
    expect(result.stderr).not.toContain("foreign-");
    expect(calls).toContain(`show ${serviceName} --property=FragmentPath`);
    expect(calls).not.toContain("property=Environment");
    expect(fs.existsSync(lifecycleMarker)).toBe(false);
  },
);

it.each([
  ["active upstream", "openshell-gateway.service", true],
  ["activation-linked NemoClaw", "nemoclaw-openshell-gateway.service", false],
] as const)(
  "allows an independent canonical %s service on a proved different port (#9705)",
  (_case, serviceName, active) => {
    const home = makeTempRoot();
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      port: 9090,
      serviceName,
    });

    const result = runInstallHelper(
      home,
      "require_no_competing_openshell_gateway_user_service 8080",
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);

it.each([
  [
    "a foreign binary",
    (home: string) => {
      const foreignBin = path.join(home, "foreign", "openshell-gateway");
      fs.mkdirSync(path.dirname(foreignBin), { recursive: true });
      writeExecutable(foreignBin, "#!/usr/bin/env bash\nexit 0\n");
      return `{ path=${foreignBin} ; argv[]=${foreignBin} ; }`;
    },
  ],
  [
    "an executable wrapper",
    () => "{ path=/usr/bin/env ; argv[]=/usr/bin/env /usr/local/bin/openshell-gateway ; }",
  ],
  [
    "additional arguments",
    () =>
      "{ path=/usr/local/bin/openshell-gateway ; argv[]=/usr/local/bin/openshell-gateway --port 8080 ; }",
  ],
  [
    "duplicate argument records",
    () =>
      "{ path=/usr/local/bin/openshell-gateway ; argv[]=/usr/local/bin/openshell-gateway ; argv[]=/usr/local/bin/openshell-gateway ; }",
  ],
] as const)(
  "blocks a descriptor-bound canonical service with %s (#9705)",
  (_case, makeExecStart) => {
    const home = makeTempRoot();
    const servicePath = path.join(
      home,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active: true,
      execStart: makeExecStart(home),
      fragmentPath: servicePath,
      port: null,
      serviceName: "nemoclaw-openshell-gateway.service",
    });

    const result = runInstallHelper(
      home,
      "require_no_competing_openshell_gateway_user_service 8080",
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("NemoClaw did not change this service");
    expect(result.stderr).not.toContain("argv[]");
  },
);

it("allows a descriptor-bound NemoClaw service at the default port (#9705)", () => {
  const home = makeTempRoot();
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const servicePath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(servicePath, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
  const systemctl = writeReachableCanonicalSystemctlStub(home, {
    active: true,
    execStart: `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`,
    fragmentPath: servicePath,
    port: null,
    serviceName: "nemoclaw-openshell-gateway.service",
  });

  const result = runInstallHelper(
    home,
    "require_no_competing_openshell_gateway_user_service 8080",
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("allows a package-qualified upstream service at the default port (#9705)", () => {
  const home = makeTempRoot();
  const gatewayBin = path.join(home, "usr", "bin", "openshell-gateway");
  const servicePath = path.join(home, "usr", "lib", "systemd", "user", "openshell-gateway.service");
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(servicePath, "[Service]\n");
  const systemctl = writeReachableCanonicalSystemctlStub(home, {
    active: true,
    execStart: `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`,
    fragmentPath: servicePath,
    port: null,
    serviceName: "openshell-gateway.service",
  });

  const result = runInstallHelper(
    home,
    [
      `trusted_upstream_openshell_gateway_unit_for_service() { [[ "$1" == ${JSON.stringify(servicePath)} ]]; }`,
      `trusted_upstream_openshell_gateway_bin_for_service() { [[ "$1" == ${JSON.stringify(gatewayBin)} ]]; }`,
      "require_no_competing_openshell_gateway_user_service 8080",
    ].join("\n"),
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it.each([
  ["active", true],
  ["activation-linked", false],
] as const)(
  "redacts child output when %s canonical metadata cannot be read (#9705)",
  (_case, active) => {
    const home = makeTempRoot();
    const sentinel = "tenant-secret-gateway-token";
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active,
      metadataDiagnostic: sentinel,
      metadataStatus: 98,
      port: null,
      serviceName: "openshell-gateway.service",
    });

    const result = runInstallHelper(
      home,
      "require_no_competing_openshell_gateway_user_service 8080",
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("metadata query for openshell-gateway.service failed");
    expect(result.stderr).not.toContain(sentinel);
  },
);

it("removes unrelated installer values from service-inspection children (#9705)", () => {
  const home = makeTempRoot();
  const leakMarker = path.join(home, "service-child-environment-leak");
  const systemctl = writeReachableCanonicalSystemctlStub(home, {
    active: true,
    environmentLeakMarker: leakMarker,
    port: 9090,
    serviceName: "openshell-gateway.service",
  });

  const result = runInstallHelper(
    home,
    "require_no_competing_openshell_gateway_user_service 8080",
    {
      NEMOCLAW_TEST_SENTINEL_SECRET: "tenant-secret-child-environment",
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    },
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(fs.existsSync(leakMarker)).toBe(false);
});

it("re-reads canonical identity immediately before a lifecycle mutation (#9705)", () => {
  const home = makeTempRoot();
  const sentinel = "tenant-secret-changed-fragment";
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const servicePath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(servicePath, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
  const systemctl = writeChangedCanonicalIdentitySystemctlStub(
    home,
    servicePath,
    gatewayBin,
    sentinel,
  );

  const result = runInstallHelper(
    home,
    [
      "require_no_competing_openshell_gateway_user_service 8080",
      "stop_nemoclaw_openshell_gateway_user_service",
    ].join("\n"),
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );
  const calls = fs.readFileSync(systemctl.log, "utf-8");

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("trusted lifecycle target");
  expect(result.stderr).not.toContain(sentinel);
  expect(calls).toContain(
    "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
  );
  expect(calls).not.toContain("--user stop nemoclaw-openshell-gateway.service");
  expect(fs.existsSync(systemctl.stopMarker)).toBe(false);
});

it("blocks offline canonical activation before legacy retirement (#9705)", () => {
  const home = makeTempRoot();
  const activationPath = createCanonicalActivation(home, path.join(home, ".config"));
  const retirementMarker = path.join(home, "legacy-retirement");
  const systemctl = writeUnavailableSystemctlStub(home);

  const result = runInstallHelper(
    home,
    [
      "require_no_competing_openshell_gateway_user_service 8080",
      `printf 'retired\\n' > ${JSON.stringify(retirementMarker)}`,
    ].join("\n"),
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(activationPath);
  expect(fs.existsSync(retirementMarker)).toBe(false);
  expect(fs.readFileSync(systemctl.log, "utf-8").trim()).toBe(
    "--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager",
  );
  expect(fs.existsSync(systemctl.busctlLog)).toBe(false);
});

it("escapes a canonical activation path in the offline qualification diagnostic (#9705)", () => {
  const home = makeTempRoot();
  const configHome = path.join(home, "config\ninjected\u001b\u202e");
  const activationPath = createCanonicalActivation(home, configHome);
  const systemctl = writeUnavailableSystemctlStub(home);

  const result = runInstallHelper(
    home,
    "require_no_competing_openshell_gateway_user_service 8080",
    {
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
      XDG_CONFIG_HOME: configHome,
    },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("config\\ninjected");
  expect(result.stderr).toContain("\\u001b\\u202e");
  expect(result.stderr).toContain("openshell-gateway.service");
  expect(result.stderr).not.toContain(activationPath);
  expect(result.stderr).not.toContain("\ninjected");
  expect(result.stderr).not.toContain("\u001b");
  expect(result.stderr).not.toContain("\u202e");
});

it("stops when a canonical activation path cannot be rendered (#9705)", () => {
  const home = makeTempRoot();
  const activationPath = createCanonicalActivation(home, path.join(home, ".config"));
  const lifecycleMarker = path.join(home, "lifecycle-effect");
  const systemctl = writeUnavailableSystemctlStub(home);
  writeExecutable(path.join(systemctl.bin, "node"), "#!/usr/bin/env bash\nexit 1\n");

  const result = runInstallHelper(
    home,
    [
      "require_no_competing_openshell_gateway_user_service 8080",
      `printf 'changed\\n' > ${JSON.stringify(lifecycleMarker)}`,
    ].join("\n"),
    { PATH: `${systemctl.bin}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("could not safely render");
  expect(result.stderr).not.toContain(activationPath);
  expect(fs.existsSync(lifecycleMarker)).toBe(false);
});

it("escapes a canonical activation path in the standalone fallback diagnostic (#9705)", () => {
  const home = makeTempRoot();
  const configHome = path.join(home, "config\ninjected\u001b\u202e");
  const activationPath = createCanonicalActivation(home, configHome);

  const result = runInstallHelper(
    home,
    [
      "inspect_noncanonical_openshell_gateway_user_services() { return 0; }",
      "upstream_openshell_gateway_user_service_installed() { return 0; }",
      "require_compatible_upstream_openshell_gateway_service() { return 2; }",
      "install_nemoclaw_openshell_gateway_user_service",
    ].join("\n"),
    { XDG_CONFIG_HOME: configHome },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("config\\ninjected");
  expect(result.stderr).toContain("\\u001b\\u202e");
  expect(result.stderr).toContain("openshell-gateway.service");
  expect(result.stderr).not.toContain(activationPath);
  expect(result.stderr).not.toContain("\ninjected");
  expect(result.stderr).not.toContain("\u001b");
  expect(result.stderr).not.toContain("\u202e");
});
