// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  load: vi.fn(),
  readSandboxPolicy: vi.fn(),
  save: vi.fn(),
  exec: vi.fn(),
  execShell: vi.fn(),
  getBuildIdentity: vi.fn(),
  writeJson: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../../src/lib/state/registry/persistence.ts", () => ({
  load: mocks.load,
  save: mocks.save,
}));

vi.mock("../../../src/lib/adapters/openshell/sandbox-policy-cli.ts", () => ({
  namedOpenShellGateway: (name: string) => ({ kind: "named", name }),
  cliOpenShellSandboxPolicyReader: { readSandboxPolicy: mocks.readSandboxPolicy },
}));

vi.mock("../../../src/lib/core/version.ts", () => ({
  getBuildIdentity: mocks.getBuildIdentity,
}));

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
  verifyHermesConfigExportLive,
} from "../fixtures/hermes-config-export-live.ts";

const IMAGE_REF = "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64);
const PRODUCER_REVISION = "b".repeat(40);

function exportedConfigRaw(
  interfaces?: Record<string, unknown>,
  uid = "00000000-0000-4000-8000-000000000000",
): string {
  return YAML.stringify({
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: { name: "hermes", uid },
    spec: {
      gateway: { management: "managed", endpoint: "https://gateway.example.test" },
      inferenceProviders: [
        {
          name: "nvidia",
          provider: "openai",
          api: "openai-completions",
          endpoint: "https://integrate.api.nvidia.com/v1",
          credential: { env: "NVIDIA_API_KEY" },
        },
      ],
      sandboxes: [
        {
          name: "hermes",
          runtime: { provider: "docker" },
          image: null,
          network: { policy: { explicit: {} } },
          harness: { kind: "hermes", ...(interfaces === undefined ? {} : { interfaces }) },
          agent: {
            name: "primary",
            inference: {
              routes: [
                { name: "default", providerRef: "nvidia", overrides: { model: "nvidia/model" } },
              ],
            },
          },
        },
      ],
    },
  });
}

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
  mocks.readSandboxPolicy.mockReturnValue({
    ok: true,
    value: { appliedRevision: 1, document: "version: 1" },
  });
  mocks.getBuildIdentity.mockReturnValue({
    nemoclawVersion: "0.1.0",
    sourceRevision: PRODUCER_REVISION,
  });
});

function passingEvidence(): Extract<HermesConfigExportLiveEvidence, { outcome: "published" }> {
  return {
    outcome: "published",
    agent: "hermes",
    aliasesEquivalent: true,
    checked: true,
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    managedImagePlaceholderIsNull: true,
    interfacesMatch: true,
    dashboardRuntimeMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    producer: { sourceRevision: PRODUCER_REVISION },
    sandboxNameMatches: true,
    yaml: {
      nemoclaw: {
        artifact: "hermes-config-export-nemoclaw.yaml",
        sha256: "c".repeat(64),
      },
      nemohermes: {
        artifact: "hermes-config-export-nemohermes.yaml",
        sha256: "d".repeat(64),
      },
    },
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
      artifacts: { writeJson: mocks.writeJson, writeText: mocks.writeText },
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
    "managedImagePlaceholderIsNull",
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

  it("rejects evidence without an exact producer revision", () => {
    expect(
      passesHermesConfigExportLiveEvidence({
        ...passingEvidence(),
        producer: { sourceRevision: "main" },
      }),
    ).toBe(false);
  });

  it("rejects evidence without both YAML digests", () => {
    const evidence = passingEvidence();
    expect(
      passesHermesConfigExportLiveEvidence({
        ...evidence,
        yaml: {
          ...evidence.yaml,
          nemohermes: { ...evidence.yaml.nemohermes, sha256: "" },
        },
      }),
    ).toBe(false);
  });

  it("accepts the exact credential-bearing HTTP refusal from both aliases", () => {
    expect(
      passesHermesConfigExportLiveEvidence({
        outcome: "expected-refusal",
        aliasesEquivalent: true,
        checked: true,
        credentialValuesOmitted: true,
        outputFilesAbsent: true,
        refusalCategory: "unsupported",
        refusalDiagnosticMatches: true,
      }),
    ).toBe(true);
  });

  it("stops before export when the effective policy observation fails", async () => {
    mocks.readSandboxPolicy.mockReturnValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "policy unavailable" },
    });

    await expect(runEnabledFixture()).rejects.toThrow(
      "the effective sandbox policy could not be read: policy unavailable",
    );
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.writeJson).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("retains both secret-free YAML exports with digests and producer revision", async () => {
    const nemoclawRaw = exportedConfigRaw();
    const nemohermesRaw = exportedConfigRaw(undefined, "10000000-0000-4000-8000-000000000000");
    const writeExport = (raw: string) => async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport(nemoclawRaw))
      .mockImplementationOnce(writeExport(nemohermesRaw))
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.writeText).toHaveBeenNthCalledWith(
      1,
      "hermes-config-export-nemoclaw.yaml",
      nemoclawRaw,
    );
    expect(mocks.writeText).toHaveBeenNthCalledWith(
      2,
      "hermes-config-export-nemohermes.yaml",
      nemohermesRaw,
    );
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        producer: { sourceRevision: PRODUCER_REVISION },
        yaml: {
          nemoclaw: {
            artifact: "hermes-config-export-nemoclaw.yaml",
            sha256: createHash("sha256").update(nemoclawRaw).digest("hex"),
          },
          nemohermes: {
            artifact: "hermes-config-export-nemohermes.yaml",
            sha256: createHash("sha256").update(nemohermesRaw).digest("hex"),
          },
        },
      }),
    );
  });

  it.each([
    "aliasesEquivalent",
    "credentialValuesOmitted",
    "outputFilesAbsent",
    "refusalDiagnosticMatches",
  ] as const)("rejects expected-refusal evidence when %s is false", (field) => {
    expect(
      passesHermesConfigExportLiveEvidence({
        outcome: "expected-refusal",
        aliasesEquivalent: true,
        checked: true,
        credentialValuesOmitted: true,
        outputFilesAbsent: true,
        refusalCategory: "unsupported",
        refusalDiagnosticMatches: true,
        [field]: false,
      }),
    ).toBe(false);
  });

  it("accepts the live mock route only when both aliases refuse the unsupported export", async () => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "http://host.openshell.internal:35271/v1",
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    const refusal = {
      exitCode: 2,
      stdout: "",
      stderr:
        "Config export failed (unsupported).\nV1alpha1 requires HTTPS when an inference provider declares a credential.\n",
    };
    mocks.command.mockResolvedValue(refusal);

    await expect(runEnabledFixture(["secret-value"])).resolves.toEqual({
      checked: true,
      passed: true,
    });
    expect(mocks.writeJson).toHaveBeenCalledWith("hermes-config-export-live-evidence.json", {
      outcome: "expected-refusal",
      aliasesEquivalent: true,
      checked: true,
      credentialValuesOmitted: true,
      outputFilesAbsent: true,
      refusalCategory: "unsupported",
      refusalDiagnosticMatches: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("rejects a credential-bearing HTTP refusal when one alias publishes output", async () => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "http://host.openshell.internal:35271/v1",
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    mocks.command
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr:
          "Config export failed (unsupported).\nV1alpha1 requires HTTPS when an inference provider declares a credential.\n",
      })
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, "{}");
        return { exitCode: 0, stderr: "", stdout: "" };
      });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        outcome: "expected-refusal",
        aliasesEquivalent: false,
        outputFilesAbsent: false,
      }),
    );
  });

  it("rejects a credential-bearing HTTP refusal with extra diagnostic output", async () => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "http://host.openshell.internal:35271/v1",
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    const refusal =
      "Config export failed (unsupported).\nV1alpha1 requires HTTPS when an inference provider declares a credential.";
    mocks.command
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: `${refusal}\n` })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: `${refusal}\nunexpected diagnostic: secret-value\n`,
      });

    await expect(runEnabledFixture(["secret-value"])).resolves.toEqual({
      checked: true,
      passed: false,
    });
    expect(mocks.writeJson).toHaveBeenCalledWith("hermes-config-export-live-evidence.json", {
      outcome: "expected-refusal",
      aliasesEquivalent: false,
      checked: true,
      credentialValuesOmitted: false,
      outputFilesAbsent: true,
      refusalCategory: null,
      refusalDiagnosticMatches: false,
    });
  });

  it("rejects an encoded credential in an expected-refusal diagnostic", async () => {
    const secret = "secret-value";
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "http://host.openshell.internal:35271/v1",
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    const encodedSecret = [...Buffer.from(secret)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    const refusal =
      "Config export failed (unsupported).\nV1alpha1 requires HTTPS when an inference provider declares a credential.";
    mocks.command
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: `${refusal}\n` })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: `${refusal}\nunexpected diagnostic: ${encodedSecret}\n`,
      });

    await expect(runEnabledFixture([secret])).resolves.toEqual({
      checked: true,
      passed: false,
    });
    expect(mocks.writeJson).toHaveBeenCalledWith("hermes-config-export-live-evidence.json", {
      outcome: "expected-refusal",
      aliasesEquivalent: false,
      checked: true,
      credentialValuesOmitted: false,
      outputFilesAbsent: true,
      refusalCategory: null,
      refusalDiagnosticMatches: false,
    });
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
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("rejects a malformed staged document before retaining either YAML export", async () => {
    const malformed = YAML.parse(exportedConfigRaw()) as {
      spec: { sandboxes: Array<Record<string, unknown>> };
    };
    const sandbox = malformed.spec.sandboxes[0]!;
    sandbox.agents = [sandbox.agent];
    delete sandbox.agent;
    const writeExport = (raw: string) => async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport(exportedConfigRaw()))
      .mockImplementationOnce(writeExport(YAML.stringify(malformed)));

    await expect(runEnabledFixture()).rejects.toThrow(
      "exported configuration must match the complete staged v1alpha1 shape",
    );
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects symlink substitution without retaining target contents", async () => {
    mocks.command
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = args.at(args.indexOf("--output") + 1)!;
        const targetPath = `${outputPath}.host-file`;
        fs.writeFileSync(targetPath, exportedConfigRaw());
        fs.symlinkSync(targetPath, outputPath);
        return { exitCode: 0, stderr: "", stdout: "" };
      })
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedConfigRaw());
        return { exitCode: 0, stderr: "", stdout: "" };
      });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects drift evidence when only one launcher reports identity drift (#11286)", async () => {
    const writeExport = async (_command: string, args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, exportedConfigRaw());
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
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedConfigRaw(interfaces));
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
      const interfaces = {
        dashboard: { enabled: true, port: 19000, internalPort: 19120, tui: { enabled: true } },
        api: { port: 8643 },
      };
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedConfigRaw(interfaces));
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
