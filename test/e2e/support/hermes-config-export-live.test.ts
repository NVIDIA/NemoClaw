// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  load: vi.fn(),
  readSandboxPolicy: vi.fn(),
  save: vi.fn(),
  exec: vi.fn(),
  execShell: vi.fn(),
  validateNemoClawConfig: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("../../../src/lib/state/registry/persistence.ts", () => ({
  load: mocks.load,
  save: mocks.save,
}));

vi.mock("../../../src/lib/adapters/openshell/sandbox-policy-cli.ts", () => ({
  namedOpenShellGateway: (name: string) => ({ kind: "named", name }),
  syncCliOpenShellSandboxPolicyReader: { readSandboxPolicy: mocks.readSandboxPolicy },
}));

vi.mock("../../../src/lib/config/schema.ts", () => ({
  validateNemoClawConfig: mocks.validateNemoClawConfig,
}));

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
  verifyHermesConfigExportLive,
} from "../fixtures/hermes-config-export-live.ts";

const IMAGE_REF = "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({
    sandboxes: {
      hermes: {
        credentialEnv: "NVIDIA_API_KEY",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        gatewayName: "nemoclaw",
        workload: { kind: "managed-image", reference: IMAGE_REF },
      },
    },
  });
  mocks.readSandboxPolicy.mockReturnValue({ ok: false });
  mocks.validateNemoClawConfig.mockReturnValue({
    spec: {
      inferenceProviders: [
        {
          credential: { env: "NVIDIA_API_KEY" },
          endpoint: "https://integrate.api.nvidia.com/v1",
        },
      ],
      sandboxes: [
        {
          agents: [{ type: "hermes" }],
          name: "hermes",
          network: { policy: { explicit: null } },
          runtime: { image: { ref: IMAGE_REF } },
        },
      ],
    },
  });
});

function passingEvidence(): HermesConfigExportLiveEvidence {
  return {
    agent: "hermes",
    aliasesEquivalent: true,
    checked: true,
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    immutableManagedImageMatches: true,
    interfacesMatch: true,
    dashboardRuntimeMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    sandboxNameMatches: true,
  };
}

async function runEnabledFixture(
  redactionValues: readonly string[] = [],
  dashboardEnabled = false,
  environment: NodeJS.ProcessEnv = {},
) {
  let dispose: (() => void) | undefined;
  try {
    return await verifyHermesConfigExportLive({
      artifacts: { writeJson: mocks.writeJson },
      cleanup: {
        trackDisposable: (_description: string, cleanup: () => void) => {
          dispose = cleanup;
        },
      },
      enabled: true,
      dashboardEnabled,
      sandbox: { exec: mocks.exec, execShell: mocks.execShell },
      env: {
        ...(dashboardEnabled
          ? {
              NEMOCLAW_DASHBOARD_PORT: "19000",
              NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19120",
              NEMOCLAW_HERMES_DASHBOARD_TUI: "TRUE",
              NEMOCLAW_HERMES_API_PORT: "8643",
            }
          : {}),
        ...environment,
      },
      host: { command: mocks.command },
      redactionValues,
      sandboxName: "hermes",
    } as unknown as Parameters<typeof verifyHermesConfigExportLive>[0]);
  } finally {
    dispose?.();
  }
}

describe("Hermes config export live evidence", () => {
  it("accepts the complete redacted export contract", () => {
    expect(passesHermesConfigExportLiveEvidence(passingEvidence())).toBe(true);
  });

  it.each([
    "aliasesEquivalent",
    "credentialReferenceMatches",
    "credentialValuesOmitted",
    "identityDriftPreventedPublication",
    "identityDriftReported",
    "immutableManagedImageMatches",
    "interfacesMatch",
    "dashboardRuntimeMatches",
    "inferenceEndpointMatches",
    "launchersSucceeded",
    "policyMatches",
    "sandboxNameMatches",
  ] as const)("rejects evidence when %s is false", (field) => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), [field]: false })).toBe(
      false,
    );
  });

  it("rejects evidence for a different agent", () => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), agent: "openclaw" })).toBe(
      false,
    );
  });

  it("records failed evidence before parsing when a launcher fails", async () => {
    mocks.command
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        fs.writeFileSync(outputPath, "secret-value");
        return { exitCode: 0, stderr: "", stdout: "" };
      })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "failed", stdout: "" });
    const result = await runEnabledFixture(["secret-value"]);

    expect(result).toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        checked: true,
        credentialValuesOmitted: false,
        launchersSucceeded: false,
      }),
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.validateNemoClawConfig).not.toHaveBeenCalled();
  });

  it("rejects drift evidence when only one launcher reports identity drift (#11286)", async () => {
    const writeExport = async (_command: string, args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, "{}");
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValueOnce({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" })
      .mockResolvedValueOnce({ exitCode: 1, stderr: "launcher failed", stdout: "" });

    const result = await runEnabledFixture();

    expect(result).toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        identityDriftPreventedPublication: true,
        identityDriftReported: false,
      }),
    );
  });
});

describe("Hermes interface runtime evidence", () => {
  it.each([
    { apiPort: "8642", interfaces: undefined },
    { apiPort: "8643", interfaces: { api: { port: 8643 } } },
  ])(
    "checks API allocation $apiPort with the dashboard disabled (#11433)",
    async ({ apiPort, interfaces }) => {
      const document = mocks.validateNemoClawConfig.getMockImplementation()!();
      document.spec.sandboxes[0].agents[0].interfaces = interfaces;
      mocks.validateNemoClawConfig.mockReturnValue(document);
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, "{}");
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      mocks.command
        .mockImplementationOnce(writeExport)
        .mockImplementationOnce(writeExport)
        .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
      expect(await runEnabledFixture([], false, { NEMOCLAW_HERMES_API_PORT: apiPort })).toEqual({
        checked: true,
        passed: true,
      });
      expect(mocks.execShell).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["19120 true\n", "200", true],
    ["19120 false\n", "200", false],
    ["19119 true\n", "200", false],
    ["19120 true\n19120 true\n", "200", false],
    ["19120 true\n", "500", false],
  ])(
    "requires the expected dashboard process and internal listener %s %s (#11433)",
    async (processOutput, status, expected) => {
      const document = mocks.validateNemoClawConfig.getMockImplementation()!();
      document.spec.sandboxes[0].agents[0].interfaces = {
        dashboard: { enabled: true, port: 19000, internalPort: 19120, tui: { enabled: true } },
        api: { port: 8643 },
      };
      mocks.validateNemoClawConfig.mockReturnValue(document);
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, "{}");
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      mocks.command
        .mockImplementationOnce(writeExport)
        .mockImplementationOnce(writeExport)
        .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
      mocks.execShell.mockResolvedValue({ exitCode: 0, stdout: processOutput, stderr: "" });
      mocks.exec.mockResolvedValue({ exitCode: 0, stdout: status, stderr: "" });
      const result = await runEnabledFixture([], true);
      expect(result).toEqual({ checked: true, passed: expected });
      expect(mocks.writeJson).toHaveBeenCalledWith(
        "hermes-config-export-live-evidence.json",
        expect.objectContaining({ interfacesMatch: true, dashboardRuntimeMatches: expected }),
      );
    },
  );
});
