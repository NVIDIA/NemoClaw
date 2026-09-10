// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Check } from "typebox/value";
import { ExportSourceValuesSchema } from "./export-evidence";
import { describe, expect, it } from "vitest";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { fingerprintOpenShellSandboxId } from "../sandbox/openshell-identity";
import {
  buildManagedStartupProfile,
  type ManagedStartupProfileBuilderInput,
} from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type {
  CanonicalExportPolicy,
  ObservedExportSnapshot,
  QualifiedExportSnapshot,
} from "./export-evidence";
import { classifyExportRegistry, verifyExportSource } from "./verify-export-source";

const sandboxId = "018f47e2-9d93-7d15-9c41-3ecf70b2550f";
const fingerprint = fingerprintOpenShellSandboxId(sandboxId)!;
const endpoint = "https://api.openai.com/v1";
const imageRef = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:" + "a".repeat(64);
const policy =
  "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n";
const canonicalPolicy = {
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
} as unknown as CanonicalExportPolicy;
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

function snapshot(overrides: Partial<ObservedExportSnapshot> = {}): ObservedExportSnapshot {
  return {
    kind: "observed",
    sandboxName: "alpha",
    registry: entry(),
    sandbox: {
      sandboxId,
      fingerprint,
      resourceVersion: "7",
      workspace: "default",
      imageRef,
      providerNames: [],
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
        provider: {
          gatewayName: "nemoclaw",
          workspace: "default",
          name: "openai-api",
          id: "provider-id",
          resourceVersion: "8",
        },
        source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
      },
      credentialEnv: "OPENAI_API_KEY",
    },
    policy: {
      sandboxId,
      revision: "3",
      document: policy,
    },
    configuration: {
      sandboxId,
      workspace: "default",
      revision: 3,
      policyHash: "a".repeat(64),
      configRevision: "1",
      providerEnvRevision: "2",
      policySource: "sandbox",
      globalPolicyVersion: 0,
    },
    ...overrides,
  };
}

function findings(result: ReturnType<typeof verifyExportSource>) {
  return result.kind === "verified" ? [] : result.findings;
}

function verifiedSource(result: ReturnType<typeof verifyExportSource>) {
  expect(result.kind).toBe("verified");
  return (result as Extract<typeof result, { kind: "verified" }>).source;
}

function verify(
  value: ObservedExportSnapshot,
  requestedSandboxName = "alpha",
  policyRepresentable = true,
) {
  const identity = { sandboxId: value.policy.sandboxId, revision: value.policy.revision };
  const qualified = {
    ...value,
    policy: policyRepresentable
      ? { ...identity, kind: "verified", canonical: canonicalPolicy }
      : { ...identity, kind: "not-representable" },
  } as QualifiedExportSnapshot;
  return verifyExportSource(requestedSandboxName, qualified);
}

describe("config export source verification (#10938)", () => {
  it("qualifies and verifies two equal snapshots through the observer", async () => {
    const observed = snapshot();
    const result = await observeStableExportSource("alpha", {
      read: async () => observed,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      source: { sandboxName: "alpha", policy: canonicalPolicy },
    });
  });

  it("narrows one supported snapshot to an immutable verified source", () => {
    const result = verify(snapshot());

    expect(result).toMatchObject({
      kind: "verified",
      source: {
        sandboxName: "alpha",
        runtime: { provider: "docker", imageRef },
        inference: { api: "openai-responses" },
      },
    });
    const source = verifiedSource(result);
    expect(Check(ExportSourceValuesSchema, source)).toBe(true);
    expect(source).not.toHaveProperty("registry");
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.policy)).toBe(true);
  });

  it.each([
    { sandboxName: "alpha--beta" },
    { runtime: { provider: "docker", imageRef: "registry/image:latest" } },
    { gateway: { name: "nemoclaw", port: 0 } },
    { inference: { provider: "e\u0301".repeat(257) } },
    { inference: { api: "openai-unknown" } },
    { inference: { endpoint: "https://user:secret@api.example.com/v1" } },
    { inference: { endpoint: "https://api.example.com/%0A%" } },
    { inference: { credentialEnv: "NEMOCLAW_INTERNAL_KEY" } },
  ])("rejects unrepresentable source values: %j", (invalid) => {
    const source = verifiedSource(verify(snapshot()));
    expect(
      Check(ExportSourceValuesSchema, {
        ...source,
        ...invalid,
        inference: { ...source.inference, ...invalid.inference },
      }),
    ).toBe(false);
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

  it.each([{ sandboxId: "replacement-id" }, { workspace: "other" }, { revision: 4 }])(
    "rejects configuration that belongs to another source %j",
    (change) => {
      const value = snapshot();
      const result = verify({ ...value, configuration: { ...value.configuration, ...change } });
      expect(findings(result)).toContainEqual(
        expect.objectContaining({
          field: "source.sandbox.configuration",
          category: "drifted",
        }),
      );
    },
  );

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
          provider: {
            gatewayName: "other",
            workspace: "default",
            name: "other",
            id: "other-id",
            resourceVersion: "9",
          },
          source: { kind: "provider-config", key: "OPENAI_BASE_URL" },
        },
        credentialEnv: null,
      },
      policy: { ...snapshot().policy, sandboxId: "other-id", revision: "4", document: policy },
    });

    const result = verify(changed);
    const fields = findings(result).map(({ field }) => field);

    expect(result.kind).toBe("rejected");
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
    const result = verify(raw);

    expect(result).toMatchObject({ kind: "verified" });
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
          provider: { ...value.inference.endpointEvidence!.provider, name: "other-provider" },
        },
      },
    });

    const missingResult = verify(missing);
    const mismatchResult = verify(mismatched);

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
    {
      label: "provider identity",
      provider: "openai-api",
      api: "openai-completions",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      endpoint: "https://integrate.api.nvidia.com/v1",
    },
    {
      label: "API family",
      provider: "nvidia-prod",
      api: "anthropic-messages",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      endpoint: "https://integrate.api.nvidia.com/v1",
    },
    {
      label: "endpoint",
      provider: "nvidia-prod",
      api: "openai-completions",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      endpoint: "https://different.example/v1",
    },
    {
      label: "credential reference",
      provider: "nvidia-prod",
      api: "openai-completions",
      credentialEnv: null,
      endpoint: "https://integrate.api.nvidia.com/v1",
    },
  ])("rejects builtin NVIDIA evidence with the wrong $label", ({ label: _label, ...inference }) => {
    const value = snapshot();
    const result = verify({
      ...value,
      inference: {
        ...value.inference,
        ...inference,
        endpointEvidence: {
          endpoint: inference.endpoint,
          provider: {
            gatewayName: "nemoclaw",
            workspace: "default",
            name: inference.provider,
            id: "provider-id",
            resourceVersion: "8",
          },
          source: { kind: "builtin-profile", profileId: "nvidia" },
        },
      },
    });
    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.inference.endpoint",
        category: "drifted",
      }),
    );
  });

  it.each([
    "http://api.example.test/v1",
    "https://user:credential-canary@api.example.test/v1",
    "https://api.example.test/v1?token=credential-canary",
    "https://api.example.test/v1#credential-canary",
    "https://api.example.test/%0acredential-canary",
    "https://api.example.test/%0A%",
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

    const result = verify(raw);

    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.inferenceProviders[].endpoint" }),
    );
  });

  it.each([
    ["snapshot", snapshot({ sandboxName: "beta" })],
    ["registry", snapshot({ registry: entry({ name: "beta" }) })],
  ])("binds the requested name to the %s name", async (_source, raw) => {
    const result = verify(raw);

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
    const result = verify(raw, invalidName);

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
    const result = verify(raw);

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
    const result = verify(raw);

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "spec.sandboxes[].runtime.image" }),
    );
  });

  it.each(["Docker", "docker runtime", "docker_runtime", "-docker", "d".repeat(64)])(
    "rejects invalid runtime provider %s",
    async (openshellDriver) => {
      const raw = snapshot({ registry: entry({ openshellDriver }) });
      const result = verify(raw);

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
    const result = verify(raw);

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
      const result = verify(raw);

      expect(findings(result)).toContainEqual(
        expect.objectContaining({ field: "spec.inferenceProviders[].credential.env" }),
      );
    },
  );

  it("rejects credential-bearing policy without exposing its value", async () => {
    const canary = "credential-canary-value";
    const raw = snapshot({
      policy: {
        ...snapshot().policy,
        sandboxId,
        revision: "3",
        document: `version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\n  password: ${canary}\nnetwork_policies: {}\n`,
      },
    });
    const result = verify(raw, "alpha", false);

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ category: "policy-not-representable" }),
    );
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
