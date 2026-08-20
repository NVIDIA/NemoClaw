// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, type Mock, vi } from "vitest";

import {
  classifyOpenShellGatewayServiceMetadata,
  type OpenShellGatewayServiceMetadataVerdict,
} from "./openshell-service-coexistence";
import {
  assertNoCompetingOpenShellGatewayUserService,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  OPENSHELL_GATEWAY_USER_SERVICE,
  OpenShellGatewayServiceTrustError,
  type SpawnSyncLike,
  type SpawnSyncLikeResult,
} from "../docker-driver-gateway-service";

const TRUSTED_GATEWAY = "/usr/local/bin/openshell-gateway";
const TRUSTED_GATEWAY_PATHS = [
  TRUSTED_GATEWAY,
  "/usr/bin/openshell-gateway",
  "/home/nvidia/.local/bin/openshell-gateway",
];

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
): OpenShellGatewayServiceMetadataVerdict {
  return classifyOpenShellGatewayServiceMetadata({
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
      gatewayPort: 8080,
      metadata,
      trustedExecutablePaths: TRUSTED_GATEWAY_PATHS,
    }),
  ).toBe("block-malformed-metadata");
});

it("blocks an invalid selected port (#9705)", () => {
  expect(
    classifyOpenShellGatewayServiceMetadata({
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
  enabled = [],
  enabledRows,
  metadata = {},
}: {
  active?: string[];
  activeRows?: string[];
  enabled?: string[];
  enabledRows?: string[];
  metadata?: Record<string, string>;
}): Mock<SpawnSyncLike> {
  return vi.fn<SpawnSyncLike>((_command, args) =>
    args.includes("list-units")
      ? spawnResult(
          0,
          "",
          (
            activeRows ?? active.map((service) => `${service} loaded active running Test service`)
          ).join("\n"),
        )
      : args.includes("list-unit-files")
        ? spawnResult(
            0,
            "",
            (enabledRows ?? enabled.map((service) => `${service} enabled enabled`)).join("\n"),
          )
        : spawnResult(0, "", metadata[args[args.indexOf("show") + 1] ?? ""] ?? ""),
  );
}

it("excludes canonical services before a custom-port metadata query (#9705)", () => {
  const unrelated = "unrelated.service";
  const spawnSyncImpl = competingServiceSpawn({
    active: [`${OPENSHELL_GATEWAY_USER_SERVICE}.service`, unrelated],
    enabled: [`${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE}.service`],
    metadata: {
      [unrelated]: showOutput({
        ExecStart: "{ path=/usr/bin/sleep ; argv[]=/usr/bin/sleep infinity ; }",
      }),
    },
  });

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(9090, {
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
});

it("retains the fixed-name activation scan when the user manager is unavailable (#9705)", () => {
  const home = "/home/nvidia";
  const userRoot = `${home}/.config/systemd/user`;
  const activationDirectory = `${userRoot}/default.target.wants`;
  const activationPath = `${activationDirectory}/openshell-gateway.service`;

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      env: { HOME: home },
      existsSync: () => false,
      home,
      lstatSync: vi.fn() as never,
      platform: "linux",
      readdirSync: ((candidate: string) =>
        candidate === userRoot
          ? [
              {
                isDirectory: () => true,
                isSymbolicLink: () => false,
                name: "default.target.wants",
              },
            ]
          : candidate === activationDirectory
            ? ["openshell-gateway.service"]
            : []) as never,
      spawnSyncImpl: () => spawnResult(1, "Failed to connect to bus: No medium found"),
    }),
  ).toThrow(activationPath);
});

it.each([
  ["enabled enumeration", "list-unit-files"],
  ["service metadata query", "show"],
] as const)(
  "fails closed when the user manager becomes unavailable during %s (#9705)",
  (operation, failedCommand) => {
    const readdirSync = vi.fn(() => []);
    const spawnSyncImpl = vi.fn<SpawnSyncLike>((_command, args) =>
      args.includes("list-units")
        ? spawnResult(
            0,
            "",
            failedCommand === "show"
              ? "alternate-gateway.service loaded active running Test service"
              : "",
          )
        : args.includes(failedCommand)
          ? spawnResult(1, "Failed to connect to bus: No medium found")
          : spawnResult(),
    );

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
    expect(String(failure)).toContain(operation);
    expect(readdirSync).not.toHaveBeenCalled();
  },
);

it.each([
  ["a truncated active row", { activeRows: ["alternate.service loaded active"] }],
  [
    "an enabled row with extra columns",
    { enabledRows: ["alternate.service enabled enabled extra"] },
  ],
])("rejects %s before querying service metadata (#9705)", (_case, discovery) => {
  const spawnSyncImpl = competingServiceSpawn(discovery);

  expect(() =>
    assertNoCompetingOpenShellGatewayUserService(8080, {
      commandExists: () => true,
      platform: "linux",
      spawnSyncImpl,
    }),
  ).toThrow(/malformed service enumeration metadata/);
  expect(spawnSyncImpl.mock.calls.some(([, args]) => args.includes("show"))).toBe(false);
});

it("fails closed without exposing metadata when a service query fails (#9705)", () => {
  const secret = "provider-token-should-not-appear";
  const spawnSyncImpl = vi.fn((_command: string, args: string[]) =>
    args.includes("list-units")
      ? spawnResult(0, "", "alternate-gateway.service loaded active running Test service")
      : args.includes("list-unit-files")
        ? spawnResult()
        : spawnResult(1, `ExecStart=/bin/gateway --token ${secret}`),
  );

  let failure: unknown;
  try {
    assertNoCompetingOpenShellGatewayUserService(8080, {
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
