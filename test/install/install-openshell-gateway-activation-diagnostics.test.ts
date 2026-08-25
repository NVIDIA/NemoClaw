// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  makeInstallerGatewayTempRoot,
  runInstallerGatewayServiceBody as runInstallHelper,
  SYSTEMD_CANONICAL_PROPERTIES,
  SYSTEMD_IDENTITY_PROPERTIES,
  systemdPropertyArgs,
  writeManagedGatewayUnit,
} from "../helpers/installer-gateway-service-fixture";
import { TEST_SYSTEM_PATH, writeExecutable } from "../helpers/installer-sourced-env";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = makeInstallerGatewayTempRoot("nemoclaw-gateway-activation-diagnostic-");
  tempRoots.push(root);
  return root;
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
    identityOverrides?: Partial<Record<(typeof SYSTEMD_IDENTITY_PROPERTIES)[number], string>>;
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
  const serviceGatewayBin = execStart.match(/(?:^|[ ;{])path=([^ ;}]+)/u)?.[1] ?? gatewayBin;
  const tlsDirectory = "$" + "{OPENSHELL_LOCAL_TLS_DIR}";
  const identityMetadata = {
    FragmentPath: fragmentPath,
    ExecStart: execStart,
    DropInPaths: "",
    ExecCondition: "",
    ExecStartPre:
      options.serviceName === "nemoclaw-openshell-gateway.service"
        ? `{ path=${serviceGatewayBin} ; argv[]=${serviceGatewayBin} generate-certs --output-dir ${tlsDirectory} --server-san host.openshell.internal ; ignore_errors=no ; }`
        : "",
    ExecStartPost: "",
    ExecReload: "",
    ExecStop: "",
    ExecStopPost: "",
    ActiveState: options.active ? "active" : "inactive",
    UnitFileState: options.active ? "disabled" : "static",
    ...options.identityOverrides,
  };
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
      "OPENSHELL_LOCAL_TLS_DIR='${OPENSHELL_LOCAL_TLS_DIR}'",
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
      `  "--user show ${options.serviceName} --all --property=ExecStart --property=ActiveState --property=UnitFileState")`,
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
      `  "--user show ${options.serviceName} --all ${systemdPropertyArgs(SYSTEMD_CANONICAL_PROPERTIES)}")`,
      ...(metadataStatus === 0
        ? SYSTEMD_CANONICAL_PROPERTIES.map(
            (property) =>
              `    printf '%s\\n' ${JSON.stringify(`${property}=${identityMetadata[property]}`)}`,
          )
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
  options: { changeAfterSnapshots?: number; stopDiagnostic?: string; stopStatus?: number } = {},
) {
  const bin = path.join(home, "changed-identity-systemctl-bin");
  const log = path.join(home, "changed-identity-systemctl.log");
  const stopMarker = path.join(home, "changed-identity-stop");
  const snapshotCount = path.join(home, "changed-identity-snapshot-count");
  const managerRoot = path.join(home, "changed-identity-manager-root");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(managerRoot, { recursive: true });
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      "OPENSHELL_LOCAL_TLS_DIR='${OPENSHELL_LOCAL_TLS_DIR}'",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  "--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager")',
      "    printf '%s\\n' 'nemoclaw-openshell-gateway.service loaded active running test service'",
      "    ;;",
      `  "--user show nemoclaw-openshell-gateway.service --all ${systemdPropertyArgs(SYSTEMD_CANONICAL_PROPERTIES)}" | "--user show nemoclaw-openshell-gateway.service --all ${systemdPropertyArgs(SYSTEMD_IDENTITY_PROPERTIES)}")`,
      `    count=$(($(cat ${JSON.stringify(snapshotCount)} 2>/dev/null || printf 0) + 1))`,
      `    printf '%s\\n' "$count" > ${JSON.stringify(snapshotCount)}`,
      `    if [[ "$count" -le ${options.changeAfterSnapshots ?? 2} ]]; then fragment=${JSON.stringify(servicePath)}; else fragment=${JSON.stringify(path.join(home, "foreign-" + sentinel + ".service"))}; fi`,
      "    printf 'FragmentPath=%s\\n' \"$fragment\"",
      `    printf '%s\\n' ${JSON.stringify(`ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`)}`,
      `    printf '%s\\n' 'DropInPaths=' 'ExecCondition=' ${JSON.stringify(`ExecStartPre={ path=${gatewayBin} ; argv[]=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal ; ignore_errors=no ; }`)} 'ExecStartPost=' 'ExecReload=' 'ExecStop=' 'ExecStopPost='`,
      '    if [[ "$*" == *--property=ActiveState* ]]; then',
      "      printf '%s\\n' 'ActiveState=active' 'UnitFileState=disabled'",
      "    fi",
      "    ;;",
      '  "--user is-active --quiet nemoclaw-openshell-gateway.service")',
      "    ;;",
      '  "--user stop nemoclaw-openshell-gateway.service")',
      ...(options.stopStatus
        ? [
            `    printf '%s\\n' ${JSON.stringify(options.stopDiagnostic ?? "stop failed")} >&2`,
            `    exit ${options.stopStatus}`,
          ]
        : [`    printf 'stopped\\n' > ${JSON.stringify(stopMarker)}`]),
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
    expect(calls).toContain(`show ${serviceName} --all --property=FragmentPath`);
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
  writeManagedGatewayUnit(servicePath, gatewayBin);
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

it.each(["ExecStart", "ExecStartPre"] as const)(
  "blocks %s metadata that ignores command errors (#9705)",
  (property) => {
    const home = makeTempRoot();
    const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
    const unitPath = path.join(
      home,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    writeManagedGatewayUnit(unitPath, gatewayBin);
    const tlsDirectory = "$" + "{OPENSHELL_LOCAL_TLS_DIR}";
    const systemctl = writeReachableCanonicalSystemctlStub(home, {
      active: true,
      execStart: `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=${property === "ExecStart" ? "yes" : "no"} ; }`,
      fragmentPath: unitPath,
      identityOverrides:
        property === "ExecStartPre"
          ? {
              ExecStartPre: `{ path=${gatewayBin} ; argv[]=${gatewayBin} generate-certs --output-dir ${tlsDirectory} --server-san host.openshell.internal ; ignore_errors=yes ; }`,
            }
          : undefined,
      port: null,
      serviceName: "nemoclaw-openshell-gateway.service",
    });

    const result = runInstallHelper(
      home,
      "require_no_competing_openshell_gateway_user_service 8080",
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("ignore_errors");
  },
);

it.each([
  [
    "an injected environment directive",
    (contents: string) =>
      contents.replace("[Service]\n", "[Service]\nEnvironment=LD_PRELOAD=/tenant-secret.so\n"),
  ],
  [
    "a duplicate command directive",
    (contents: string) => contents.replace("ExecStart=", "ExecStart=/tenant-secret\nExecStart="),
  ],
] as const)("blocks a managed descriptor with %s (#9705)", (_case, transform) => {
  const home = makeTempRoot();
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const unitPath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  writeManagedGatewayUnit(unitPath, gatewayBin, transform);
  const systemctl = writeReachableCanonicalSystemctlStub(home, {
    active: true,
    execStart: `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; ignore_errors=no ; }`,
    fragmentPath: unitPath,
    port: null,
    serviceName: "nemoclaw-openshell-gateway.service",
  });

  const result = runInstallHelper(
    home,
    "require_no_competing_openshell_gateway_user_service 8080",
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("tenant-secret");
});

it.each([
  ["a drop-in", "DropInPaths"],
  ["a condition", "ExecCondition"],
  ["a start-pre hook", "ExecStartPre"],
  ["a start-post hook", "ExecStartPost"],
  ["a reload hook", "ExecReload"],
  ["a stop hook", "ExecStop"],
  ["a stop-post hook", "ExecStopPost"],
] as const)("blocks a descriptor-bound service that has %s (#9705)", (_case, property) => {
  const home = makeTempRoot();
  const sentinel = "tenant-secret-service-hook";
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const unitPath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  writeManagedGatewayUnit(unitPath, gatewayBin);
  const systemctl = writeReachableCanonicalSystemctlStub(home, {
    active: true,
    execStart: `{ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
    fragmentPath: unitPath,
    identityOverrides: { [property]: sentinel },
    port: null,
    serviceName: "nemoclaw-openshell-gateway.service",
  });

  const result = runInstallHelper(
    home,
    "require_no_competing_openshell_gateway_user_service 8080",
    { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );

  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).not.toContain(sentinel);
  expect(fs.readFileSync(systemctl.log, "utf-8")).toContain(`--property=${property}`);
});

it.each([
  ["a descriptor symlink", false, true],
  ["a descriptor with a different owner", false, false],
  ["an executable symlink", true, true],
  ["an executable with a different owner", true, false],
] as const)("rejects %s during service identity binding (#9705)", (_case, executable, symlink) => {
  const home = makeTempRoot();
  const target = path.join(home, executable ? "gateway-target" : "service-target");
  const candidate = symlink ? path.join(home, "identity-link") : target;
  writeExecutable(
    target,
    executable ? "#!/usr/bin/env bash\nexit 0\n" : "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n",
  );
  symlink ? fs.symlinkSync(target, candidate) : undefined;
  const expectedUid = symlink ? "$EUID" : "$((EUID + 1))";
  const marker = executable ? "" : "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";

  const result = runInstallHelper(
    home,
    [
      `if trusted_gateway_service_file_identity ${JSON.stringify(candidate)} ${expectedUid} ${JSON.stringify(marker)} ${executable ? "true" : "false"}; then`,
      "  exit 90",
      "fi",
    ].join("\n"),
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it.each([
  ["a group-writable descriptor", false, 0o664],
  ["a group-writable executable", true, 0o775],
] as const)("rejects %s during service identity binding (#9705)", (_case, executable, mode) => {
  const home = makeTempRoot();
  const candidate = path.join(home, executable ? "gateway-target" : "service-target");
  const marker = executable ? "" : "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1";
  writeExecutable(candidate, executable ? "#!/usr/bin/env bash\nexit 0\n" : `${marker}\n`);
  fs.chmodSync(candidate, mode);

  const result = runInstallHelper(
    home,
    [
      `if trusted_gateway_service_file_identity ${JSON.stringify(candidate)} "$EUID" ${JSON.stringify(marker)} ${executable ? "true" : "false"}; then`,
      "  exit 90",
      "fi",
    ].join("\n"),
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("changes a service executable identity after same-inode content replacement (#9705)", () => {
  const home = makeTempRoot();
  const executablePath = path.join(home, "openshell-gateway");
  writeExecutable(executablePath, "#!/usr/bin/env bash\nexit 0\n");
  const descriptor = fs.openSync(executablePath, "r+");
  const inodeBefore = fs.fstatSync(descriptor).ino;
  const inspect = () =>
    runInstallHelper(
      home,
      `trusted_gateway_service_file_identity ${JSON.stringify(executablePath)} "$EUID" "" true`,
    );

  try {
    const first = inspect();
    fs.ftruncateSync(descriptor, 0);
    fs.writeSync(descriptor, "#!/usr/bin/env bash\nexit 1\n", 0, "utf8");
    fs.fchmodSync(descriptor, 0o755);
    const inodeAfter = fs.fstatSync(descriptor).ino;
    const second = inspect();

    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(inodeAfter).toBe(inodeBefore);
    expect(second.stdout).not.toBe(first.stdout);
  } finally {
    fs.closeSync(descriptor);
  }
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
      "trusted_gateway_service_file_identity() { printf '7:1\\n'; }",
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

it("removes unrelated installer values from version and Homebrew probes (#9705)", () => {
  const home = makeTempRoot();
  const bin = path.join(home, "probe-bin");
  const leakMarker = path.join(home, "probe-child-environment-leak");
  const gatewayBin = path.join(bin, "openshell-gateway");
  fs.mkdirSync(bin, { recursive: true });
  const probeBody = [
    "#!/usr/bin/env bash",
    'if [[ -n "${NEMOCLAW_TEST_SENTINEL_SECRET:-}" ]]; then',
    `  printf '%s\\n' "$NEMOCLAW_TEST_SENTINEL_SECRET" > ${JSON.stringify(leakMarker)}`,
    "fi",
  ];
  writeExecutable(gatewayBin, [...probeBody, "printf 'openshell 0.0.85\\n'", ""].join("\n"));
  writeExecutable(
    path.join(bin, "brew"),
    [
      ...probeBody,
      'if [[ "$*" == "info --json=v2 openshell" ]]; then',
      '  printf \'%s\\n\' \'{"formulae":[{"name":"openshell","tap":"nvidia/openshell"}]}\'',
      "fi",
      "",
    ].join("\n"),
  );

  const result = runInstallHelper(
    home,
    [
      "uname() { printf 'Darwin\\n'; }",
      `openshell_binary_version ${JSON.stringify(gatewayBin)}`,
      "macos_openshell_homebrew_gateway_service_installed",
    ].join("\n"),
    {
      NEMOCLAW_TEST_SENTINEL_SECRET: "tenant-secret-probe-environment",
      PATH: `${bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    },
  );

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("0.0.85");
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
  writeManagedGatewayUnit(servicePath, gatewayBin);
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
  expect(result.stderr).toContain("effective service identity changed before the stop command");
  expect(result.stderr).not.toContain(sentinel);
  expect(calls).toContain(
    `--user show nemoclaw-openshell-gateway.service --all ${systemdPropertyArgs(SYSTEMD_IDENTITY_PROPERTIES)}`,
  );
  expect(calls).not.toContain("--user stop nemoclaw-openshell-gateway.service");
  expect(fs.existsSync(systemctl.stopMarker)).toBe(false);
});

it("redacts child output when the trusted service stop command fails (#9705)", () => {
  const home = makeTempRoot();
  const sentinel = "tenant-secret-stop-diagnostic";
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const unitPath = path.join(
    home,
    ".config",
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
  writeManagedGatewayUnit(unitPath, gatewayBin);
  const systemctl = writeChangedCanonicalIdentitySystemctlStub(
    home,
    unitPath,
    gatewayBin,
    sentinel,
    { changeAfterSnapshots: 99, stopDiagnostic: sentinel, stopStatus: 98 },
  );

  const result = runInstallHelper(home, "stop_nemoclaw_openshell_gateway_user_service", {
    PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not stop the trusted NemoClaw OpenShell gateway");
  expect(result.stderr).not.toContain(sentinel);
  expect(result.stdout).not.toContain(sentinel);
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
