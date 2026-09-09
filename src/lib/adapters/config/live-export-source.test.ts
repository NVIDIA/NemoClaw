// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { runConfigExport } from "../../actions/config/export";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { validateNemoClawConfig } from "../../config/schema";

vi.mock("../../state/registry/persistence", () => ({ load: vi.fn() }));
vi.mock("../../state/registry-entry-view", () => ({ getSandboxEntryInference: vi.fn() }));
vi.mock("../../inference/live", () => ({ getLiveGatewayInference: vi.fn() }));
vi.mock("../openshell/sdk", () => ({ connectManagedOpenShellSdk: vi.fn() }));
vi.mock("../openshell/sanitized-capture", () => ({
  captureSanitizedResolvedOpenshell: vi.fn(),
}));
vi.mock("../openshell/sandbox-policy-cli", () => ({
  syncCliOpenShellSandboxPolicyReader: { readSandboxPolicy: vi.fn() },
}));
vi.mock("../../onboard/gateway/state-dir", () => ({
  managedGatewayStateRootOwnershipFailure: vi.fn(() => null),
  resolveGatewayStateDirForPort: vi.fn(() => "/managed/gateway"),
}));

import { getLiveGatewayInference } from "../../inference/live";
import { resolveGatewayStateDirForPort } from "../../onboard/gateway/state-dir";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import { connectManagedOpenShellSdk } from "../openshell/sdk";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../openshell/sandbox-identity";
import { syncCliOpenShellSandboxPolicyReader } from "../openshell/sandbox-policy-cli";
import { createLiveExportSnapshotReader } from "./live-export-source";

const sandboxId = "123e4567-e89b-42d3-a456-426614174000";
const identityFingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
const endpoint = "https://integrate.api.nvidia.com/v1";
const readFailureCanary = "credential-canary-value";
const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
const startup = buildManagedStartupProfile({
  agent: "openclaw",
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia-prod",
    model: "model-a",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: "inference/model-a",
    compatibility: {},
  },
  dashboard: {
    agent: "openclaw",
    mode: "loopback",
    url: "http://127.0.0.1:18789",
    port: 18_789,
    bindAddress: "127.0.0.1",
    wslExposure: false,
  },
  webSearch: null,
  toolDisclosure: "progressive",
  hermesToolGateways: [],
  messagingPlan: null,
  dcodeAutoApprovalMode: null,
  observabilityEnabled: null,
  environment: {},
  corporateCa: null,
});

const entry: SandboxEntry = {
  name: "alpha",
  createdAt: "not-export-evidence",
  agent: "openclaw",
  openshellDriver: "docker",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: identityFingerprint,
  provider: "nvidia-prod",
  model: "model-a",
  preferredInferenceApi: "openai-completions",
  endpointUrl: endpoint,
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  imageTag: imageRef,
  workload: {
    schemaVersion: 1,
    kind: "managed-image",
    reference: imageRef,
    platform: "linux/amd64",
    release: "v1.0.0",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-1-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: startup.encodedProfile,
    startupProfileSha256: startup.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  },
};

const raw = {
  getProvider: vi.fn(),
  getProviderProfile: vi.fn(),
  getSandbox: vi.fn(),
  getSandboxConfig: vi.fn(),
};
function inventory(resourceVersion = 7, policyVersion = 3) {
  return {
    sandbox: {
      metadata: {
        id: sandboxId,
        name: "alpha",
        workspace: "default",
        resourceVersion: BigInt(resourceVersion),
      },
      status: { phase: 2, currentPolicyVersion: policyVersion },
      spec: { template: { image: imageRef }, providers: [] },
    },
  };
}
function provider() {
  return {
    provider: {
      metadata: {
        id: "provider-id",
        name: "nvidia-prod",
        workspace: "default",
        resourceVersion: 8n,
      },
      type: "openai",
      credentials: { NVIDIA_INFERENCE_API_KEY: readFailureCanary },
      config: { OPENAI_BASE_URL: endpoint },
    },
  };
}
function configuration(revision = 3) {
  return {
    workspace: "default",
    version: revision,
    policyHash: "a".repeat(64),
    configRevision: 11n,
    providerEnvRevision: 12n,
    policySource: 1,
    globalPolicyVersion: 0,
  };
}

function mockSupportedLiveSource(
  policyVersion = 3,
  appliedRevision = 3,
  sourceEntry: SandboxEntry = entry,
): void {
  vi.mocked(loadRegistry).mockReturnValue({
    sandboxes: { alpha: sourceEntry },
    defaultSandbox: null,
  });
  vi.mocked(getSandboxEntryInference).mockReturnValue({
    kind: "configured",
    provider: "nvidia-prod",
    model: "model-a",
  });
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "nvidia-prod", model: "model-a" },
    output: "",
    status: 0,
  });
  vi.mocked(connectManagedOpenShellSdk).mockResolvedValue({ raw });
  raw.getProvider.mockResolvedValue(provider());
  raw.getSandbox.mockResolvedValue(inventory(7, policyVersion));
  raw.getSandboxConfig.mockResolvedValue(configuration(policyVersion));
  vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
    ok: true,
    value: {
      document:
        "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n",
      appliedRevision,
    },
  });
}

function nativeNvidiaProvider() {
  return { ...provider().provider, type: "nvidia", profileWorkspace: "", config: {} };
}

function mockNativeNvidiaSource() {
  mockSupportedLiveSource();
  raw.getProvider.mockResolvedValue({ provider: nativeNvidiaProvider() });
  raw.getProviderProfile.mockResolvedValue({
    profile: {
      id: "nvidia",
      source: "builtin",
      scope: "",
      resourceVersion: 0n,
      inferenceCapable: true,
      endpoints: [{ host: "integrate.api.nvidia.com", port: 443 }],
    },
  });
}

describe("live export snapshot reader", () => {
  it.each([
    {
      stage: "registry",
      fail: () =>
        vi.mocked(loadRegistry).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "gateway-binding",
      fail: () =>
        vi.mocked(resolveGatewayStateDirForPort).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "sandbox-inventory",
      fail: () =>
        raw.getSandbox.mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "sandbox-identity",
      fail: () =>
        raw.getSandbox.mockResolvedValueOnce({
          sandbox: {
            ...inventory().sandbox,
            metadata: { ...inventory().sandbox.metadata, id: "invalid id" },
          },
        }),
    },
    {
      stage: "inference-route",
      fail: () =>
        vi.mocked(getLiveGatewayInference).mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "provider-metadata",
      fail: () =>
        raw.getProvider.mockImplementationOnce(() => {
          throw new Error(readFailureCanary);
        }),
    },
    {
      stage: "effective-policy",
      fail: () =>
        vi
          .mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy)
          .mockImplementationOnce(() => {
            throw new Error(readFailureCanary);
          }),
    },
  ] as const)("tags a sanitized $stage read failure", async ({ stage, fail }) => {
    mockSupportedLiveSource();
    fail();

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("does not fall back to the selected gateway after an inference read failure", async () => {
    mockSupportedLiveSource();
    const actual =
      await vi.importActual<typeof import("../../inference/live")>("../../inference/live");
    vi.mocked(getLiveGatewayInference).mockImplementationOnce(actual.getLiveGatewayInference);
    vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
      status: 1,
      output: "unreachable",
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "inference-route",
    });
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureSanitizedResolvedOpenshell).mock.calls[0]?.[0]).toContain("nemoclaw");
    expect(raw.getProvider).not.toHaveBeenCalled();
  });

  it("returns a complete non-secret raw snapshot", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", readFailureCanary);
    mockSupportedLiveSource();
    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "7", policyVersion: 3 },
      inference: {
        topology: "hosted",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        provider: "nvidia-prod",
        model: "model-a",
        endpointEvidence: {
          endpoint,
          provider: {
            id: "provider-id",
            resourceVersion: "8",
            workspace: "default",
          },
          source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
        },
      },
    });
    expect(result).not.toHaveProperty("registry.createdAt");
    expect(result).not.toHaveProperty("inference.credential");
    expect(captureSanitizedResolvedOpenshell).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("preserves live revision fields for structural stability checks", async () => {
    mockSupportedLiveSource();
    const reader = createLiveExportSnapshotReader();
    const first = await reader.read("alpha");
    raw.getSandbox.mockResolvedValue(inventory(8, 4));
    raw.getSandboxConfig.mockResolvedValue(configuration(4));
    vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
      ok: true,
      value: { document: "version: 1\nnetwork_policies: {}\n", appliedRevision: 4 },
    });

    const second = await reader.read("alpha");

    expect(first).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "7", policyVersion: 3 },
      policy: { revision: "3" },
    });
    expect(second).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: "8", policyVersion: 4 },
      policy: { revision: "4" },
    });
  });

  it("sanitizes credential-bearing policy failures", async () => {
    mockSupportedLiveSource();
    const canary = "credential-canary-value";
    vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
      ok: true,
      value: {
        document: `version: 1\nenv: {TOKEN: "${canary}"}\nnetwork_policies: {}\n`,
        appliedRevision: 3,
      },
    });

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage: "effective-policy" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("maps inconsistent provider metadata to a controlled read failure", async () => {
    mockSupportedLiveSource();
    raw.getProvider.mockResolvedValue({
      provider: {
        ...provider().provider,
        credentials: { OTHER_API_KEY: readFailureCanary },
      },
    });

    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "provider-metadata",
    });
  });

  it("maps route and policy revision drift to controlled read failures", async () => {
    mockSupportedLiveSource(4, 3);
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "effective-policy",
    });

    mockSupportedLiveSource();
    vi.mocked(getLiveGatewayInference).mockReturnValue({
      failure: null,
      inference: { provider: "nvidia-prod", model: "model-b" },
      output: "",
      status: 0,
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "inference-route",
    });
  });

  it("exports canonical YAML for the native NVIDIA hosted provider (#11154)", async () => {
    mockNativeNvidiaSource();
    const writeStdout = vi.fn(async (_yaml: string) => {});
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: () =>
          parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
        writeStdout,
        publish,
      },
    );
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "hosted-nvidia-prod",
        provider: "nvidia-prod",
        api: "openai-completions",
        endpoint,
        credential: { env: "NVIDIA_INFERENCE_API_KEY" },
      },
    ]);
    expect(document.spec.sandboxes[0].agents[0].type).toBe("openclaw");
    expect(yaml).not.toContain(readFailureCanary);
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { label: "endpoint override", providerChange: { config: { NVIDIA_BASE_URL: endpoint } } },
    {
      label: "credential mismatch",
      providerChange: { credentials: { OTHER_API_KEY: readFailureCanary } },
    },
    { label: "missing credentials", providerChange: { credentials: {} } },
    { label: "unverified profile scope", providerChange: { profileWorkspace: "default" } },
  ])("rejects native NVIDIA $label without publishing YAML", async ({ providerChange }) => {
    mockNativeNvidiaSource();
    raw.getProvider.mockResolvedValue({
      provider: { ...nativeNvidiaProvider(), ...providerChange },
    });
    const writeStdout = vi.fn();
    const publish = vi.fn();
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, createLiveExportSnapshotReader()),
        createDocumentUid: vi.fn(),
        writeStdout,
        publish,
      },
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("rejects NVIDIA endpoint drift between the registry and builtin profile", async () => {
    mockNativeNvidiaSource();
    vi.mocked(loadRegistry).mockReturnValue({
      sandboxes: { alpha: { ...entry, endpointUrl: "https://different.example/v1" } },
      defaultSandbox: null,
    });
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([
        expect.objectContaining({
          field: "spec.inferenceProviders[].endpoint",
          category: "drifted",
        }),
      ]),
    });
  });

  it("rejects a native NVIDIA provider that changes during both observations", async () => {
    mockNativeNvidiaSource();
    let revision = 0;
    raw.getProvider.mockImplementation(async () => ({
      provider: {
        ...nativeNvidiaProvider(),
        metadata: { ...provider().provider.metadata, resourceVersion: BigInt(++revision) },
      },
    }));
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(4);
  });

  it("exports a stable SDK endpoint with verified policy and workload evidence", async () => {
    mockSupportedLiveSource();
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      source: {
        inference: { endpoint },
        runtime: { imageRef },
        sandboxName: "alpha",
      },
    });
    expect(raw.getProvider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it.each([
    {
      label: "endpoint",
      change: () =>
        raw.getProvider.mockResolvedValue({
          provider: {
            ...provider().provider,
            config: { OPENAI_BASE_URL: "https://different.example/v1" },
          },
        }),
      category: "drifted",
    },
    {
      label: "image",
      change: () =>
        raw.getSandbox.mockResolvedValue({
          sandbox: {
            ...inventory().sandbox,
            spec: { template: { image: imageRef.replace("aaaa", "bbbb") }, providers: [] },
          },
        }),
      category: "drifted",
    },
    {
      label: "provider attachments",
      change: () =>
        raw.getSandbox.mockResolvedValue({
          sandbox: {
            ...inventory().sandbox,
            spec: { template: { image: imageRef }, providers: ["extra"] },
          },
        }),
      category: "unsupported",
    },
  ])("rejects live $label drift", async ({ change, category }) => {
    mockSupportedLiveSource();
    change();
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      findings: expect.arrayContaining([expect.objectContaining({ category })]),
    });
  });

  it("detects repeated provider revision changes", async () => {
    mockSupportedLiveSource();
    let revision = 20n;
    raw.getProvider.mockImplementation(async () => ({
      provider: {
        ...provider().provider,
        metadata: { ...provider().provider.metadata, resourceVersion: revision++ },
      },
    }));
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
  });

  it.each(["configRevision", "providerEnvRevision"])(
    "detects repeated %s changes",
    async (field) => {
      mockSupportedLiveSource();
      let revision = 20n;
      raw.getSandboxConfig.mockImplementation(async () => ({
        ...configuration(),
        [field]: revision++,
      }));
      const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
      expect(result).toMatchObject({
        ok: false,
        attempts: 2,
        findings: [expect.objectContaining({ category: "unstable-source" })],
      });
    },
  );

  it("does not expose concrete reader exceptions", async () => {
    const canary = "credential-canary-value";
    vi.mocked(loadRegistry).mockImplementation(() => {
      throw new Error(canary);
    });

    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toEqual({ kind: "read-failed", stage: "registry" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
