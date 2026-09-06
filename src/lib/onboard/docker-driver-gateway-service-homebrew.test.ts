// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  hasOpenShellGatewayUserService,
  OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256,
  OpenShellGatewayServiceTrustError,
  type SpawnSyncLikeResult,
  startOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
} from "./docker-driver-gateway-service";

function spawnResult(status = 0, stderr = "", stdout = ""): SpawnSyncLikeResult {
  return { status, stderr, stdout };
}

const FORMULA_PREFIX = "/opt/homebrew/opt/openshell";
const GATEWAY_BIN = `${FORMULA_PREFIX}/bin/openshell-gateway`;
const SERVICE_PROGRAM = `${FORMULA_PREFIX}/libexec/openshell-gateway-homebrew-service`;

function officialFormulaInfo(
  options: { installed?: unknown[]; serviceProgram?: unknown; tap?: string } = {},
): SpawnSyncLikeResult {
  return spawnResult(
    0,
    "",
    JSON.stringify({
      formulae: [
        {
          installed: options.installed ?? [{ version: "0.0.106" }],
          name: "openshell",
          service: { run: options.serviceProgram ?? SERVICE_PROGRAM },
          tap: options.tap ?? "nvidia/openshell",
        },
      ],
    }),
  );
}

interface HomebrewServiceRecord {
  loaded: boolean;
  pid: number;
  program: string;
  running: boolean;
  service_name: string;
}

function serviceRecord(overrides: Partial<HomebrewServiceRecord> = {}): HomebrewServiceRecord {
  return {
    loaded: true,
    pid: 4242,
    program: SERVICE_PROGRAM,
    running: true,
    service_name: "homebrew.mxcl.openshell",
    ...overrides,
  };
}

function queryHomebrewService(records: HomebrewServiceRecord[]) {
  const spawnSyncImpl = vi.fn((command: string, args: string[]) => {
    const label = args[1]?.split("/").at(-1);
    const record = records.find((candidate) => candidate.service_name === label);
    return command === "brew"
      ? args[0] === "info"
        ? officialFormulaInfo()
        : spawnResult()
      : !record?.loaded
        ? spawnResult(113)
        : spawnResult(
            0,
            "",
            `\tstate = ${record.running ? "running" : "waiting"}\n\tprogram = ${record.program}\n\tpid = ${String(record.pid)}\n`,
          );
  });

  return getTrustedActiveOpenShellGatewayUserServiceIdentity({
    commandExists: (command) => command === "brew" || command === "launchctl",
    existsSync: (candidate) => candidate === GATEWAY_BIN,
    homebrewFormulaOperation: (args) => spawnSyncImpl("brew", args),
    platform: "darwin",
    spawnSyncImpl,
  });
}

describe("OpenShell Homebrew service boundary", () => {
  it.each([
    ["a null document", "null"],
    ["no formula list", "{}"],
    ["a non-array formula list", '{"formulae":{}}'],
    ["a null formula entry", '{"formulae":[null]}'],
  ])("rejects valid JSON with %s (#11129)", (_case, stdout) => {
    const detectService = () =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(0, "", stdout),
        platform: "darwin",
      });

    expect(detectService).toThrow(OpenShellGatewayServiceTrustError);
    expect(detectService).toThrow("formula identity check returned invalid data");
  });

  it("rejects a Homebrew formula outside the official tap (#6903)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info" ? officialFormulaInfo({ tap: "other/tap" }) : spawnResult(),
    );

    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toThrow("must come from nvidia/openshell");
  });

  it.each([
    ["is not installed", { installed: [] }, "pinned checksum and temporary trust contract"],
    ["has a relative service command", { serviceProgram: "bin/gateway" }, "one absolute path"],
    [
      "has a different service command",
      { serviceProgram: `${FORMULA_PREFIX}/bin/other` },
      "expected gateway wrapper",
    ],
  ])("rejects an official formula that %s (#11112)", (_case, options, expected) => {
    expect(() =>
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => officialFormulaInfo(options),
        platform: "darwin",
      }),
    ).toThrow(expected);
  });

  it("uses the temporary formula trust boundary for inspection (#7707)", () => {
    const operation = vi.fn((args: string[]) =>
      args[0] === "info" ? officialFormulaInfo() : spawnResult(),
    );

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: operation,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(operation.mock.calls.map(([args]) => args)).toEqual([
      ["info", "--json=v2", "openshell"],
    ]);
  });

  it.each([
    [66, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
    [67, "could not grant temporary trust"],
    [68, "could not remove temporary trust"],
    [69, "Run curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash"],
  ])("fails closed on Homebrew boundary status %i (#7707)", (status, expected) => {
    const preparePortForServiceStart = vi.fn();
    const prepareServiceEnv = vi.fn();
    const validatePortOwnerForServiceStart = vi.fn();

    expect(() =>
      startOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(status, "opaque Homebrew diagnostic"),
        platform: "darwin",
        preparePortForServiceStart,
        prepareServiceEnv,
        validatePortOwnerForServiceStart,
      }),
    ).toThrow(expected);
    expect(preparePortForServiceStart).not.toHaveBeenCalled();
    expect(prepareServiceEnv).not.toHaveBeenCalled();
    expect(validatePortOwnerForServiceStart).not.toHaveBeenCalled();
  });

  it("invokes the shipped operation boundary instead of parsing Homebrew stderr (#7707)", () => {
    const spawnSyncImpl = vi.fn((_command: string, args: string[]) => {
      const brewIndex = args.indexOf("brew");
      return args[brewIndex + 1] === "info" ? officialFormulaInfo() : spawnResult();
    });

    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        platform: "darwin",
        spawnSyncImpl,
      }),
    ).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      "bash",
      expect.arrayContaining([
        "--homebrew-formula-operation",
        OPENSHELL_GATEWAY_HOMEBREW_FORMULA_SHA256,
        "--",
        "brew",
        "info",
        "--json=v2",
        "openshell",
      ]),
      expect.any(Object),
    );
  });

  it("skips the managed start when no trusted Homebrew service is selected (#7707)", async () => {
    const startService = vi.fn(() => {
      throw new Error("managed start must not run");
    });
    const started = await startPackageManagedDockerDriverGateway({
      clearDockerDriverGatewayRuntimeFiles: () => {},
      exitOnFailure: false,
      gatewayName: "nemoclaw",
      hasOpenShellGatewayUserService: () => false,
      registerDockerDriverGatewayEndpoint: () => true,
      runCaptureOpenshell: () => "",
      skipSandboxBridgeReachability: true,
      startOpenShellGatewayUserService: startService,
      verifySandboxBridgeGatewayReachableOrExit: async () => {},
    });

    expect(started).toBe(false);
    expect(startService).not.toHaveBeenCalled();
  });

  it("reports no managed service only when the formula is genuinely absent (#8104)", () => {
    expect(
      hasOpenShellGatewayUserService({
        commandExists: () => true,
        homebrewFormulaOperation: () => spawnResult(65),
        platform: "darwin",
      }),
    ).toBe(false);
  });

  it.each(["homebrew.mxcl.openshell", "sh.brew.openshell"])(
    "accepts the active official service label %s (#11111)",
    (serviceName) => {
      expect(queryHomebrewService([serviceRecord({ service_name: serviceName })])).toEqual({
        pid: 4242,
        executablePath: "/opt/homebrew/opt/openshell/bin/openshell-gateway",
      });
    },
  );

  it("rejects a service label that extends the canonical label (#11111)", () => {
    expect(
      queryHomebrewService([serviceRecord({ service_name: "sh.brew.openshell.attacker" })]),
    ).toBeNull();
  });

  it("rejects an active canonical service with a foreign program (#11112)", () => {
    expect(
      queryHomebrewService([
        serviceRecord({ program: "/tmp/foreign-service", service_name: "sh.brew.openshell" }),
      ]),
    ).toBeNull();
  });

  it("rejects an active canonical service with a malformed PID (#11112)", () => {
    expect(
      queryHomebrewService([serviceRecord({ pid: Number.NaN, service_name: "sh.brew.openshell" })]),
    ).toBeNull();
  });

  it("rejects canonical and legacy service records with different active PIDs (#11111)", () => {
    expect(
      queryHomebrewService([
        serviceRecord(),
        serviceRecord({ pid: 4343, service_name: "sh.brew.openshell" }),
      ]),
    ).toBeNull();
  });

  it("accepts one active canonical record beside an inactive legacy record (#11111)", () => {
    expect(
      queryHomebrewService([
        serviceRecord({ service_name: "sh.brew.openshell" }),
        serviceRecord({ pid: 4343, running: false }),
      ]),
    ).toEqual({
      pid: 4242,
      executablePath: "/opt/homebrew/opt/openshell/bin/openshell-gateway",
    });
  });
});
