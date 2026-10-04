// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HERMES_INTERFACE_DEFAULTS } from "../../../src/lib/config/model.ts";
import {
  expectedPinnedV1HermesNativeSettings,
  type PinnedV1ConsumerEvidence,
} from "../../support/v1-config-consumer.ts";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  load: vi.fn(),
  readSandboxPolicy: vi.fn(),
  save: vi.fn(),
  exec: vi.fn(),
  execShell: vi.fn(),
  writeJson: vi.fn(),
  writeText: vi.fn(),
  validateWithPinnedV1: vi.fn(),
}));

vi.mock("../../../src/lib/state/registry/persistence.ts", () => ({
  load: mocks.load,
  save: mocks.save,
}));

vi.mock("../../../src/lib/adapters/openshell/sandbox-policy-cli.ts", () => ({
  namedOpenShellGateway: (name: string) => ({ kind: "named", name }),
  cliOpenShellSandboxPolicyReader: { readSandboxPolicy: mocks.readSandboxPolicy },
}));

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
  verifyHermesConfigExportLive,
} from "../fixtures/hermes-config-export-live.ts";

const IMAGE_REF = "nvcr.io/nvidia/nemoclaw@sha256:" + "a".repeat(64);

function exportedHermesDocument(
  interfaces: Record<string, unknown> = { dashboard: { enabled: false } },
) {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "hermes",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: { management: "managed", endpoint: "http://127.0.0.1:8080" },
      inferenceProviders: [
        {
          name: "hosted-compatible-endpoint",
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
          network: { policy: { explicit: {} } },
          harness: { kind: "hermes", interfaces },
          agent: {
            name: "primary",
            inference: {
              routes: [
                {
                  name: "primary",
                  providerRef: "hosted-compatible-endpoint",
                  overrides: { model: "nvidia/model" },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

function exportedHermesYaml(interfaces?: Record<string, unknown>): string {
  return JSON.stringify(exportedHermesDocument(interfaces));
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
  mocks.readSandboxPolicy.mockReturnValue({ ok: false });
});

function passingEvidence(): Extract<HermesConfigExportLiveEvidence, { outcome: "published" }> {
  const consumerEvidence = pinnedConsumerEvidence(false, {});
  return {
    outcome: "published",
    agent: "hermes",
    aliasesEquivalent: true,
    checked: true,
    consumer: {
      expected: consumerEvidence,
      actual: { nemoclaw: consumerEvidence, nemohermes: consumerEvidence },
      passed: true,
    },
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    managedImageIsOmitted: true,
    interfacesMatch: true,
    dashboardRuntimeMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    sandboxNameMatches: true,
  };
}

function pinnedConsumerEvidence(
  dashboardEnabled: boolean,
  environment: NodeJS.ProcessEnv,
): PinnedV1ConsumerEvidence {
  return {
    revision: "88c6600c06b0937907290362eef86912052c4ad0",
    compiledSandboxes: 1,
    hermesNativeSettings: {
      hermes: expectedPinnedV1HermesNativeSettings({
        hermesApiPort: Number(
          environment.NEMOCLAW_HERMES_API_PORT ?? HERMES_INTERFACE_DEFAULTS.apiPort,
        ),
        hermesDashboardEnabled: dashboardEnabled,
        hermesDashboardPort: Number(
          environment.NEMOCLAW_DASHBOARD_PORT ?? HERMES_INTERFACE_DEFAULTS.dashboardPort,
        ),
        hermesDashboardInternalPort: Number(
          environment.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT ??
            HERMES_INTERFACE_DEFAULTS.dashboardInternalPort,
        ),
        hermesDashboardTui: environment.NEMOCLAW_HERMES_DASHBOARD_TUI === "TRUE",
      }),
    },
    openclawNativeSettingsVerified: 0,
    hermesNativeSettingsVerified: 1,
  };
}

async function runEnabledFixture(
  redactionValues: readonly string[] = [],
  dashboardEnabled = false,
  environment: NodeJS.ProcessEnv = {},
  consumerEvidence?: PinnedV1ConsumerEvidence,
) {
  let dispose: (() => void) | undefined;
  const env = {
    ...(dashboardEnabled
      ? {
          NEMOCLAW_DASHBOARD_PORT: "19000",
          NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: "19120",
          NEMOCLAW_HERMES_DASHBOARD_TUI: "TRUE",
          NEMOCLAW_HERMES_API_PORT: "8643",
        }
      : {}),
    ...environment,
  };
  mocks.validateWithPinnedV1.mockReturnValue(
    consumerEvidence ?? pinnedConsumerEvidence(dashboardEnabled, env),
  );
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
      env,
      host: { command: mocks.command },
      redactionValues,
      sandboxName: "hermes",
      validateWithPinnedV1: mocks.validateWithPinnedV1,
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
    "managedImageIsOmitted",
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
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["http", "https"])("accepts the exact Podman %s export refusal", async (scheme) => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          openshellDriver: "podman",
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: `${scheme}://host.openshell.internal:35271/v1`,
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    const diagnostics = [
      "Config export failed (unsupported).",
      "V1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred.",
      ...(scheme === "http"
        ? ["V1alpha1 requires HTTPS when an inference provider declares a credential."]
        : []),
    ].join("\n");
    mocks.command.mockResolvedValue({ exitCode: 2, stdout: "", stderr: diagnostics });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.writeJson).toHaveBeenCalledWith("hermes-config-export-live-evidence.json", {
      outcome: "expected-refusal",
      aliasesEquivalent: true,
      checked: true,
      credentialValuesOmitted: true,
      outputFilesAbsent: true,
      refusalCategory: "unsupported",
      refusalDiagnosticMatches: true,
    });
  });

  it.each([
    {
      label: "unrelated failure",
      exitCode: 2,
      extra: "\nunrelated failure",
      writeOutput: (_args: string[]) => undefined,
    },
    { label: "wrong exit", exitCode: 1, extra: "", writeOutput: (_args: string[]) => undefined },
    {
      label: "published file",
      exitCode: 2,
      extra: "",
      writeOutput: (args: string[]) =>
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, "{}"),
    },
  ])("rejects Podman refusal with $label", async ({ exitCode, extra, writeOutput }) => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          openshellDriver: "podman",
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          gatewayName: "nemoclaw",
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    mocks.command.mockImplementation(async (_command: string, args: string[]) => {
      writeOutput(args);
      return {
        exitCode,
        stdout: "",
        stderr:
          "Config export failed (unsupported).\nV1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred." +
          extra,
      };
    });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
  });

  it("rejects successful exports from both aliases for a Podman source", async () => {
    mocks.load().sandboxes.hermes.openshellDriver = "podman";
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedHermesYaml());
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
    await expect(
      runEnabledFixture([], false, { NEMOCLAW_HERMES_API_PORT: "8642" }),
    ).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
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

  it("withholds encoded credential material from retained YAML", async () => {
    const encoded = Buffer.from("secret-value", "utf8").toString("base64");
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(
        args.at(args.indexOf("--output") + 1)!,
        `${exportedHermesYaml()}\n# ${encoded}\n`,
      );
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
    const result = await runEnabledFixture(["secret-value"]);

    expect(result).toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        checked: true,
        credentialValuesOmitted: false,
        launchersSucceeded: true,
      }),
    );
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("rejects drift evidence when only one launcher reports identity drift (#11286)", async () => {
    const writeExport = async (_command: string, args: string[]) => {
      const outputPath = args.at(args.indexOf("--output") + 1)!;
      fs.writeFileSync(outputPath, exportedHermesYaml());
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

  it("withholds YAML when pinned Hermes settings differ from source intent", async () => {
    const raw = exportedHermesYaml();
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
    const mismatched = pinnedConsumerEvidence(false, {});
    mismatched.hermesNativeSettings!.hermes!.apiPort = 8643;

    await expect(runEnabledFixture([], false, {}, mismatched)).resolves.toEqual({
      checked: true,
      passed: false,
    });
    expect(mocks.validateWithPinnedV1).toHaveBeenCalledTimes(2);
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({ consumer: expect.objectContaining({ passed: false }) }),
    );
    expect(mocks.writeText).not.toHaveBeenCalled();
  });
});

describe("Hermes interface runtime evidence", () => {
  it.each([
    { apiPort: "8642", interfaces: { dashboard: { enabled: false } } },
    {
      apiPort: "8643",
      interfaces: { dashboard: { enabled: false }, api: { port: 8643 } },
    },
  ])(
    "checks API allocation $apiPort with the dashboard disabled (#11433)",
    async ({ apiPort, interfaces }) => {
      const raw = exportedHermesYaml(interfaces);
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
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
      expect(mocks.writeText).toHaveBeenCalledWith("hermes-config-export.yaml", raw);
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
      const raw = exportedHermesYaml({
        dashboard: { enabled: true, port: 19000, internalPort: 19120 },
        api: { port: 8643 },
      });
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
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
