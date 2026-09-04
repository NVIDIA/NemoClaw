// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { fingerprintOpenShellSandboxId } from "../adapters/openshell/sandbox-identity";
import {
  buildManagedStartupProfile,
  type ManagedStartupProfileBuilderInput,
} from "../onboard/managed-startup/profile-builder";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../state/registry/types";
import {
  canonicalizeEffectivePolicy,
  classifyExportRegistry,
  observeStableExportSource,
  type ExportSnapshotReader,
  type RawExportSnapshot,
} from "./export-observation";

const sandboxId = "018f47e2-9d93-7d15-9c41-3ecf70b2550f";
const fingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
const endpoint = "https://api.openai.com/v1";
const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
const policy =
  "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
function profileInput(
  overrides: Partial<ManagedStartupProfileBuilderInput> = {},
): ManagedStartupProfileBuilderInput {
  return {
    agent: "openclaw",
    inference: {
      routeProvider: "openai",
      upstreamProvider: "openai-api",
      model: "gpt-5",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5",
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
    ...overrides,
  };
}

function managedWorkload(
  input = profileInput(),
  reference = imageRef,
): Extract<SandboxWorkloadReceipt, { kind: "managed-image" }> {
  const built = buildManagedStartupProfile(input);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference,
    platform: "linux/amd64",
    release: "v1.0.0",
    sourceRevision: "b".repeat(40),
    sourceCohort: "ghrun-1-1",
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    encodedProfile: built.encodedProfile,
    startupProfileSha256: built.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function entry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "openclaw",
    openshellDriver: "docker",
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: fingerprint,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    provider: "openai-api",
    model: "gpt-5",
    preferredInferenceApi: "openai-responses",
    endpointUrl: endpoint,
    credentialEnv: "OPENAI_API_KEY",
    imageTag: imageRef,
    workload: managedWorkload(),
    ...overrides,
  };
}

type ObservedSnapshot = Extract<RawExportSnapshot, { kind: "observed" }>;

function snapshot(overrides: Partial<ObservedSnapshot> = {}): ObservedSnapshot {
  return {
    kind: "observed",
    sandboxName: "alpha",
    registry: entry(),
    sandbox: {
      sandboxId,
      fingerprint,
      resourceVersion: 7,
      policyVersion: 3,
    },
    gateway: {
      name: "nemoclaw",
      port: 8080,
      management: "nemoclaw",
      stateRootOwned: true,
    },
    inference: {
      topology: "hosted",
      provider: "openai-api",
      model: "gpt-5",
      api: "openai-responses",
      endpoint,
      endpointEvidence: {
        endpoint,
        gatewayName: "nemoclaw",
        providerName: "openai-api",
        configKey: "OPENAI_BASE_URL",
      },
      credentialEnv: "OPENAI_API_KEY",
    },
    policy: { sandboxId, revision: "3", document: policy },
    ...overrides,
  };
}

function withResourceVersion(resourceVersion: number): ObservedSnapshot {
  const value = snapshot();
  return { ...value, sandbox: { ...value.sandbox, resourceVersion } };
}

function reader(
  sequence: readonly RawExportSnapshot[] = [snapshot(), snapshot()],
): ExportSnapshotReader & { read: ReturnType<typeof vi.fn> } {
  let call = 0;
  const read = vi.fn(async () => sequence[Math.min(call++, sequence.length - 1)]!);
  return { read };
}

function findings(result: Awaited<ReturnType<typeof observeStableExportSource>>) {
  return result.ok ? [] : result.findings;
}

function verifiedSource(result: Awaited<ReturnType<typeof observeStableExportSource>>) {
  expect(result.ok).toBe(true);
  return (result as Extract<typeof result, { ok: true }>).source;
}

describe("stable config export source observation (#10938)", () => {
  it("narrows one stable supported snapshot to an immutable verified source", async () => {
    const sourceReader = reader();
    const result = await observeStableExportSource("alpha", sourceReader);

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      source: {
        sandboxName: "alpha",
        runtime: { provider: "docker", imageRef },
        inference: { api: "openai-responses" },
      },
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(2);
    const source = verifiedSource(result);
    expect(source).not.toHaveProperty("registry");
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.policy)).toBe(true);
  });

  it("retries one structurally changed snapshot pair", async () => {
    const stable = withResourceVersion(3);
    const sourceReader = reader([
      withResourceVersion(1),
      withResourceVersion(2),
      stable,
      structuredClone(stable),
    ]);

    await expect(observeStableExportSource("alpha", sourceReader)).resolves.toMatchObject({
      ok: true,
      attempts: 2,
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(4);
  });

  it("owns each read before an untrusted reader can mutate and reuse it", async () => {
    const shared = snapshot();
    const sourceReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce(shared)
        .mockImplementationOnce(async () => {
          (shared.sandbox as { resourceVersion: number }).resourceVersion = 8;
          return shared;
        })
        .mockResolvedValue(shared),
    };

    await expect(observeStableExportSource("alpha", sourceReader)).resolves.toMatchObject({
      ok: true,
      attempts: 2,
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(4);
  });

  it("returns unstable-source after two changed snapshot pairs", async () => {
    const result = await observeStableExportSource(
      "alpha",
      reader([
        withResourceVersion(1),
        withResourceVersion(2),
        withResourceVersion(3),
        withResourceVersion(4),
      ]),
    );

    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ category: "unstable-source" }),
    );
  });

  it("reports every excluded registry capability", () => {
    const result = classifyExportRegistry(
      entry({
        agent: "hermes",
        fromDockerfile: "/tmp/Dockerfile",
        sandboxGpuEnabled: true,
        hostMounts: [{ source: "/host", target: "/sandbox", readOnly: true }],
        observabilityEnabled: true,
        webSearchEnabled: true,
        messaging: { configured: {} } as never,
        mcp: { bridges: {} } as never,
        openclawImagePluginInstalls: [{ id: "secondary" }] as never,
        hostLocalInferenceReceipt: "receipt",
      }),
    );

    expect(
      result.filter(({ category }) => category === "unsupported").map(({ field }) => field),
    ).toEqual(
      expect.arrayContaining([
        "spec.sandboxes[].runtime.customImage",
        "spec.sandboxes[].runtime.gpu",
        "spec.sandboxes[].mounts",
        "spec.sandboxes[].observability",
        "spec.sandboxes[].integrations.webSearch",
        "spec.sandboxes[].integrations.messaging",
        "spec.sandboxes[].integrations.mcp",
        "spec.sandboxes[].agents.secondary",
        "spec.sandboxes[].agents[0].type",
        "spec.inferenceProviders",
      ]),
    );
  });

  it("fails closed on lifecycle, gateway, route, endpoint, and policy drift", async () => {
    const changed = snapshot({
      registry: entry({ lifecycleLiveIdentityFingerprint: "different" }),
      gateway: {
        name: "other",
        port: 8081,
        management: "external",
        stateRootOwned: false,
      },
      inference: {
        topology: "local",
        provider: "other",
        model: "model-b",
        api: "invalid",
        endpoint: "http://local",
        endpointEvidence: {
          endpoint: "http://local",
          gatewayName: "other",
          providerName: "other",
          configKey: "OPENAI_BASE_URL",
        },
        credentialEnv: null,
      },
      policy: { sandboxId: "other-id", revision: "4", document: policy },
    });

    const result = await observeStableExportSource("alpha", reader([changed, changed]));
    const fields = findings(result).map(({ field }) => field);

    expect(result.ok).toBe(false);
    expect(fields).toEqual(
      expect.arrayContaining([
        "source.lifecycle.fingerprint",
        "spec.gateway.management",
        "spec.gateway",
        "spec.inferenceProviders",
        "spec.inferenceProviders[].endpoint",
        "spec.sandboxes[].network.policy",
      ]),
    );
  });

  it("normalizes an absent credential to an omitted verified field", async () => {
    const value = snapshot();
    const raw = snapshot({
      registry: entry({ credentialEnv: undefined }),
      inference: { ...value.inference, credentialEnv: null },
    });
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(result).toMatchObject({ ok: true });
    expect(verifiedSource(result).inference).not.toHaveProperty("credentialEnv");
  });

  it("requires endpoint evidence bound to the observed route", async () => {
    const value = snapshot();
    const missing = snapshot({
      inference: { ...value.inference, endpointEvidence: null },
    });
    const mismatched = snapshot({
      inference: {
        ...value.inference,
        endpointEvidence: {
          ...value.inference.endpointEvidence!,
          providerName: "other-provider",
        },
      },
    });

    const missingResult = await observeStableExportSource("alpha", reader([missing, missing]));
    const mismatchResult = await observeStableExportSource(
      "alpha",
      reader([mismatched, mismatched]),
    );

    expect(findings(missingResult)).toContainEqual(
      expect.objectContaining({
        field: "source.inference.endpoint",
        category: "missing-provenance",
      }),
    );
    expect(findings(mismatchResult)).toContainEqual(
      expect.objectContaining({ field: "source.inference.endpoint", category: "drifted" }),
    );
  });

  it.each([
    "http://api.example.test/v1",
    "https://user:credential-canary@api.example.test/v1",
    "https://api.example.test/v1?token=credential-canary",
    "https://api.example.test/v1#credential-canary",
    "https://api.example.test/%0acredential-canary",
  ])("rejects an unsafe endpoint without exposing it: %s", async (unsafeEndpoint) => {
    const value = snapshot();
    const raw = snapshot({
      registry: entry({ endpointUrl: unsafeEndpoint }),
      inference: {
        ...value.inference,
        endpoint: unsafeEndpoint,
        endpointEvidence: { ...value.inference.endpointEvidence!, endpoint: unsafeEndpoint },
      },
    });

    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.inferenceProviders[].endpoint" }),
    );
  });

  it.each([
    ["snapshot", snapshot({ sandboxName: "beta" })],
    ["registry", snapshot({ registry: entry({ name: "beta" }) })],
  ])("binds the requested name to the %s name", async (_source, raw) => {
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.sandbox.name",
        category: "live-verification-failed",
      }),
    );
  });

  it("binds a not-found result to the requested name", async () => {
    const raw = { kind: "not-found", sandboxName: "beta" } as const;
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.sandbox.name",
        category: "live-verification-failed",
      }),
    );
  });

  it("rejects a stable sandbox name outside the v1 grammar", async () => {
    const invalidName = "a".repeat(20);
    const raw = snapshot({
      sandboxName: invalidName,
      registry: entry({ name: invalidName }),
    });
    const result = await observeStableExportSource(invalidName, reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.sandboxes[].name", category: "unsupported" }),
    );
  });

  it.each([
    ["invalid name", 8080],
    ["nemoclaw", 70_000],
    ["nemoclaw", 8080.5],
  ] as const)("rejects an invalid gateway binding", async (name, port) => {
    const raw = snapshot({
      registry: entry({ gatewayName: name, gatewayPort: port }),
      gateway: { name, port, management: "nemoclaw", stateRootOwned: true },
    });
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.gateway", category: "unsupported" }),
    );
  });

  it.each([
    "ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest",
    "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:not-a-digest",
    "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64) + "\n",
    "registry.example/" + "a".repeat(500) + "/image@sha256:" + "a".repeat(64),
  ])("rejects a mutable or malformed image identity", async (reference) => {
    const sourceEntry = entry({
      imageTag: reference,
      workload: managedWorkload(profileInput(), reference),
    });
    const raw = snapshot({ registry: sourceEntry });
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.sandboxes[].runtime.image" }),
    );
  });

  it.each(["Docker", "docker runtime", "docker_runtime", "-docker", "d".repeat(64)])(
    "rejects invalid runtime provider %s",
    async (openshellDriver) => {
      const raw = snapshot({ registry: entry({ openshellDriver }) });
      const result = await observeStableExportSource("alpha", reader([raw, raw]));

      expect(findings(result)).toContainEqual(
        expect.objectContaining({ field: "spec.sandboxes[].runtime.provider" }),
      );
    },
  );

  it("rejects any noncanonical managed startup profile", async () => {
    const base = profileInput();
    const dashboard = base.dashboard as Extract<
      ManagedStartupProfileBuilderInput["dashboard"],
      { agent: "openclaw" }
    >;
    const configured = profileInput({
      dashboard: { ...dashboard, url: "http://127.0.0.1:18888", port: 18_888 },
    });
    const workload = managedWorkload(configured);
    const raw = snapshot({ registry: entry({ imageTag: workload.reference, workload }) });
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "source.workload.startupProfile", category: "unsupported" }),
    );
  });

  it.each(["_KEY", "DSH_TOKEN", "OPENSHELL_TOKEN", "VITEST_TOKEN", "NEMOCLAW_TEST_SECRET"])(
    "rejects reserved credential identifier %s",
    async (credentialEnv) => {
      const value = snapshot();
      const raw = snapshot({
        registry: entry({ credentialEnv }),
        inference: { ...value.inference, credentialEnv },
      });
      const result = await observeStableExportSource("alpha", reader([raw, raw]));

      expect(findings(result)).toContainEqual(
        expect.objectContaining({ field: "spec.inferenceProviders[].credential.env" }),
      );
    },
  );

  it("rejects credential-bearing policy without exposing its value", async () => {
    const canary = "credential-canary-value";
    const raw = snapshot({
      policy: {
        sandboxId,
        revision: "3",
        document: `version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\n  password: ${canary}\nnetwork_policies: {}\n`,
      },
    });
    const result = await observeStableExportSource("alpha", reader([raw, raw]));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ category: "policy-not-representable" }),
    );
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("maps a typed concrete read failure to a controlled finding", async () => {
    const result = await observeStableExportSource(
      "alpha",
      reader([{ kind: "read-failed", stage: "provider-metadata" }]),
    );

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.live",
        category: "live-verification-failed",
        diagnostic: "The live inference provider metadata could not be read or verified.",
      }),
    );
  });

  it("lets unexpected reader defects escape the pure observer", async () => {
    const sourceReader = {
      read: vi.fn(async () => {
        throw new Error("programmer-defect-canary");
      }),
    };

    await expect(observeStableExportSource("alpha", sourceReader)).rejects.toThrow(
      "programmer-defect-canary",
    );
  });

  it("canonicalizes policy independently of mapping insertion order", () => {
    const first = canonicalizeEffectivePolicy(
      "version: 1\nnetwork_policies:\n  ä:\n    name: ä\n    endpoints: [{host: z.example.com, port: 443}]\n    binaries: [{path: /usr/bin/z}]\n  z:\n    name: z\n    endpoints: [{host: a.example.com, port: 443}]\n    binaries: [{path: /usr/bin/a}]\n",
    );
    const second = canonicalizeEffectivePolicy(
      "network_policies:\n  z:\n    binaries: [{path: /usr/bin/a}]\n    endpoints: [{port: 443, host: a.example.com}]\n    name: z\n  ä:\n    binaries: [{path: /usr/bin/z}]\n    endpoints: [{port: 443, host: z.example.com}]\n    name: ä\nversion: 1\n",
    );

    expect(second).toEqual(first);
  });

  it("canonicalizes policy losslessly and rejects malformed policy", () => {
    expect(canonicalizeEffectivePolicy(policy)).toEqual({
      filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
      network_policies: {
        api: {
          binaries: [{ path: "/usr/bin/curl" }],
          endpoints: [{ host: "api.example.com", port: 443 }],
          name: "api",
        },
      },
      process: { run_as_group: "sandbox", run_as_user: "sandbox" },
      version: 1,
    });
    expect(() => canonicalizeEffectivePolicy("network_policies: [not-a-map]")).toThrow();
  });
});
