// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../state/registry/persistence", () => ({ load: vi.fn() }));
vi.mock("../state/registry-entry-view", () => ({ getSandboxEntryInference: vi.fn() }));
vi.mock("../inference/live", () => ({ getLiveGatewayInference: vi.fn() }));
vi.mock("../adapters/openshell/provider-adapter-cli", () => ({
  createCliOpenShellProviderAdapter: vi.fn(),
}));
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

import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { captureSanitizedResolvedOpenshell } from "../adapters/openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../adapters/openshell/sandbox-identity";
import { inspectOpenShellSandboxIdentityFingerprint } from "../adapters/openshell/sandbox-identity-cli";
import { syncCliOpenShellSandboxPolicyReader } from "../adapters/openshell/sandbox-policy-cli";
import { getLiveGatewayInference } from "../inference/live";
import { buildManagedStartupProfile } from "../onboard/managed-startup/profile-builder";
import { getSandboxEntryInference } from "../state/registry-entry-view";
import { load as loadRegistry } from "../state/registry/persistence";
import type { SandboxEntry } from "../state/registry/types";
import { createLiveExportSnapshotReader, observeLiveExportSource } from "./export-live-adapters";

const sandboxId = "123e4567-e89b-42d3-a456-426614174000";
const identityFingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
const endpoint = "https://integrate.api.nvidia.com/v1";
const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
const startup = buildManagedStartupProfile({
  agent: "openclaw",
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia",
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
  environment: {
    NEMOCLAW_AGENT_TIMEOUT: "600",
    NEMOCLAW_CONTEXT_WINDOW: "131072",
    NEMOCLAW_EXTRA_AGENTS_JSON: '{"agents":[],"defaults":{},"main":{}}',
    NEMOCLAW_MAX_TOKENS: "8192",
    NEMOCLAW_MINIMAL_BOOTSTRAP: "1",
    NEMOCLAW_OPENCLAW_OTEL: "0",
    NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "1",
    NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "openclaw-gateway",
    NEMOCLAW_PROXY_HOST: "10.200.0.1",
    NEMOCLAW_PROXY_PORT: "3128",
    NEMOCLAW_REASONING: "false",
    NEMOCLAW_REASONING_EFFORT: "default",
  },
  corporateCa: null,
});

const entry: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  openshellDriver: "docker",
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: identityFingerprint,
  provider: "nvidia",
  model: "model-a",
  preferredInferenceApi: "openai-completions",
  endpointUrl: endpoint,
  credentialEnv: "NVIDIA_API_KEY",
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

function inventory(resourceVersion = 7, policyVersion = 3): string {
  return JSON.stringify([
    {
      id: sandboxId,
      name: "alpha",
      labels: {},
      resource_version: resourceVersion,
      created_at: "now",
      phase: "Ready",
      current_policy_version: policyVersion,
    },
  ]);
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
    provider: "nvidia",
    model: "model-a",
  });
  vi.mocked(getLiveGatewayInference).mockReturnValue({
    failure: null,
    inference: { provider: "nvidia", model: "model-a" },
    output: "",
    status: 0,
  });
  vi.mocked(createCliOpenShellProviderAdapter).mockReturnValue({
    getProvider: vi.fn(async () => ({
      ok: true as const,
      value: {
        name: "nvidia",
        type: "openai",
        credentialKeys: sourceEntry.credentialEnv ? [sourceEntry.credentialEnv] : [],
        configKeys: ["OPENAI_BASE_URL"],
      },
    })),
  } as never);
  vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
    status: 0,
    output: inventory(7, policyVersion),
    stdout: inventory(7, policyVersion),
    stderr: "",
  });
  vi.mocked(inspectOpenShellSandboxIdentityFingerprint).mockReturnValue(identityFingerprint);
  vi.mocked(syncCliOpenShellSandboxPolicyReader.readSandboxPolicy).mockReturnValue({
    ok: true,
    value: {
      document:
        "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n",
      appliedRevision,
    },
  });
}

describe("live export snapshot reader", () => {
  it("fails closed when OpenShell cannot expose independent endpoint evidence", async () => {
    mockSupportedLiveSource();
    const result = await observeLiveExportSource("alpha");

    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      findings: [
        expect.objectContaining({
          field: "source.inference.endpoint",
          category: "missing-provenance",
        }),
      ],
    });
  });

  it("returns a complete non-secret raw snapshot", async () => {
    mockSupportedLiveSource();
    const result = await createLiveExportSnapshotReader().read("alpha");

    expect(result).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: 7, policyVersion: 3 },
      inference: {
        topology: "hosted",
        credentialEnv: "NVIDIA_API_KEY",
        provider: "nvidia",
        model: "model-a",
        endpointEvidence: null,
      },
    });
    expect(result).not.toHaveProperty("inference.credential");
    expect(process.env.NVIDIA_API_KEY).toBeUndefined();
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledTimes(1);
  });

  it("preserves live revision fields for structural stability checks", async () => {
    mockSupportedLiveSource();
    const reader = createLiveExportSnapshotReader();
    const first = await reader.read("alpha");
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

    const second = await reader.read("alpha");

    expect(first).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: 7, policyVersion: 3 },
      policy: { revision: "3" },
    });
    expect(second).toMatchObject({
      kind: "observed",
      sandbox: { resourceVersion: 8, policyVersion: 4 },
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

    const result = await observeLiveExportSource("alpha");

    expect(result).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "live-verification-failed" })],
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("maps inconsistent provider metadata to a controlled read failure", async () => {
    mockSupportedLiveSource();
    vi.mocked(createCliOpenShellProviderAdapter).mockReturnValue({
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: "nvidia",
          type: "openai",
          credentialKeys: ["OTHER_API_KEY"],
          configKeys: ["OPENAI_BASE_URL"],
        },
      })),
    } as never);

    await expect(observeLiveExportSource("alpha")).resolves.toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "live-verification-failed" })],
    });
  });

  it("maps route and policy revision drift to controlled read failures", async () => {
    mockSupportedLiveSource(4, 3);
    await expect(observeLiveExportSource("alpha")).resolves.toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "live-verification-failed" })],
    });

    mockSupportedLiveSource();
    vi.mocked(getLiveGatewayInference).mockReturnValue({
      failure: null,
      inference: { provider: "nvidia", model: "model-b" },
      output: "",
      status: 0,
    });
    await expect(observeLiveExportSource("alpha")).resolves.toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "live-verification-failed" })],
    });
  });

  it("does not expose concrete reader exceptions", async () => {
    const canary = "credential-canary-value";
    vi.mocked(loadRegistry).mockImplementation(() => {
      throw new Error(canary);
    });

    const result = await observeLiveExportSource("alpha");

    expect(result).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "live-verification-failed" })],
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
