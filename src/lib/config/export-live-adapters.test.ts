// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../state/registry/persistence", () => ({ load: vi.fn() }));
vi.mock("../state/registry-entry-view", () => ({ getSandboxEntryInference: vi.fn() }));
vi.mock("../adapters/openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshell: vi.fn(),
}));
vi.mock("../adapters/openshell/sandbox-identity-cli", () => ({
  inspectOpenShellSandboxIdentityFingerprint: vi.fn(),
}));
vi.mock("../adapters/openshell/sandbox-policy-cli", () => ({
  syncCliOpenShellSandboxPolicyReader: { readSandboxPolicy: vi.fn() },
}));
vi.mock("../onboard/gateway/state-dir", () => ({
  managedGatewayStateRootOwnershipFailure: vi.fn(() => null),
  resolveGatewayStateDirForPort: vi.fn(() => "/managed/gateway"),
}));

import { captureSanitizedResolvedOpenshell } from "../adapters/openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../adapters/openshell/sandbox-identity";
import { inspectOpenShellSandboxIdentityFingerprint } from "../adapters/openshell/sandbox-identity-cli";
import { syncCliOpenShellSandboxPolicyReader } from "../adapters/openshell/sandbox-policy-cli";
import { getSandboxEntryInference } from "../state/registry-entry-view";
import { load as loadRegistry } from "../state/registry/persistence";
import {
  LiveExportObservationError,
  createLiveExportObservationDependencies,
} from "./export-live-adapters";

const id = "123e4567-e89b-42d3-a456-426614174000";
const identityFingerprint = fingerprintOpenShellSandboxId(id)!;
const entry = {
  name: "alpha",
  agent: "openclaw",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: identityFingerprint,
  provider: "nvidia",
  model: "model-a",
  preferredInferenceApi: "openai-completions",
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  credentialEnv: "NVIDIA_API_KEY",
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: "example.test/image@sha256:" + "a".repeat(64),
    release: "v1",
    sourceRevision: "revision",
    sourceCohort: "cohort",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: "profile",
    startupProfileSha256: "b".repeat(64),
    credentialProxyReplayRequired: true,
    deletionPolicy: "retain",
    deleteWithSandbox: false,
    shared: true,
  },
} as const;

function inventory(resourceVersion = 7, policyVersion = 3) {
  return JSON.stringify([
    {
      id,
      name: "alpha",
      labels: {},
      resource_version: resourceVersion,
      created_at: "now",
      phase: "Ready",
      current_policy_version: policyVersion,
    },
  ]);
}

describe("live export observation dependencies", () => {
  it("binds tokens to live sandbox and policy revisions without reading credential values", async () => {
    vi.mocked(loadRegistry).mockReturnValue({ sandboxes: { alpha: entry }, defaultSandbox: null });
    vi.mocked(getSandboxEntryInference).mockReturnValue({
      kind: "configured",
      provider: "nvidia",
      model: "model-a",
    });
    vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
      status: 0,
      output: inventory(),
      stdout: inventory(),
      stderr: "",
    });
    vi.mocked(inspectOpenShellSandboxIdentityFingerprint).mockReturnValue(
      entry.lifecycleLiveIdentityFingerprint!,
    );
    vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
      ok: true,
      value: { document: "version: 1\nnetwork_policies: {}\n", appliedRevision: 3 },
    });
    const deps = createLiveExportObservationDependencies();
    const first = await deps.readSourceToken("alpha");
    vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
      status: 0,
      output: inventory(8, 4),
      stdout: inventory(8, 4),
      stderr: "",
    });
    vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
      ok: true,
      value: { document: "version: 1\nnetwork_policies: {}\n", appliedRevision: 4 },
    });
    await expect(deps.readSourceToken("alpha")).resolves.not.toBe(first);
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
  });

  it("returns registry-backed inference metadata and never resolves a credential value", async () => {
    vi.mocked(getSandboxEntryInference).mockReturnValue({
      kind: "configured",
      provider: "nvidia",
      model: "model-a",
    });
    const observed = await createLiveExportObservationDependencies().readInference(entry);
    expect(observed).toMatchObject({
      topology: "hosted",
      credentialEnv: "NVIDIA_API_KEY",
      provider: "nvidia",
      model: "model-a",
    });
    expect(observed).not.toHaveProperty("credential");
  });

  it("bounds typed failure findings", () => {
    const findings = Array.from({ length: 20 }, (_, index) => ({
      field: String(index),
      fidelity: "missing" as const,
      category: "missing-provenance" as const,
      diagnostic: "bounded",
    }));
    const error = new LiveExportObservationError("missing-provenance", findings);
    expect(error).toMatchObject({
      name: "LiveExportObservationError",
      category: "missing-provenance",
    });
    expect(error.findings).toHaveLength(16);
  });
});
