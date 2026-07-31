// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { HermesToolGatewayCloneBroker } from "../../hermes-tool-gateway-clone-broker";
import {
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
} from "../../onboard/managed-startup/profile";
import { captureSandboxRebuildAuthority } from "../../state/registry/rebuild-authority";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type { SnapshotRestoreAuthority } from "../../state/sandbox";
import {
  HERMES_INFERENCE_CREDENTIAL_ENV,
  HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
  HermesManagedCloneBrokerTransactionError,
  prepareHermesManagedCloneBrokerTransaction,
  provisionHermesManagedCloneBrokerTransaction,
  resolveHermesManagedCloneCredentialEnvironment,
} from "./snapshot/hermes-managed-clone-broker";

const CONTENT_AUTHORITY = {
  schemaVersion: 1,
  backupPath: "/tmp/nemoclaw-hermes-clone-source",
  contentSha256: "c".repeat(64),
} as const satisfies SnapshotRestoreAuthority;

function hermesProfile(): ManagedStartupProfile {
  const profile = managedStartupE2eProfile("hermes");
  return {
    ...profile,
    tools: { ...profile.tools, enabledGateways: ["nous-web"] },
  };
}

function workload(profile: ManagedStartupProfile) {
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    schemaVersion: 1 as const,
    kind: "managed-image" as const,
    reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64" as const,
    release: "v0.0.99",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-123456-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  } satisfies Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;
}

function sourceEntry(profile: ManagedStartupProfile): SandboxEntry {
  const receipt = workload(profile);
  return {
    name: "source",
    agent: "hermes",
    openshellDriver: "docker",
    imageTag: receipt.reference,
    workload: receipt,
    lifecycleGeneration: "generation-source",
    lifecycleLiveIdentityFingerprint: createHash("sha256").update("source").digest("hex"),
    provider: profile.inference.upstreamProvider,
    model: profile.inference.model,
    hermesToolGateways: ["nous-web"],
    hermesInferenceProvider: "source-hermes-inference",
  };
}

function handoff(profile = hermesProfile()) {
  const source = sourceEntry(profile);
  return {
    providerId: "docker",
    sourceSandboxName: "source",
    destinationSandboxName: "destination",
    sourceRegistryAuthority: captureSandboxRebuildAuthority(source, "docker"),
    snapshotRestoreAuthority: CONTENT_AUTHORITY,
    rebound: {
      profile,
      encodedProfile:
        source.workload?.kind === "managed-image" ? source.workload.encodedProfile : "",
      startupProfileSha256:
        source.workload?.kind === "managed-image" ? source.workload.startupProfileSha256 : "",
    },
  };
}

function providerMetadata(name: string, type: string, credential: string): string {
  return [
    `Name: ${name}`,
    `Type: ${type}`,
    `Credential keys: ${credential}`,
    "Config keys: <none>",
    "",
  ].join("\n");
}

function providerRunner() {
  const live = new Map<string, { type: string; credential: string }>();
  const createCredentials = new Map<string, string>();
  const run = vi.fn((args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
    if (args[0] === "provider" && args[1] === "get") {
      const name = args[2] ?? "";
      const binding = live.get(name);
      return binding
        ? {
            status: 0,
            stdout: providerMetadata(name, binding.type, binding.credential),
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: `provider '${name}' not found` };
    }
    if (args[0] === "provider" && args[1] === "create") {
      const name = args[3] ?? "";
      const type = args[5] ?? "";
      const credential = args[7] ?? "";
      live.set(name, { type, credential });
      createCredentials.set(name, options.env?.[credential] ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "provider" && args[1] === "delete") {
      live.delete(args[2] ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unsupported test command" };
  });
  return { createCredentials, live, run };
}

function broker(): HermesToolGatewayCloneBroker & {
  activateHermesToolGatewayCloneBinding: ReturnType<typeof vi.fn>;
  discardHermesToolGatewayCloneBinding: ReturnType<typeof vi.fn>;
  preflightHermesToolGatewayCloneBinding: ReturnType<typeof vi.fn>;
  stageHermesToolGatewayCloneBinding: ReturnType<typeof vi.fn>;
} {
  return {
    HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
    getHermesToolGatewayProviderName: (name) => `${name}-hermes-tool-gateway`,
    getHermesInferenceProviderName: (name) => `${name}-hermes-inference`,
    preflightHermesToolGatewayCloneBinding: vi.fn(),
    stageHermesToolGatewayCloneBinding: vi.fn(() => ({
      activationToken: `nc_activate_${"a".repeat(43)}`,
      brokerToken: `nc_broker_${"b".repeat(43)}`,
      requestId: `nc_clone_${"1".repeat(32)}`,
    })),
    activateHermesToolGatewayCloneBinding: vi.fn(() => ({
      file: "/tmp/destination.json",
      brokerToken: `nc_broker_${"b".repeat(43)}`,
    })),
    discardHermesToolGatewayCloneBinding: vi.fn(() => true),
    bindHermesToolGatewayCloneProviderState: vi.fn(() => ({
      file: "/tmp/destination.json",
      brokerToken: `nc_broker_${"b".repeat(43)}`,
    })),
    removeHermesToolGatewayProviderState: vi.fn(() => true),
    removeHermesToolGatewayProviderStateForSandboxEntry: vi.fn(() => true),
  };
}

function environment(): NodeJS.ProcessEnv {
  return {
    [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: "test-only-refresh-token",
    [HERMES_INFERENCE_CREDENTIAL_ENV]: "test-only-inference-placeholder",
  };
}

function authority(source: SandboxEntry) {
  return {
    readSandbox: (name: string) => (name === "source" ? source : null),
    captureSnapshotRestoreAuthority: vi.fn(() => CONTENT_AUTHORITY),
  };
}

describe("Hermes managed clone broker transaction", () => {
  it("never starts a device-code flow unless the caller explicitly opts in", async () => {
    const preparedHandoff = handoff();
    const runDeviceCodeFlow = vi.fn(async () => ({ refresh_token: "oauth-refresh" }));

    await expect(
      resolveHermesManagedCloneCredentialEnvironment({
        handoff: preparedHandoff,
        environment: {},
        runDeviceCodeFlow,
      }),
    ).rejects.toThrow(`export ${HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV}`);
    expect(runDeviceCodeFlow).not.toHaveBeenCalled();

    await expect(
      resolveHermesManagedCloneCredentialEnvironment({
        handoff: preparedHandoff,
        environment: {},
        allowDeviceCodeFlow: true,
        runDeviceCodeFlow,
      }),
    ).resolves.toMatchObject({
      [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: "oauth-refresh",
    });
    expect(runDeviceCodeFlow).toHaveBeenCalledOnce();
  });

  it("stages one secret-free provider-neutral transaction and activates after exact creation", () => {
    const profile = hermesProfile();
    const source = sourceEntry(profile);
    const preparedHandoff = handoff(profile);
    const runner = providerRunner();
    const hostBroker = broker();
    const prepared = prepareHermesManagedCloneBrokerTransaction({
      handoff: preparedHandoff,
      destination: null,
      environment: environment(),
      runOpenshell: runner.run,
      broker: hostBroker,
      transactionId: "1".repeat(32),
    });

    expect(hostBroker.preflightHermesToolGatewayCloneBinding).toHaveBeenCalledWith("destination");
    expect(prepared.providerTransaction.providers.map(({ binding }) => binding.source)).toEqual([
      "hermes-inference",
      "hermes-tool-gateway",
    ]);
    expect(JSON.stringify(prepared)).not.toContain("test-only-refresh-token");

    const receipt = provisionHermesManagedCloneBrokerTransaction(prepared, {
      ...authority(source),
      environment: environment(),
      runOpenshell: runner.run,
      broker: hostBroker,
    });

    expect(hostBroker.stageHermesToolGatewayCloneBinding).toHaveBeenCalledWith(
      "destination",
      "test-only-refresh-token",
      { requestId: `nc_clone_${"1".repeat(32)}` },
    );
    expect(runner.createCredentials.get("destination-hermes-inference")).toBe(
      "test-only-inference-placeholder",
    );
    expect(runner.createCredentials.get("destination-hermes-tool-gateway")).toBe(
      `nc_broker_${"b".repeat(43)}`,
    );
    expect(hostBroker.activateHermesToolGatewayCloneBinding).toHaveBeenCalledOnce();
    expect(receipt.phase).toBe("activated");
  });

  it("preserves exact providers when activation outcome is unknown", () => {
    const profile = hermesProfile();
    const source = sourceEntry(profile);
    const runner = providerRunner();
    const hostBroker = broker();
    hostBroker.activateHermesToolGatewayCloneBinding.mockImplementation(() => {
      throw Object.assign(new Error("lost local response"), {
        code: "hermes_clone_activation_outcome_unknown",
      });
    });
    const prepared = prepareHermesManagedCloneBrokerTransaction({
      handoff: handoff(profile),
      destination: null,
      environment: environment(),
      runOpenshell: runner.run,
      broker: hostBroker,
      transactionId: "2".repeat(32),
    });

    expect(() =>
      provisionHermesManagedCloneBrokerTransaction(prepared, {
        ...authority(source),
        environment: environment(),
        runOpenshell: runner.run,
        broker: hostBroker,
      }),
    ).toThrowError(
      expect.objectContaining<HermesManagedCloneBrokerTransactionError>({ cleanupDeferred: true }),
    );
    expect(runner.live.size).toBe(2);
    expect(hostBroker.discardHermesToolGatewayCloneBinding).not.toHaveBeenCalled();
  });

  it("rolls back only its provider receipt when activation fails definitively", () => {
    const profile = hermesProfile();
    const source = sourceEntry(profile);
    const runner = providerRunner();
    const hostBroker = broker();
    hostBroker.activateHermesToolGatewayCloneBinding.mockImplementation(() => {
      throw new Error("activation rejected");
    });
    const prepared = prepareHermesManagedCloneBrokerTransaction({
      handoff: handoff(profile),
      destination: null,
      environment: environment(),
      runOpenshell: runner.run,
      broker: hostBroker,
      transactionId: "3".repeat(32),
    });

    expect(() =>
      provisionHermesManagedCloneBrokerTransaction(prepared, {
        ...authority(source),
        environment: environment(),
        runOpenshell: runner.run,
        broker: hostBroker,
      }),
    ).toThrow("activation rejected");
    expect(runner.live.size).toBe(0);
    expect(hostBroker.discardHermesToolGatewayCloneBinding).toHaveBeenCalledOnce();
  });
});
