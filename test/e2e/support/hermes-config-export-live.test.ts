// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { redactString } from "../fixtures/redaction.ts";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { V1_IMAGE_REF_PLACEHOLDER } from "../../../src/lib/domain/config/export-document.ts";
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
        runtime: { provider: "docker" },
        endpoint: "http://127.0.0.1:8080",
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
    revision: "d1d0c87e535f9c757f47dde6ee157e9859dd91fd",
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
      refusalCausesMatch: false,
      refusalCategoriesMatch: false,
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

  it("rejects consumer evidence that retains a failure", () => {
    const evidence = passingEvidence();
    expect(
      passesHermesConfigExportLiveEvidence({
        ...evidence,
        consumer: {
          ...evidence.consumer,
          failure: {
            alias: "nemoclaw",
            operation: "parse-export-with-pinned-v1",
            revision: pinnedConsumerEvidence().revision,
            diagnostic: "consumer failed",
          },
        },
      }),
    ).toBe(false);
  });

  it("accepts the unsupported credential-bearing HTTP refusal from both aliases", () => {
    expect(
      passesHermesConfigExportLiveEvidence({
        outcome: "expected-refusal",
        aliasesEquivalent: true,
        checked: true,
        credentialValuesOmitted: true,
        outputFilesAbsent: true,
        refusalCausesMatch: true,
        refusalCategoriesMatch: true,
      }),
    ).toBe(true);
  });

  it.each([
    "aliasesEquivalent",
    "credentialValuesOmitted",
    "outputFilesAbsent",
    "refusalCategoriesMatch",
    "refusalCausesMatch",
  ] as const)("rejects expected-refusal evidence when %s is false", (field) => {
    expect(
      passesHermesConfigExportLiveEvidence({
        outcome: "expected-refusal",
        aliasesEquivalent: true,
        checked: true,
        credentialValuesOmitted: true,
        outputFilesAbsent: true,
        refusalCausesMatch: true,
        refusalCategoriesMatch: true,
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
      refusalCausesMatch: true,
      refusalCategoriesMatch: true,
    });
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("accepts unsupported HTTP refusal after the real fixture redactor", async () => {
    mocks.load().sandboxes.hermes.endpointUrl = "http://host.openshell.internal:35271/v1";
    const diagnostic = redactString(
      "Config export failed (unsupported).\nspec.inferenceProviders[].credential (unsupported): V1alpha1 requires HTTPS when an inference provider declares a credential.",
    );
    expect(diagnostic).toContain("credential <REDACTED>");
    mocks.command.mockResolvedValue({ exitCode: 2, stdout: "", stderr: diagnostic });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("accepts different redacted details when both aliases report the same refusal category", async () => {
    mocks.load().sandboxes.hermes.endpointUrl = "http://host.openshell.internal:35271/v1";
    mocks.command
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr:
          "Config export failed (unsupported).\nspec.inferenceProviders[].credential (unsupported): First detail.",
      })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr:
          "Config export failed (unsupported).\nspec.inferenceProviders[].credential <REDACTED> Different detail.",
      });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
  });

  it.each([
    {
      name: "HTTP credential",
      driver: "docker",
      endpoint: "http:",
      messaging: undefined,
      fields: [],
    },
    { name: "Podman", driver: "podman", endpoint: "https:", messaging: undefined, fields: [] },
    {
      name: "messaging",
      driver: "docker",
      endpoint: "https:",
      messaging: { schemaVersion: 1, plan: { channels: [] } },
      fields: [],
    },
    ...[
      "spec.inferenceProviders[].credential",
      "spec.sandboxes[].runtime.provider",
      "spec.sandboxes[].integrations.messaging",
    ].map((missing) => ({
      name: `combined source missing ${missing}`,
      driver: "podman",
      endpoint: "http:",
      messaging: { schemaVersion: 1, plan: { channels: [] } },
      fields: [
        "spec.inferenceProviders[].credential",
        "spec.sandboxes[].runtime.provider",
        "spec.sandboxes[].integrations.messaging",
      ].filter((field) => field !== missing),
    })),
  ])(
    "rejects unrelated or incomplete refusal causes for $name",
    async ({ driver, endpoint, messaging, fields }) => {
      Object.assign(mocks.load().sandboxes.hermes, {
        openshellDriver: driver,
        endpointUrl: `${endpoint}//host.openshell.internal:35271/v1`,
        messaging,
      });
      mocks.command.mockResolvedValue({
        exitCode: 2,
        stdout: "",
        stderr: redactString(
          [
            "Config export failed (unsupported).",
            "source.workload.startupProfile (unsupported): Unrelated refusal.",
            ...fields.map((field) => `${field} (unsupported): Expected cause.`),
          ].join("\n"),
        ),
      });
      await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
      expect(mocks.writeText).not.toHaveBeenCalled();
    },
  );

  it("requires every active refusal cause from each alias after redaction", async () => {
    Object.assign(mocks.load().sandboxes.hermes, {
      openshellDriver: "podman",
      endpointUrl: "http://host.openshell.internal:35271/v1",
      messaging: { schemaVersion: 1, plan: { channels: [] } },
    });
    const diagnostic = redactString(
      [
        "Config export failed (unsupported).",
        "spec.inferenceProviders[].credential (unsupported): HTTP credential refusal.",
        "spec.sandboxes[].runtime.provider (unsupported): Podman refusal.",
        "spec.sandboxes[].integrations.messaging (unsupported): Messaging refusal.",
      ].join("\n"),
    );
    mocks.command.mockResolvedValue({ exitCode: 2, stdout: "", stderr: diagnostic });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    mocks.command
      .mockResolvedValueOnce({ exitCode: 2, stdout: "", stderr: diagnostic })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr: diagnostic.split("\n").slice(0, -1).join("\n"),
      });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
  });

  it("rejects different category sets from the two aliases", async () => {
    mocks.load().sandboxes.hermes.messaging = { schemaVersion: 1, plan: { channels: [] } };
    mocks.command
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr:
          "Config export failed (unsupported).\nspec.sandboxes[].integrations.messaging (unsupported): Detail.",
      })
      .mockResolvedValueOnce({
        exitCode: 2,
        stdout: "",
        stderr:
          "Config export failed (unsupported, policy-not-representable).\nspec.sandboxes[].integrations.messaging (unsupported): Detail.\nspec.sandboxes[].network.policy (policy-not-representable): Detail.",
      });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: false });
    expect(mocks.writeJson).toHaveBeenCalledWith(
      "hermes-config-export-live-evidence.json",
      expect.objectContaining({ aliasesEquivalent: false, refusalCategoriesMatch: true }),
    );
  });

  it.each([
    { plan: EMPTY_MESSAGING_PLAN, format: "full" },
    { plan: compactSandboxMessagingPlanForPersistence(EMPTY_MESSAGING_PLAN), format: "compact" },
  ])("accepts unsupported HTTP refusal with $format empty messaging", async ({ plan }) => {
    Object.assign(mocks.load().sandboxes.hermes, {
      name: "hermes",
      agent: "hermes",
      endpointUrl: "http://host.openshell.internal:35271/v1",
      messaging: { schemaVersion: 1, plan },
    });
    mocks.command.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr:
        "Config export failed (unsupported).\nspec.inferenceProviders[].credential <REDACTED> Detail.",
    });
    await expect(runEnabledFixture()).resolves.toEqual({ checked: true, passed: true });
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

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
        refusalCausesMatch: true,
        refusalCategoriesMatch: true,
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
        refusalCausesMatch: true,
        refusalCategoriesMatch: true,
      }),
    );
  });

  it.each([
    ...["unsupported, unsupported", "", "unsupported,unknown"].map((categories) => ({
      name: `invalid category header: ${categories}`,
      scheme: "https",
      driver: "docker",
      diagnostics: `Config export failed (${categories}).`,
    })),
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
      name: "policy category without a policy finding",
      scheme: "https",
      driver: "docker",
      diagnostics: [
        "Config export failed (unsupported, policy-not-representable).",
        "spec.sandboxes[].integrations.messaging (unsupported): Messaging is excluded.",
      ].join("\n"),
    },
    {
      name: "policy finding without its header category",
      scheme: "https",
      driver: "docker",
      diagnostics: [
        "Config export failed (unsupported).",
        "spec.sandboxes[].integrations.messaging (unsupported): Messaging is excluded.",
        "spec.sandboxes[].network.policy (policy-not-representable): Policy is not representable.",
      ].join("\n"),
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
      name: "unrelated category with only expected findings",
      scheme: "https",
      driver: "docker",
      diagnostics:
        "Config export failed (unsupported, drifted).\nspec.sandboxes[].integrations.messaging (unsupported): V1 export does not support messaging.",
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
        expect.objectContaining({ refusalCategoriesMatch: false }),
      );
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it.each(["http", "https"])("accepts unsupported Podman %s export refusal", async (scheme) => {
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
      refusalCausesMatch: true,
      refusalCategoriesMatch: true,
    });
  });

  it.each([
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
      aliasesEquivalent: true,
      checked: true,
      credentialValuesOmitted: false,
      outputFilesAbsent: true,
      refusalCausesMatch: true,
      refusalCategoriesMatch: true,
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

  it.each([
    { alias: "nemoclaw", preceding: [] },
    { alias: "nemohermes", preceding: [pinnedConsumerEvidence()] },
  ] as const)(
    "retains a bounded redacted consumer exception for $alias and removes private exports",
    async ({ alias, preceding }) => {
      const secret = "private-consumer-value";
      const writeExport = async (_command: string, args: string[]) => {
        fs.writeFileSync(args.at(args.indexOf("--output") + 1)!, exportedHermesYaml());
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      mocks.command
        .mockImplementationOnce(writeExport)
        .mockImplementationOnce(writeExport)
        .mockResolvedValue({ exitCode: 1, stderr: "sandbox identity drifted", stdout: "" });
      preceding.forEach((summary) => mocks.validateWithPinnedV1.mockReturnValueOnce(summary));
      mocks.validateWithPinnedV1.mockImplementationOnce(() => {
        throw new Error(`consumer failed: ${secret} ${"details ".repeat(700)}`);
      });

      await expect(runEnabledFixture([secret])).resolves.toEqual({ checked: true, passed: false });
      const evidence = mocks.writeJson.mock.calls.find(
        ([name]) => name === "hermes-config-export-live-evidence.json",
      )![1];
      expect(evidence.consumer.passed).toBe(false);
      expect(evidence.consumer.failure).toEqual({
        alias,
        operation: "parse-export-with-pinned-v1",
        revision: pinnedConsumerEvidence().revision,
        diagnostic: expect.stringContaining("[REDACTED]"),
      });
      expect(evidence.consumer.failure.diagnostic.length).toBeLessThanOrEqual(2000);
      expect(JSON.stringify(evidence)).not.toContain(secret);
      expect(evidence.consumer.actual).toEqual(
        alias === "nemohermes" ? { nemoclaw: pinnedConsumerEvidence() } : {},
      );
      expect(mocks.validateWithPinnedV1).toHaveBeenCalledTimes(alias === "nemohermes" ? 2 : 1);
      expect(mocks.writeText).not.toHaveBeenCalled();
      const args = mocks.command.mock.calls[0]![1] as string[];
      expect(fs.existsSync(path.dirname(args[args.indexOf("--output") + 1]!))).toBe(false);
    },
  );

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
