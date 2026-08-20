// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, type Mock, vi } from "vitest";

import {
  classifyOpenShellGatewayServiceMetadata,
  type OpenShellGatewayServiceMetadataVerdict,
} from "./openshell-service-coexistence";
import {
  assertNoCompetingOpenShellGatewayUserService,
  getOpenShellUserConfigHome,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
  OPENSHELL_GATEWAY_USER_SERVICE,
  OpenShellGatewayServiceTrustError,
  stopOpenShellGatewayUserService,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
} from "../docker-driver-gateway-service";

const TRUSTED_GATEWAY = "/usr/local/bin/openshell-gateway";
const TRUSTED_GATEWAY_PATHS = [
  TRUSTED_GATEWAY,
  "/usr/bin/openshell-gateway",
  "/home/nvidia/.local/bin/openshell-gateway",
];

it("does not trim a leading space from XDG_CONFIG_HOME (#9705)", () => {
  expect(getOpenShellUserConfigHome("/home/nvidia", { XDG_CONFIG_HOME: " /opt/config-home" })).toBe(
    "/home/nvidia/.config",
  );
});

function showOutput(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `ExecStart=${
      overrides.ExecStart ?? `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port 8080 ; }`
    }`,
    `ActiveState=${overrides.ActiveState ?? "active"}`,
    `UnitFileState=${overrides.UnitFileState ?? "disabled"}`,
  ].join("\n");
}

function classify(
  overrides: Partial<Record<string, string>> = {},
  gatewayPort = 8080,
  enabledByActivationPath = false,
): OpenShellGatewayServiceMetadataVerdict {
  return classifyOpenShellGatewayServiceMetadata({
    enabledByActivationPath,
    gatewayPort,
    metadata: showOutput(overrides),
    trustedExecutablePaths: TRUSTED_GATEWAY_PATHS,
  });
}

it.each([
  ["active", { ActiveState: "active", UnitFileState: "disabled" }],
  ["activating", { ActiveState: "activating", UnitFileState: "disabled" }],
  ["reloading", { ActiveState: "reloading", UnitFileState: "disabled" }],
  ["deactivating", { ActiveState: "deactivating", UnitFileState: "disabled" }],
  ["enabled", { ActiveState: "inactive", UnitFileState: "enabled" }],
  ["enabled for this boot", { ActiveState: "inactive", UnitFileState: "enabled-runtime" }],
])(
  "blocks an OpenShell gateway service that is %s on the selected port (#9705)",
  (_case, state) => {
    expect(classify(state)).toBe("block-selected-port");
  },
);

it("ignores a service that is neither active nor enabled (#9705)", () => {
  expect(classify({ ActiveState: "inactive", UnitFileState: "disabled" })).toBe("unrelated");
});

it.each(["disabled", "generated", "static"])(
  "blocks an inactive %s gateway linked from an activation path (#9705)",
  (unitFileState) => {
    expect(classify({ ActiveState: "inactive", UnitFileState: unitFileState }, 8080, true)).toBe(
      "block-selected-port",
    );
  },
);

it.each([
  ["empty executable metadata", { ExecStart: "", UnitFileState: "static" }],
  [
    "a missing effective unit",
    { ExecStart: "", ActiveState: "inactive", UnitFileState: "not-found" },
  ],
])("blocks an activation-linked service with %s (#9705)", (_case, metadata) => {
  expect(classify({ ActiveState: "inactive", ...metadata }, 8080, true)).toBe(
    "block-ambiguous-executable",
  );
});

it("ignores an active marker service with no executable (#9705)", () => {
  expect(classify({ ActiveState: "active", ExecStart: "" }, 18_080)).toBe("unrelated");
});

it("blocks an enabled service with unparseable executable metadata (#9705)", () => {
  expect(
    classify({ ActiveState: "inactive", ExecStart: "truncated", UnitFileState: "enabled" }, 18_080),
  ).toBe("block-ambiguous-executable");
});

it.each([
  ["has no command port", `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} ; }`],
  [
    "has a nonnumeric command port",
    `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port invalid ; }`,
  ],
  [
    "has an out-of-range command port",
    `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port=65536 ; }`,
  ],
  [
    "has duplicate command ports",
    `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port=8080 --port 9090 ; }`,
  ],
  ["has no command arguments", `{ path=${TRUSTED_GATEWAY} ; }`],
])("blocks a gateway that %s as an ambiguous port candidate (#9705)", (_case, execStart) => {
  expect(classify({ ExecStart: execStart })).toBe("block-ambiguous-port");
});

it.each([
  ["a separate argument", `argv[]=${TRUSTED_GATEWAY} --port 9090`],
  ["an equals argument", `argv[]=${TRUSTED_GATEWAY} --port=9090`],
])("accepts a unique port from %s (#9705)", (_case, argv) => {
  expect(classify({ ExecStart: `{ path=${TRUSTED_GATEWAY} ; ${argv} ; }` })).toBe("different-port");
});

it("ignores an unrelated executable even when its arguments name the selected port (#9705)", () => {
  expect(
    classify({
      ExecStart: "{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 --port 8080 ; }",
    }),
  ).toBe("unrelated");
});

it("blocks an untrusted OpenShell executable before accepting another port (#9705)", () => {
  expect(
    classify({
      ExecStart:
        "{ path=/opt/openshell/bin/openshell-gateway ; argv[]=/opt/openshell/bin/openshell-gateway --port 9090 ; }",
    }),
  ).toBe("block-untrusted-executable");
});

it.each([
  ["a relative executable", "{ path=openshell-gateway ; argv[]=openshell-gateway --port 8080 ; }"],
  ["multiple executable paths", `{ path=${TRUSTED_GATEWAY} ; }; { path=${TRUSTED_GATEWAY} ; }`],
  [
    "an env-wrapped gateway",
    "{ path=/usr/bin/env ; argv[]=/usr/bin/env openshell-gateway --port 8080 ; }",
  ],
  [
    "a shell-wrapped gateway",
    "{ path=/bin/sh ; argv[]=/bin/sh -c /usr/local/bin/openshell-gateway --port 8080 ; }",
  ],
])("blocks %s as ambiguous executable metadata (#9705)", (_case, execStart) => {
  expect(classify({ ExecStart: execStart })).toBe("block-ambiguous-executable");
});

it.each([
  ["a missing property", `ExecStart={ path=${TRUSTED_GATEWAY} ; }\nActiveState=active`],
  ["a duplicate property", `${showOutput()}\nActiveState=active`],
  ["an unexpected property", `${showOutput()}\nEnvironment=API_TOKEN=do-not-read-this`],
  ["an unknown active state", showOutput({ ActiveState: "unknown" })],
  ["an unknown unit-file state", showOutput({ UnitFileState: "unknown" })],
])("blocks metadata with %s (#9705)", (_case, metadata) => {
  expect(
    classifyOpenShellGatewayServiceMetadata({
      enabledByActivationPath: false,
      gatewayPort: 8080,
      metadata,
      trustedExecutablePaths: TRUSTED_GATEWAY_PATHS,
    }),
  ).toBe("block-malformed-metadata");
});

it("blocks an invalid selected port (#9705)", () => {
  expect(
    classifyOpenShellGatewayServiceMetadata({
      enabledByActivationPath: false,
      gatewayPort: Number.NaN,
      metadata: showOutput(),
      trustedExecutablePaths: TRUSTED_GATEWAY_PATHS,
    }),
  ).toBe("block-invalid-selected-port");
});

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

function competingServiceSpawn({
  active = [],
  activeRows,
  metadata = {},
  unitPathOutput,
  unitPaths = ["/home/nvidia/.config/systemd/user"],
  unitPathStatus = 0,
}: {
  active?: string[];
  activeRows?: string[];
  metadata?: Record<string, string>;
  unitPathOutput?: string;
  unitPaths?: string[];
  unitPathStatus?: number;
}): Mock<SpawnSyncLike> {
  return vi.fn<SpawnSyncLike>((command, args) =>
    command === "busctl"
      ? spawnResult(
          unitPathStatus,
          unitPathStatus === 0 ? "" : (unitPathOutput ?? ""),
          unitPathStatus === 0
            ? (unitPathOutput ?? JSON.stringify({ type: "as", data: unitPaths }))
            : "",
        )
      : args.includes("list-units")
        ? spawnResult(
            0,
            "",
            (
              activeRows ?? active.map((service) => `${service} loaded active running Test service`)
            ).join("\n"),
          )
        : args.includes("show")
          ? spawnResult(0, "", metadata[args[args.indexOf("show") + 1] ?? ""] ?? "")
          : spawnResult(1, "unexpected systemctl command"),
  );
}

function activationScanOptions(
  serviceNames: readonly string[] = [],
  userRoot = "/home/nvidia/.config/systemd/user",
) {
  const home = "/home/nvidia";
  const activationDirectory = `${userRoot}/default.target.wants`;
  const readdirSync = vi.fn((candidate: string) =>
    candidate === userRoot
      ? [
          {
            isDirectory: () => true,
            isSymbolicLink: () => false,
            name: "default.target.wants",
          },
        ]
      : candidate === activationDirectory
        ? [...serviceNames]
        : [],
  );
  const lstatSync = vi.fn(() => {
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  });
  return {
    activationDirectory,
    options: {
      env: { HOME: home },
      existsSync: () => false,
      home,
      lstatSync: lstatSync as never,
      readdirSync: readdirSync as never,
    },
    readdirSync,
  };
}

it("excludes canonical services before a default-port metadata query (#9705)", () => {
  const unrelated = "unrelated.service";
  const activation = activationScanOptions([`${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`]);
  const spawnSyncImpl = competingServiceSpawn({
    active: [`${OPENSHELL_GATEWAY_USER_SERVICE}.service`, unrelated],
    metadata: {
      [unrelated]: showOutput({
        ExecStart: "{ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep infinity ; }",
      }),
    },
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).not.toThrow();
  const showCalls = spawnSyncImpl.mock.calls.filter(([, args]) => args.includes("show"));
  expect(showCalls).toHaveLength(1);
  expect(showCalls[0]?.[1]).toContain(unrelated);
  expect(showCalls[0]?.[1]).not.toContain("--property=Environment");
  expect(spawnSyncImpl.mock.calls.map(([, , options]) => options?.timeout)).toEqual([
    10_000, 10_000, 10_000,
  ]);
  expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("list-unit-files"))).toBe(false);
});

it.each([
  ["active upstream", `${OPENSHELL_GATEWAY_USER_SERVICE}.service`, true],
  ["activation-linked NemoClaw", `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`, false],
])(
  "blocks a canonical %s service on the selected custom port (#9705)",
  (_case, serviceName, active) => {
    const activation = activationScanOptions(active ? [] : [serviceName]);
    const spawnSyncImpl = competingServiceSpawn({
      active: active ? [serviceName] : [],
      metadata: {
        [serviceName]: showOutput({
          ActiveState: active ? "active" : "inactive",
          ExecStart: `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port=18080 ; }`,
          UnitFileState: active ? "disabled" : "static",
        }),
      },
    });

    expect(() =>
      assertNoCompetingOpenShellGatewayUserService(18_080, {
        ...activation.options,
        commandExists: () => true,
        platform: "linux",
        spawnSyncImpl,
      }),
    ).toThrow("selected port 18080");
    const showCall = spawnSyncImpl.mock.calls.find(([, args]) => args.includes("show"));
    expect(showCall?.[1]).toContain(serviceName);
    expect(showCall?.[1]).not.toContain("--property=Environment");
  },
);

it.each([
  ["active upstream", `${OPENSHELL_GATEWAY_USER_SERVICE}.service`, true],
  ["activation-linked NemoClaw", `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`, false],
])(
  "allows a canonical %s service on a proved different port (#9705)",
  (_case, serviceName, active) => {
    const activation = activationScanOptions(active ? [] : [serviceName]);
    const spawnSyncImpl = competingServiceSpawn({
      active: active ? [serviceName] : [],
      metadata: {
        [serviceName]: showOutput({
          ActiveState: active ? "active" : "inactive",
          ExecStart: `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port=9090 ; }`,
          UnitFileState: active ? "disabled" : "static",
        }),
      },
    });

    expect(() =>
      assertNoCompetingOpenShellGatewayUserService(18_080, {
        ...activation.options,
        commandExists: () => true,
        platform: "linux",
        spawnSyncImpl,
      }),
    ).not.toThrow();
    const showCall = spawnSyncImpl.mock.calls.find(([, args]) => args.includes("show"));
    expect(showCall?.[1]).toContain(serviceName);
    expect(showCall?.[1]).not.toContain("--property=Environment");
  },
);

it.each([
  ["active upstream", `${OPENSHELL_GATEWAY_USER_SERVICE}.service`, true],
  ["activation-linked NemoClaw", `${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`, false],
])(
  "blocks a canonical %s custom-port service with ambiguous port metadata (#9705)",
  (_case, serviceName, active) => {
    const activation = activationScanOptions(active ? [] : [serviceName]);
    const spawnSyncImpl = competingServiceSpawn({
      active: active ? [serviceName] : [],
      metadata: {
        [serviceName]: showOutput({
          ActiveState: active ? "active" : "inactive",
          ExecStart: `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} ; }`,
          UnitFileState: active ? "disabled" : "static",
        }),
      },
    });

    expect(() =>
      assertNoCompetingOpenShellGatewayUserService(18_080, {
        ...activation.options,
        commandExists: () => true,
        platform: "linux",
        spawnSyncImpl,
      }),
    ).toThrow("ambiguous port configuration");
    const showCall = spawnSyncImpl.mock.calls.find(([, args]) => args.includes("show"));
    expect(showCall?.[1]).not.toContain("--property=Environment");
  },
);

it("retains the fixed-name activation scan when the user manager is unavailable (#9705)", () => {
  const serviceName = `${OPENSHELL_GATEWAY_USER_SERVICE}.service`;
  const activation = activationScanOptions([serviceName]);
  const activationPath = `${activation.activationDirectory}/${serviceName}`;

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    }),
  ).toThrow(activationPath);
});

it("escapes a canonical activation path in the offline qualification diagnostic (#9705)", () => {
  const home = "/home/nvidia";
  const userRoot = `${home}/.config/systemd/user`;
  const activationDirectory = `${userRoot}/default.target\ninjected\u001b\u202e.wants`;
  const serviceName = `${OPENSHELL_GATEWAY_USER_SERVICE}.service`;
  const readdirSync = vi.fn((candidate: string) =>
    candidate === userRoot
      ? [
          {
            isDirectory: () => true,
            isSymbolicLink: () => false,
            name: "default.target\ninjected\u001b\u202e.wants",
          },
        ]
      : candidate === activationDirectory
        ? [serviceName]
        : [],
  );

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: home },
      home,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("default.target\\ninjected\\u001b\\u202e.wants");
  expect(String(failure)).toContain(serviceName);
  expect(String(failure)).not.toContain("\ninjected");
  expect(String(failure)).not.toContain("\u001b");
  expect(String(failure)).not.toContain("\u202e");
});

it("blocks a noncanonical activation link when the initial user manager is unavailable (#9705)", () => {
  const activation = activationScanOptions(["alternate-gateway.service"]);
  const activationPath = `${activation.activationDirectory}/alternate-gateway.service`;
  const spawnSyncImpl = vi.fn<SpawnSyncLike>(() =>
    spawnResult(1, "Failed to connect to bus: No medium found"),
  );

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain(
    "a noncanonical enabled user service cannot be qualified for selected port 8080",
  );
  expect(String(failure)).not.toContain("alternate-gateway.service");
  expect(String(failure)).not.toContain(activationPath);
  expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
});

it("ignores canonical activation links for a custom port when the user manager is unavailable (#9705)", () => {
  const activation = activationScanOptions([`${OPENSHELL_GATEWAY_USER_SERVICE}.service`]);
  const spawnSyncImpl = vi.fn<SpawnSyncLike>(() =>
    spawnResult(1, "Failed to connect to bus: No medium found"),
  );

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(18_080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).not.toThrow();
  expect(activation.readdirSync).toHaveBeenCalled();
});

it("blocks a noncanonical activation link for a custom port when the user manager is unavailable (#9705)", () => {
  const activation = activationScanOptions(["alternate-gateway.service"]);
  const activationPath = `${activation.activationDirectory}/alternate-gateway.service`;

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(18_080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain(
    "a noncanonical enabled user service cannot be qualified for selected port 18080",
  );
  expect(String(failure)).not.toContain("alternate-gateway.service");
  expect(String(failure)).not.toContain(activationPath);
});

it.each(["generated", "static"])(
  "inspects an inactive %s service linked from a trusted activation root (#9705)",
  (unitFileState) => {
    const serviceName = "alternate-gateway.service";
    const activation = activationScanOptions([serviceName]);
    const spawnSyncImpl = competingServiceSpawn({
      metadata: {
        [serviceName]: showOutput({ ActiveState: "inactive", UnitFileState: unitFileState }),
      },
    });

    expect(() =>
      assertNoCompetingOpenShellGatewayUserService(8080, {
        ...activation.options,
        commandExists: () => true,
        platform: "linux",
        spawnSyncImpl,
      }),
    ).toThrow(/can claim selected port 8080/);
    expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("show"))).toBe(true);
    expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("list-unit-files"))).toBe(
      false,
    );
  },
);

it("blocks an inactive activation-linked gateway on the selected custom port (#9705)", () => {
  const serviceName = "alternate-gateway.service";
  const activation = activationScanOptions([serviceName]);
  const spawnSyncImpl = competingServiceSpawn({
    metadata: {
      [serviceName]: showOutput({
        ActiveState: "inactive",
        ExecStart: `{ path=${TRUSTED_GATEWAY} ; argv[]=${TRUSTED_GATEWAY} --port 18080 ; }`,
        UnitFileState: "generated",
      }),
    },
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(18_080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/can claim selected port 18080/);
});

it("does not trust a gateway path from a leading-space XDG_BIN_HOME (#9705)", () => {
  const serviceName = "alternate-gateway.service";
  const trimmedGateway = "/opt/custom-bin/openshell-gateway";
  const activation = activationScanOptions();
  const spawnSyncImpl = competingServiceSpawn({
    active: [serviceName],
    metadata: {
      [serviceName]: showOutput({
        ExecStart: `{ path=${trimmedGateway} ; argv[]=${trimmedGateway} --port 18080 ; }`,
      }),
    },
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      env: { HOME: "/home/nvidia", XDG_BIN_HOME: " /opt/custom-bin" },
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/uses an untrusted executable/);
});

it("does not scan custom activation names when active service enumeration fails (#9705)", () => {
  const activation = activationScanOptions(["alternate-gateway.service"]);
  const spawnSyncImpl = vi.fn<SpawnSyncLike>(() => spawnResult(1, "Permission denied"));

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/active enumeration/);
  expect(activation.readdirSync).not.toHaveBeenCalled();
});

it("uses only the reachable user manager unit path for activation discovery (#9705)", () => {
  const serviceName = "manager-only-gateway.service";
  const managerRoot = "/manager-only/systemd/user";
  const activation = activationScanOptions([serviceName], managerRoot);
  const spawnSyncImpl = competingServiceSpawn({
    metadata: {
      [serviceName]: showOutput({ ActiveState: "inactive", UnitFileState: "static" }),
    },
    unitPaths: [managerRoot],
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      env: { HOME: "/home/nvidia", XDG_CONFIG_HOME: "/process-only/config" },
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/manager-only-gateway[.]service.*selected port 8080/);
  expect(activation.readdirSync.mock.calls.map(([candidate]) => candidate)).toEqual([
    managerRoot,
    activation.activationDirectory,
  ]);
  const busctlCall = spawnSyncImpl.mock.calls.find(([command]) => command === "busctl");
  expect(busctlCall?.[1]).toEqual([
    "--user",
    "--json=short",
    "get-property",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "UnitPath",
  ]);
  expect(busctlCall?.[1]).not.toContain("Environment");
});

it.each([
  ["malformed JSON", "tenant-secret-not-json"],
  [
    "an extra property",
    JSON.stringify({ type: "as", data: ["/manager/root"], secret: "tenant-secret" }),
  ],
  ["an empty path list", JSON.stringify({ type: "as", data: [] })],
  ["a relative path", JSON.stringify({ type: "as", data: ["tenant-secret-relative"] })],
  ["the wrong D-Bus type", JSON.stringify({ type: "s", data: ["/manager/root"] })],
])("fails closed when the user manager returns %s (#9705)", (_case, unitPathOutput) => {
  const readdirSync = vi.fn(() => []);
  const spawnSyncImpl = competingServiceSpawn({ unitPathOutput });

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      home: "/home/nvidia",
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("manager unit-path enumeration");
  expect(String(failure)).not.toContain("tenant-secret");
  expect(readdirSync).not.toHaveBeenCalled();
  expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("show"))).toBe(false);
});

it("redacts a failed user manager unit-path query (#9705)", () => {
  const secret = "manager-query-secret";
  const spawnSyncImpl = competingServiceSpawn({ unitPathOutput: secret, unitPathStatus: 1 });

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      home: "/home/nvidia",
      platform: "linux",
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("manager unit-path enumeration");
  expect(String(failure)).not.toContain(secret);
});

it("fails closed when busctl is unavailable after active enumeration (#9705)", () => {
  const spawnSyncImpl = competingServiceSpawn({});

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: (command) => command === "systemctl",
      env: { HOME: "/home/nvidia" },
      home: "/home/nvidia",
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/manager unit-path enumeration/);
  expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
});

it("inspects an activation directory when its directory entry type is unknown (#9705)", () => {
  const root = "/manager/systemd/user";
  const activationDirectory = `${root}/default.target.wants`;
  const serviceName = "unknown-dirent-gateway.service";
  const readdirSync = vi.fn((candidate: string) =>
    candidate === root
      ? [
          {
            isDirectory: () => false,
            isSymbolicLink: () => false,
            name: "default.target.wants",
          },
        ]
      : candidate === activationDirectory
        ? [serviceName]
        : [],
  );
  const missingPath = () => {
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  };
  const lstatSync = vi.fn((candidate: string) =>
    candidate === activationDirectory
      ? { isDirectory: () => true, isSymbolicLink: () => false }
      : missingPath(),
  );
  const spawnSyncImpl = competingServiceSpawn({
    metadata: {
      [serviceName]: showOutput({ ActiveState: "inactive", UnitFileState: "static" }),
    },
    unitPaths: [root],
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      existsSync: () => false,
      home: "/home/nvidia",
      lstatSync: lstatSync as never,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl,
    }),
  ).toThrow(/unknown-dirent-gateway[.]service.*selected port 8080/);
  expect(lstatSync).toHaveBeenCalledWith(activationDirectory);
});

it("redacts a failure while resolving an unknown activation directory type (#9705)", () => {
  const secret = "unknown-dirent-secret";
  const root = "/manager/systemd/user";
  const readdirSync = vi.fn((candidate: string) =>
    candidate === root
      ? [
          {
            isDirectory: () => false,
            isSymbolicLink: () => false,
            name: "default.target.wants",
          },
        ]
      : [],
  );
  const lstatSync = vi.fn(() => {
    throw Object.assign(new Error(`Permission denied: ${secret}`), { code: "EACCES" });
  });

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      home: "/home/nvidia",
      lstatSync: lstatSync as never,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl: competingServiceSpawn({ unitPaths: [root] }),
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("activation-path enumeration");
  expect(String(failure)).not.toContain(secret);
});

it("fails closed when activation-root discovery fails after active enumeration (#9705)", () => {
  const secret = "tenant-secret-path";
  const accessError = Object.assign(new Error(`Permission denied: ${secret}`), {
    code: "EACCES",
  });
  const readdirSync = vi.fn(() => {
    throw accessError;
  });
  const spawnSyncImpl = competingServiceSpawn({});

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: `/home/${secret}` },
      home: `/home/${secret}`,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("activation-path enumeration");
  expect(String(failure)).not.toContain(secret);
  expect(readdirSync).toHaveBeenCalled();
});

it("redacts activation-root failures during the offline fallback (#9705)", () => {
  const secret = "offline-secret-path";
  const accessError = Object.assign(new Error(`Permission denied: ${secret}`), {
    code: "EACCES",
  });
  const readdirSync = vi.fn(() => {
    throw accessError;
  });

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: `/home/${secret}` },
      home: `/home/${secret}`,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain(
    "systemd user service activation paths while the user manager is unavailable",
  );
  expect(String(failure)).not.toContain(secret);
});

it("treats a whitespace-only SYSTEMD_UNIT_PATH as an offline override (#9705)", () => {
  const readdirSync = vi.fn(() => []);

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia", SYSTEMD_UNIT_PATH: "   " },
      home: "/home/nvidia",
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    }),
  ).toThrow(/systemd user service activation paths while the user manager is unavailable/);
  expect(readdirSync).not.toHaveBeenCalled();
});

it.each([
  ["XDG_CONFIG_DIRS with whitespace", "XDG_CONFIG_DIRS", "   "],
  ["XDG_CONFIG_DIRS with a leading space", "XDG_CONFIG_DIRS", " /etc/xdg"],
  ["XDG_DATA_DIRS with whitespace", "XDG_DATA_DIRS", "   "],
  ["XDG_DATA_DIRS with a leading space", "XDG_DATA_DIRS", " /usr/share"],
])("fails closed for offline %s (#9705)", (_case, variable, value) => {
  const readdirSync = vi.fn(() => []);

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia", [variable]: value },
      home: "/home/nvidia",
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    }),
  ).toThrow(/systemd user service activation paths while the user manager is unavailable/);
  expect(readdirSync).not.toHaveBeenCalled();
});

it.each([
  [
    "XDG_CONFIG_HOME",
    "XDG_CONFIG_HOME",
    " /opt/config-home",
    "/home/nvidia/.config/systemd/user",
    "/opt/config-home/systemd/user",
  ],
  [
    "XDG_DATA_HOME",
    "XDG_DATA_HOME",
    " /opt/data-home",
    "/home/nvidia/.local/share/systemd/user",
    "/opt/data-home/systemd/user",
  ],
  [
    "XDG_RUNTIME_DIR",
    "XDG_RUNTIME_DIR",
    " /run/custom-runtime",
    `/run/user/${String(process.getuid?.())}/systemd/user`,
    "/run/custom-runtime/systemd/user",
  ],
])(
  "uses the offline fallback instead of trimming a leading space from %s (#9705)",
  (_case, variable, value, expectedRoot, trimmedRoot) => {
    const readdirSync = vi.fn((_candidate: string) => []);

    expect(() =>
      assertNoCompetingOpenShellGatewayUserService(8080, {
        commandExists: () => true,
        env: { HOME: "/home/nvidia", [variable]: value },
        home: "/home/nvidia",
        platform: "linux",
        readdirSync: readdirSync as never,
        spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
      }),
    ).not.toThrow();
    const inspectedRoots = readdirSync.mock.calls.map(([candidate]) => candidate);
    expect(inspectedRoots).toContain(expectedRoot);
    expect(inspectedRoots).not.toContain(trimmedRoot);
  },
);

it("fails closed when the user manager becomes unavailable during metadata inspection (#9705)", () => {
  const activation = activationScanOptions();
  const spawnSyncImpl = vi.fn<SpawnSyncLike>((command, args) =>
    command === "busctl"
      ? spawnResult(
          0,
          "",
          JSON.stringify({ type: "as", data: ["/home/nvidia/.config/systemd/user"] }),
        )
      : args.includes("list-units")
        ? spawnResult(0, "", "alternate-gateway.service loaded active running Test service")
        : spawnResult(1, "Failed to connect to bus: No medium found"),
  );

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/service metadata query/);
  expect(activation.readdirSync).toHaveBeenCalled();
});

it("rejects a truncated active row before querying service metadata (#9705)", () => {
  const activation = activationScanOptions();
  const spawnSyncImpl = competingServiceSpawn({
    activeRows: ["alternate.service loaded active"],
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/malformed service enumeration metadata/);
  expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("show"))).toBe(false);
  expect(activation.readdirSync).not.toHaveBeenCalled();
});

it("rejects an unsafe activation service name before querying metadata (#9705)", () => {
  const activation = activationScanOptions(["--alternate.service"]);
  const spawnSyncImpl = competingServiceSpawn({});

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/activation-path enumeration/);
  expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("show"))).toBe(false);
});

it("rejects a relative manager unit path before reading activation roots (#9705)", () => {
  const readdirSync = vi.fn((_candidate: string) => []);
  const spawnSyncImpl = competingServiceSpawn({
    unitPathOutput: JSON.stringify({ type: "as", data: ["relative-unit-root"] }),
  });
  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia" },
      home: "/home/nvidia",
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).toContain("manager unit-path enumeration");
  expect(String(failure)).not.toContain("relative-unit-root");
  expect(readdirSync).not.toHaveBeenCalled();
});

it.each([
  ["a broken symlink ancestor", "ENOENT", (_dataRoot: string, dataHome: string) => dataHome, true],
  [
    "a symlink-to-file ancestor",
    "ENOTDIR",
    (_dataRoot: string, dataHome: string) => dataHome,
    true,
  ],
  ["a regular-file root", "ENOTDIR", (dataRoot: string) => dataRoot, false],
  [
    "an unreadable directory ancestor",
    "EACCES",
    (_dataRoot: string, dataHome: string) => dataHome,
    false,
  ],
])(
  "fails closed when %s makes an activation root unreadable (#9705)",
  (_case, errorCode, selectInspectedCandidate, inspectedCandidateIsSymlink) => {
    const secret = "secret-data-root";
    const home = "/home/nvidia";
    const dataHome = `${home}/${secret}`;
    const dataRoot = `${dataHome}/systemd/user`;
    const inspectedCandidate = selectInspectedCandidate(dataRoot, dataHome);
    const scanError = Object.assign(new Error(`Unreadable target: ${secret}`), {
      code: errorCode,
    });
    const throwScanError = () => {
      throw scanError;
    };
    const readdirSync = vi.fn((candidate: string) =>
      candidate === dataRoot || candidate === inspectedCandidate ? throwScanError() : [],
    );
    const lstatSync = vi.fn((candidate: string) =>
      candidate === inspectedCandidate
        ? { isSymbolicLink: () => inspectedCandidateIsSymlink }
        : throwScanError(),
    );
    const spawnSyncImpl = competingServiceSpawn({ unitPaths: [dataRoot] });

    let failure: unknown;
    try {
      assertNoCompetingOpenShellGatewayUserService(8080, {
        commandExists: () => true,
        env: { HOME: home, XDG_DATA_HOME: dataHome },
        existsSync: () => false,
        home,
        lstatSync: lstatSync as never,
        platform: "linux",
        readdirSync: readdirSync as never,
        spawnSyncImpl,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
    expect(String(failure)).toContain("activation-path enumeration");
    expect(String(failure)).not.toContain(secret);
  },
);

it("blocks service fallback without exposing a unit search override (#8926)", () => {
  const secret = "custom-systemd-secret";
  const home = "/home/nvidia";
  const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;

  const result = stopOpenShellGatewayUserService({
    commandExists: (command) => command === "systemctl",
    env: { HOME: home, SYSTEMD_UNIT_PATH: `/opt/${secret}` },
    existsSync: (candidate) => candidate === servicePath,
    home,
    lstatSync: (() => ({ isSymbolicLink: () => false })) as never,
    platform: "linux",
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
  });

  expect(result).toMatchObject({
    standaloneFallbackAllowed: false,
    standaloneFallbackBlocked: true,
  });
  expect(result.reason).toContain("could not inspect systemd user service activation paths");
  expect(result.reason).not.toContain(secret);
});

it("escapes a canonical activation path in the stopped-service fallback diagnostic (#9705)", () => {
  const home = "/home/nvidia";
  const servicePath = `${home}/.config/systemd/user/nemoclaw-openshell-gateway.service`;
  const userRoot = `${home}/.config/systemd/user`;
  const activationDirectory = `${userRoot}/default.target\ninjected\u001b\u202e.wants`;
  const activationService = `${OPENSHELL_GATEWAY_USER_SERVICE}.service`;
  const result = stopOpenShellGatewayUserService({
    commandExists: (command) => command === "systemctl",
    env: { HOME: home },
    existsSync: (candidate) => candidate === servicePath,
    home,
    lstatSync: (() => ({ isSymbolicLink: () => false })) as never,
    platform: "linux",
    readFileSync: () => `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}\n`,
    readdirSync: ((candidate: string) =>
      candidate === userRoot
        ? [
            {
              isDirectory: () => true,
              isSymbolicLink: () => false,
              name: "default.target\ninjected\u001b\u202e.wants",
            },
          ]
        : candidate === activationDirectory
          ? [activationService]
          : []) as never,
    spawnSyncImpl: vi.fn(() => spawnResult(1, "Failed to connect to bus: No medium found")),
  });

  expect(result).toMatchObject({
    standaloneFallbackAllowed: false,
    standaloneFallbackBlocked: true,
  });
  expect(result.reason).toContain("default.target\\ninjected\\u001b\\u202e.wants");
  expect(result.reason).toContain(activationService);
  expect(result.reason).not.toContain("\ninjected");
  expect(result.reason).not.toContain("\u001b");
  expect(result.reason).not.toContain("\u202e");
});

it("ignores process XDG roots while the user manager is reachable (#9705)", () => {
  const managerRoot = "/manager-only/systemd/user";
  const processRoot = "/process-only/systemd/user";
  const readdirSync = vi.fn((_candidate: string) => []);
  const lstatSync = vi.fn(() => {
    throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
  });
  const spawnSyncImpl = competingServiceSpawn({ unitPaths: [managerRoot] });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: "/home/nvidia", XDG_DATA_HOME: processRoot },
      existsSync: () => false,
      home: "/home/nvidia",
      lstatSync: lstatSync as never,
      platform: "linux",
      readdirSync: readdirSync as never,
      spawnSyncImpl,
    }),
  ).not.toThrow();
  expect(readdirSync.mock.calls.map(([candidate]) => candidate)).toEqual([managerRoot]);
});

it("blocks an activation-linked service whose effective unit is missing (#9705)", () => {
  const serviceName = "alternate-gateway.service";
  const activation = activationScanOptions([serviceName]);
  const spawnSyncImpl = competingServiceSpawn({
    metadata: {
      [serviceName]: showOutput({
        ActiveState: "inactive",
        ExecStart: "",
        UnitFileState: "not-found",
      }),
    },
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/ambiguous executable metadata/);
});

it("fails closed without exposing metadata when a service query fails (#9705)", () => {
  const secret = "provider-token-should-not-appear";
  const activation = activationScanOptions();
  const spawnSyncImpl = vi.fn((command: string, args: string[]) =>
    command === "busctl"
      ? spawnResult(
          0,
          "",
          JSON.stringify({ type: "as", data: ["/home/nvidia/.config/systemd/user"] }),
        )
      : args.includes("list-units")
        ? spawnResult(0, "", "alternate-gateway.service loaded active running Test service")
        : spawnResult(1, `ExecStart=/bin/gateway --token ${secret}`),
  );

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
      ...activation.options,
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OpenShellGatewayServiceTrustError);
  expect(String(failure)).not.toContain(secret);
});
