// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
} from "../../../../test/support/config-export-harness";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { assert, describe, expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import { createManagedProviderAdapter } from "../openshell/managed-provider-adapter";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { entry, inventory, provider, startupInput } from "./live-export-source-test-fixture";
import { createLiveExportSnapshotReader } from "./live-export-source";

vi.mock("../openshell/managed-provider-adapter", () => ({
  createManagedProviderAdapter: vi.fn(),
}));

function registeredSource() {
  const f = registeredInferenceFixture(true);
  const binding = { ...f.binding, gatewayName: entry.gatewayName };
  const startup = buildManagedStartupProfile({
    ...startupInput,
    inference: {
      ...startupInput.inference,
      routeProvider: binding.providerName,
      upstreamProvider: binding.providerName,
      routedBaseUrl: binding.endpointUrl,
      upstreamEndpointUrl: null,
      primaryModelRef: binding.providerName + "/model-a",
      compatibility: {},
    },
  });
  mockSupportedLiveSource(3, 3, {
    ...entry,
    workload: {
      ...entry.workload,
      encodedProfile: startup.encodedProfile,
      startupProfileSha256: startup.startupProfileSha256,
    },
    provider: binding.providerName,
    endpointUrl: binding.endpointUrl,
    credentialEnv: binding.credentialEnv,
    preferredInferenceApi: binding.inferenceApi,
    registeredInferenceProviderAttachment: binding,
  });
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: binding.providerName,
    model: "model-a",
  });
  vi.mocked(createManagedProviderAdapter).mockReturnValue(f.adapter);
  const liveProvider = provider().provider;
  raw.getProvider.mockResolvedValue({
    provider: {
      ...liveProvider,
      metadata: { ...liveProvider.metadata, name: binding.providerName, id: binding.providerId },
      type: binding.profileId,
      credentials: { VENDOR_API_KEY: { value: "redacted" } },
      config: {},
    },
  });
  const sandbox = inventory().sandbox;
  raw.getSandbox.mockResolvedValue({
    sandbox: { ...sandbox, spec: { ...sandbox.spec, providers: [binding.providerName] } },
  });
  return { ...f, binding };
}

describe("registered provider live export evidence", () => {
  it("exports the verified operator route without claiming provider ownership", async () => {
    const f = registeredSource();
    const exported = await exportLiveSource();
    expect(exported.result).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(exported.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining(f.binding.endpointUrl),
    );
    expect(exported.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining(f.binding.credentialEnv),
    );
    expect(exported.writeStdout).toHaveBeenCalledWith(expect.not.stringContaining(f.handle));
  });

  it("verifies external identity and profile without shared routing or owned profile attestation", async () => {
    const f = registeredSource();
    const result = await createLiveExportSnapshotReader().read("alpha");
    expect(result).toMatchObject({
      kind: "observed",
      inference: {
        provider: f.binding.providerName,
        endpoint: f.binding.endpointUrl,
        endpointEvidence: {
          source: {
            kind: "registered-provider",
            profileId: f.binding.profileId,
            profileDigest: f.binding.profileDigest,
          },
          provider: { id: f.binding.providerId },
        },
      },
    });
    expect(raw.getProviderProfile).not.toHaveBeenCalled();
    expect(captureSanitizedResolvedOpenshell).not.toHaveBeenCalled();
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
  });

  it("refuses an externally replaced provider before export", async () => {
    const f = registeredSource();
    f.state.id = "replacement";
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toMatchObject({
      kind: "read-failed",
    });
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("refuses missing attachment membership", async () => {
    const f = registeredSource();
    f.state.attached = false;
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toMatchObject({
      kind: "read-failed",
    });
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });
});

it("rejects an export whose external profile evidence disagrees with its recorded digest", async () => {
  registeredSource();
  const observed = await createLiveExportSnapshotReader().read("alpha");
  assert(observed.kind === "observed" && observed.inference.endpointEvidence);
  const evidence = observed.inference.endpointEvidence;
  assert(evidence.source.kind === "registered-provider");
  const tampered = {
    ...observed,
    inference: {
      ...observed.inference,
      endpointEvidence: {
        ...evidence,
        source: { ...evidence.source, profileDigest: "b".repeat(64) },
      },
    },
  };
  await expect(
    observeStableExportSource("alpha", { read: async () => tampered }),
  ).resolves.toMatchObject({ ok: false });
});
