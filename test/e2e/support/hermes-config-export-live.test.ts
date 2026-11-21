// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1_IMAGE_REF_PLACEHOLDER } from "../../../src/lib/domain/config/export-document.ts";
import { V1ALPHA1_CHECKED_REVISION } from "../../../src/lib/domain/config/v1alpha1-checked-revision.ts";
import { MessagingSetupApplier } from "../../../src/lib/messaging/applier/setup-applier.ts";
import { compactSandboxMessagingPlanForPersistence } from "../../../src/lib/messaging/persistence.ts";
import type { V1ParseSummary } from "../../support/v1-parse-consumer.ts";

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
const EMPTY_MESSAGING_PLAN = MessagingSetupApplier.emptyPlan("hermes", "hermes");

function exportedHermesDocument() {
  return {
    apiVersion: "nemoclaw.nvidia.com/v1alpha1",
    kind: "NemoClawConfig",
    metadata: {
      name: "hermes",
      uid: "123e4567-e89b-42d3-a456-426614174000",
    },
    spec: {
      gateway: {
        management: "managed",
        target: { docker: { port: 8080 } },
      },
      inferenceProviders: {
        "hosted-compatible-endpoint": {
          provider: "openai",
          api: "openai-completions",
          endpoint: "https://integrate.api.nvidia.com/v1",
          credential: { env: "NVIDIA_API_KEY" },
        },
      },
      sandboxes: {
        hermes: {
          image: { ref: V1_IMAGE_REF_PLACEHOLDER },
          network: { policy: { explicit: {} } },
          harness: { kind: "nvidia.fabric.hermes" },
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
      },
    },
  };
}

function exportedHermesYaml(): string {
  return JSON.stringify(exportedHermesDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({
    sandboxes: {
      hermes: {
        credentialEnv: "NVIDIA_API_KEY",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        workload: { kind: "managed-image", reference: IMAGE_REF },
      },
    },
  });
  mocks.readSandboxPolicy.mockReturnValue({ ok: false });
});

function passingEvidence(): Extract<HermesConfigExportLiveEvidence, { outcome: "published" }> {
  const consumerEvidence = pinnedConsumerEvidence();
  return {
    outcome: "published",
    agent: "nvidia.fabric.hermes",
    aliasesEquivalent: true,
    checked: true,
    consumer: {
      expected: consumerEvidence,
      actual: { nemoclaw: consumerEvidence, nemohermes: consumerEvidence },
      passed: true,
    },
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    gatewayPortMatches: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    managedImageIsPlaceholder: true,
    interfacesOmitted: true,
    dashboardRuntimeMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    sandboxNameMatches: true,
  };
}

function pinnedConsumerEvidence(): V1ParseSummary {
  return {
    revision: V1ALPHA1_CHECKED_REVISION,
    sandboxes: {
      hermes: {
        harnessKind: "nvidia.fabric.hermes",
        imageRef: V1_IMAGE_REF_PLACEHOLDER,
        integrationRefs: [],
      },
    },
    integrations: {},
  };
}

async function runEnabledFixture(
  redactionValues: readonly string[] = [],
  dashboardEnabled = false,
  environment: NodeJS.ProcessEnv = {},
  consumerEvidence?: V1ParseSummary,
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
  mocks.validateWithPinnedV1.mockReturnValue(consumerEvidence ?? pinnedConsumerEvidence());
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
  it.each([
    { label: "full", plan: EMPTY_MESSAGING_PLAN },
    { label: "compact", plan: compactSandboxMessagingPlanForPersistence(EMPTY_MESSAGING_PLAN) },
  ])("validates published exports with a $label empty messaging plan", async ({ plan }) => {
    Object.assign(mocks.load().sandboxes.hermes, {
      name: "hermes",
      agent: "hermes",
      messaging: { schemaVersion: 1, plan },
    });
    const raw = exportedHermesYaml();
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      passingEvidence(),
    );
    expect(mocks.writeText).toHaveBeenCalledWith("hermes-config-export.yaml", raw);
  });

  it.each([
    {
      label: "configured",
      plan: { ...EMPTY_MESSAGING_PLAN, channels: [{ channelId: "telegram", configured: true }] },
    },
    { label: "malformed", plan: { channels: [] } },
  ])("rejects published exports with a $label messaging plan", async ({ plan }) => {
    Object.assign(mocks.load().sandboxes.hermes, {
      name: "hermes",
      agent: "hermes",
      messaging: { schemaVersion: 1, plan },
    });
    mocks.command.mockImplementation(async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedHermesYaml());
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith("hermes-config-export-live-evidence.json", {
      outcome: "expected-refusal",
      aliasesEquivalent: false,
      checked: true,
      credentialValuesOmitted: true,
      outputFilesAbsent: false,
      refusalCategory: null,
      refusalDiagnosticMatches: false,
    });
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.readSandboxPolicy).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts the complete redacted export contract", () => {
    expect(passesHermesConfigExportLiveEvidence(passingEvidence())).toBe(true);
  });

  it.each([
    "aliasesEquivalent",
    "credentialReferenceMatches",
    "credentialValuesOmitted",
    "gatewayPortMatches",
    "identityDriftPreventedPublication",
    "identityDriftReported",
    "managedImageIsPlaceholder",
    "interfacesOmitted",
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
        "Config export failed (unsupported).\nspec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.\n",
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

  it.each([
    { plan: EMPTY_MESSAGING_PLAN, format: "full", extraMessagingRefusal: false, passed: true },
    { plan: EMPTY_MESSAGING_PLAN, format: "full", extraMessagingRefusal: true, passed: false },
    {
      plan: compactSandboxMessagingPlanForPersistence(EMPTY_MESSAGING_PLAN),
      format: "compact",
      extraMessagingRefusal: false,
      passed: true,
    },
    {
      plan: compactSandboxMessagingPlanForPersistence(EMPTY_MESSAGING_PLAN),
      format: "compact",
      extraMessagingRefusal: true,
      passed: false,
    },
  ])(
    "requires only the HTTP refusal for $format empty messaging (extra messaging refusal: $extraMessagingRefusal)",
    async ({ plan, extraMessagingRefusal, passed }) => {
      Object.assign(mocks.load().sandboxes.hermes, {
        name: "hermes",
        agent: "hermes",
        endpointUrl: "http://host.openshell.internal:35271/v1",
        messaging: { schemaVersion: 1, plan },
      });
      mocks.command.mockResolvedValue({
        exitCode: 2,
        stdout: "",
        stderr: [
          "Config export failed (unsupported).",
          ...(extraMessagingRefusal
            ? [
                "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
              ]
            : []),
          "spec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.",
        ].join("\n"),
      });

      await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed });
      expect(mocks.writeJson).toHaveBeenCalledWith(
        "hermes-config-export-live-evidence.json",
        expect.objectContaining({
          outcome: "expected-refusal",
          refusalDiagnosticMatches: passed,
        }),
      );
      expect(mocks.writeText).not.toHaveBeenCalled();
    },
  );

  it.each(["https", "http"])(
    "accepts messaging refusal from both aliases with %s endpoint",
    async (scheme) => {
      mocks.load.mockReturnValue({
        sandboxes: {
          hermes: {
            credentialEnv: "NVIDIA_API_KEY",
            endpointUrl: `${scheme}://host.openshell.internal:35271/v1`,
            gatewayName: "nemoclaw",
            messaging: { schemaVersion: 1, plan: { channels: [] } },
            workload: { kind: "managed-image", reference: IMAGE_REF },
          },
        },
      });
      const diagnostics = [
        "Config export failed (unsupported).",
        "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
        ...(scheme === "http"
          ? [
              "spec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.",
            ]
          : []),
      ].join("\n");
      mocks.command.mockResolvedValue({ exitCode: 2, stdout: "", stderr: diagnostics });
      mocks.readSandboxPolicy.mockRejectedValue(new Error("policy unavailable"));

      await expect(runEnabledFixture(["secret-value"])).resolves.toEqual({
        checked: true,
        passed: true,
      });
      expect(mocks.readSandboxPolicy).not.toHaveBeenCalled();
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
    },
  );

  it.each([
    "unsupported",
    "unsupported, policy-not-representable",
    "policy-not-representable, unsupported",
  ])("accepts messaging refusal alongside categories %s", async (categories) => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          gatewayName: "nemoclaw",
          messaging: { schemaVersion: 1, plan: { channels: [] } },
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    mocks.command.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: [
        `Config export failed (${categories}).`,
        "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
        "source.sandbox.providers (unsupported): The sandbox provider attachments do not match its supported configuration.",
        "source.workload.startupProfile (unsupported): The managed startup profile is not the canonical profile supported by v1 export.",
        ...(categories.includes("policy-not-representable")
          ? [
              "spec.sandboxes[].network.policy (policy-not-representable): Verified effective policy is malformed, unknown, or cannot be represented losslessly.",
            ]
          : []),
      ].join("\n"),
    });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        refusalCategory: "unsupported",
        refusalDiagnosticMatches: true,
      }),
    );
  });

  it.each([
    {
      name: "unrelated messaging failure",
      scheme: "https",
      driver: "docker",
      diagnostics: "messaging export crashed",
    },
    {
      name: "missing refusal category",
      scheme: "https",
      driver: "docker",
      diagnostics:
        "Config export failed (drifted).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
    {
      name: "policy category without unsupported messaging category",
      scheme: "https",
      driver: "docker",
      diagnostics:
        "Config export failed (policy-not-representable).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
    {
      name: "vague messaging detail",
      scheme: "https",
      driver: "docker",
      diagnostics: "Config export failed (unsupported).\nUnexpected messaging failure.",
    },
    {
      name: "missing HTTP credential refusal",
      scheme: "http",
      driver: "docker",
      diagnostics:
        "Config export failed (unsupported).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
    {
      name: "unexpected identity drift alongside messaging refusal",
      scheme: "https",
      driver: "docker",
      diagnostics: [
        "Config export failed (unsupported, drifted).",
        "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
        "Registry and live gateway bindings differ.",
      ].join("\n"),
    },
    {
      name: "undocumented finding in the unsupported category",
      scheme: "https",
      driver: "docker",
      diagnostics: [
        "Config export failed (unsupported).",
        "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
        "Unexpected export observation failure.",
      ].join("\n"),
    },
    {
      name: "unrelated category with only expected findings",
      scheme: "https",
      driver: "docker",
      diagnostics:
        "Config export failed (unsupported, drifted).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
    {
      name: "policy category without its finding",
      scheme: "https",
      driver: "docker",
      diagnostics:
        "Config export failed (unsupported, policy-not-representable).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
    {
      name: "policy finding without its category",
      scheme: "https",
      driver: "docker",
      diagnostics: [
        "Config export failed (unsupported).",
        "spec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
        "spec.sandboxes[].network.policy (policy-not-representable): Verified effective policy is malformed, unknown, or cannot be represented losslessly.",
      ].join("\n"),
    },
    {
      name: "missing Podman refusal",
      scheme: "https",
      driver: "podman",
      diagnostics:
        "Config export failed (unsupported).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
    },
  ])(
    "rejects $name as expected messaging refusal evidence",
    async ({ scheme, driver, diagnostics }) => {
      mocks.load.mockReturnValue({
        sandboxes: {
          hermes: {
            credentialEnv: "NVIDIA_API_KEY",
            endpointUrl: `${scheme}://host.openshell.internal:35271/v1`,
            gatewayName: "nemoclaw",
            openshellDriver: driver,
            messaging: { schemaVersion: 1, plan: { channels: [] } },
            workload: { kind: "managed-image", reference: IMAGE_REF },
          },
        },
      });
      mocks.command.mockResolvedValue({ exitCode: 2, stdout: "", stderr: diagnostics });
      await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
      expect(mocks.writeJson).toHaveBeenCalledWith(
        "hermes-config-export-live-evidence.json",
        expect.objectContaining({ refusalCategory: null, refusalDiagnosticMatches: false }),
      );
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("rejects other unsupported findings without the messaging refusal", async () => {
    mocks.load.mockReturnValue({
      sandboxes: {
        hermes: {
          credentialEnv: "NVIDIA_API_KEY",
          endpointUrl: "https://integrate.api.nvidia.com/v1",
          gatewayName: "nemoclaw",
          messaging: { schemaVersion: 1, plan: { channels: [] } },
          workload: { kind: "managed-image", reference: IMAGE_REF },
        },
      },
    });
    mocks.command.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: [
        "Config export failed (unsupported).",
        "source.sandbox.providers (unsupported): The sandbox provider attachments do not match its supported configuration.",
      ].join("\n"),
    });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
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
      "spec.sandboxes[].runtime.provider (unsupported): V1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred.",
      ...(scheme === "http"
        ? [
            "spec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.",
          ]
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
          "Config export failed (unsupported).\nspec.sandboxes[].runtime.provider (unsupported): V1alpha1 export currently supports the Docker runtime; Podman compatibility is deferred." +
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
          "Config export failed (unsupported).\nspec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.\n",
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
      "Config export failed (unsupported).\nspec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.";
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

  it("withholds YAML when the pinned v1 parse differs from source intent", async () => {
    const raw = exportedHermesYaml();
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, raw);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
    const mismatched = pinnedConsumerEvidence();
    mismatched.sandboxes.hermes!.harnessKind = "hermes";

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

  it("withholds YAML when the exported Docker port differs from the registry gateway port (#14696)", async () => {
    const exported = exportedHermesDocument();
    exported.spec.gateway.target.docker.port = 18_081;
    const writeExport = async (_command: string, args: string[]) => {
      fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, JSON.stringify(exported));
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    mocks.command
      .mockImplementationOnce(writeExport)
      .mockImplementationOnce(writeExport)
      .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });

    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({
        gatewayPortMatches: false,
        consumer: expect.objectContaining({ passed: true }),
      }),
    );
    expect(mocks.writeText).not.toHaveBeenCalled();
  });
});

describe("Hermes interface runtime evidence", () => {
  it.each([{ apiPort: "8642" }, { apiPort: "8643" }])(
    "leaves interfaces out of the export for API allocation $apiPort with the dashboard disabled (#11433)",
    async ({ apiPort }) => {
      const raw = exportedHermesYaml();
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
      const raw = exportedHermesYaml();
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
        expect.objectContaining({ interfacesOmitted: true, dashboardRuntimeMatches: expected }),
      );
    },
  );
});
