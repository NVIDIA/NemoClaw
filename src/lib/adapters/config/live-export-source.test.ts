// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
  expectExportRefusal,
} from "../../../../test/support/config-export-harness";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";
import { runConfigExport } from "../../actions/config/export";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import { asExportedConfig } from "../../../../test/support/config-export-document";

import { resolveGatewayStateDirForPort } from "../../onboard/gateway/state-dir";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { createLiveExportSnapshotReader } from "./live-export-source";
import {
  endpoint,
  readFailureCanary,
  imageRef,
  startupInput,
  startup,
  entry,
  inventory,
  provider,
  configuration,
  nativeNvidiaProvider,
  telemetryEntry,
  dashboardSource,
  braveProvider,
} from "./live-export-source-test-fixture";

function mockBraveLiveSource() {
  const built = buildManagedStartupProfile({
    ...startupInput,
    webSearch: { fetchEnabled: true, provider: "brave" },
  });
  mockSupportedLiveSource(3, 3, {
    ...entry,
    webSearchEnabled: true,
    webSearchProvider: "brave",
    workload: {
      ...(entry.workload as Extract<
        NonNullable<SandboxEntry["workload"]>,
        { kind: "managed-image" }
      >),
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    },
  });
  const search = braveProvider();
  raw.getProviderProfile.mockResolvedValue({ profile: managedBraveProfile() });
  raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
    name === "alpha-brave-search" ? { provider: search.provider } : provider(),
  );
  raw.getSandbox.mockResolvedValue({
    sandbox: {
      ...inventory().sandbox,
      spec: { template: { image: imageRef }, providers: ["alpha-brave-search"] },
    },
  });
  return search;
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
  it("exports Brave through SDK metadata without reading its credential value (#10904)", async () => {
    const search = mockBraveLiveSource();
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const yaml = writeStdout.mock.calls[0]![0];
    const document = asExportedConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]!.integrations?.["brave-search"]).toEqual({
      kind: "webSearch",
      provider: "brave",
      credential: { env: "BRAVE_API_KEY" },
    });
    expect(document.spec.inferenceProviders).toHaveLength(1);
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(yaml).not.toContain(readFailureCanary);
    expect(raw.getProvider.mock.calls.map(([request]) => request.name)).toEqual([
      "nvidia-prod",
      "alpha-brave-search",
      "nvidia-prod",
      "alpha-brave-search",
    ]);
    expect(raw.getProviderProfile).toHaveBeenCalledTimes(2);
    expect(raw.getProviderProfile).toHaveBeenCalledWith(
      { id: "brave", workspace: "default" },
      { signal: expect.any(AbortSignal) },
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { type: "generic" },
    { profileWorkspace: undefined },
    { profileWorkspace: "foreign" },
    { credentials: { OTHER_API_KEY: readFailureCanary } },
    { config: { BASE_URL: readFailureCanary } },
  ])("rejects unsupported Brave provider metadata without output %j (#10904)", async (change) => {
    const search = mockBraveLiveSource();
    raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
      name === "alpha-brave-search" ? { provider: { ...search.provider, ...change } } : provider(),
    );
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("sanitizes a failed Brave metadata read before publication (#10904)", async () => {
    mockBraveLiveSource();
    raw.getProvider
      .mockResolvedValueOnce(provider())
      .mockRejectedValueOnce(new Error(readFailureCanary));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    { source: "interceptor/foreign" },
    { source: "user", scope: "platform" },
    { resourceVersion: 0n },
    { endpoints: [] },
    { binaries: [] },
    { credentials: [] },
  ])("rejects a shadowed or changed Brave profile %# (#10904)", async (change) => {
    const search = mockBraveLiveSource();
    raw.getProviderProfile.mockResolvedValue({ profile: { ...managedBraveProfile(), ...change } });
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it("sanitizes a failed Brave profile read before publication (#10904)", async () => {
    const search = mockBraveLiveSource();
    raw.getProviderProfile.mockRejectedValue(new Error(readFailureCanary));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it("rejects a changing managed Brave profile revision without output (#10904)", async () => {
    const search = mockBraveLiveSource();
    let revision = 10n;
    raw.getProviderProfile.mockImplementation(async () => ({
      profile: { ...managedBraveProfile(), resourceVersion: revision++ },
    }));
    const { result, writeStdout, publish } = await exportLiveSource();
    expect(result).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
    });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(search.readCredential).not.toHaveBeenCalled();
  });

  it.each(["id", "resourceVersion"])(
    "rejects changing Brave provider %s without output (#10904)",
    async (field) => {
      const search = mockBraveLiveSource();
      let revision = 10;
      raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
        name === "alpha-brave-search"
          ? {
              provider: {
                ...search.provider,
                metadata: {
                  ...search.provider.metadata,
                  [field]: field === "id" ? `provider-${revision++}` : BigInt(revision++),
                },
              },
            }
          : provider(),
      );
      const { result, writeStdout, publish } = await exportLiveSource();
      expect(result).toMatchObject({
        ok: false,
        failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
      });
      expect(writeStdout).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(search.readCredential).not.toHaveBeenCalled();
    },
  );

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
        vi.mocked(captureSanitizedResolvedOpenshell).mockImplementationOnce(() => {
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
        raw.getSandboxConfig.mockImplementationOnce(() => {
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

  it("retains direct tool selection through the live reader and stable verifier", async () => {
    const profile = {
      ...startup.profile,
      tools: { ...startup.profile.tools, disclosure: "direct" as const },
    };
    const encodedProfile = encodeManagedStartupProfile(profile);
    mockSupportedLiveSource(3, 3, {
      ...entry,
      toolDisclosure: "direct",
      workload: {
        ...entry.workload,
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      },
    });
    const result = await observeStableExportSource("alpha", createLiveExportSnapshotReader());
    expect(result).toMatchObject({ ok: true, source: { tools: { disclosure: "direct" } } });
    expect(raw.getSandbox).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
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
    expect(captureSanitizedResolvedOpenshell).toHaveBeenCalledExactlyOnceWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({
        ignoreError: true,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("preserves live revision fields for structural stability checks", async () => {
    mockSupportedLiveSource();
    const reader = createLiveExportSnapshotReader();
    const first = await reader.read("alpha");
    raw.getSandbox.mockResolvedValue(inventory(8, 4));
    raw.getSandboxConfig.mockResolvedValue(configuration(4));

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
    raw.getSandboxConfig.mockResolvedValue({
      ...configuration(),
      policy: { ...configuration().policy, env: { TOKEN: canary } },
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

  it.each([0, 3])(
    "preserves global policy revision agreement for revision %i",
    async (globalPolicyVersion) => {
      mockSupportedLiveSource();
      raw.getSandboxConfig.mockResolvedValue({
        ...configuration(),
        policySource: 2,
        globalPolicyVersion,
      });
      const result = await createLiveExportSnapshotReader().read("alpha");
      expect(result).toMatchObject({
        kind: "observed",
        policy: { revision: "3" },
        configuration: { policySource: "global", globalPolicyVersion },
      });
    },
  );

  it("rejects a global policy revision that differs from the sandbox revision", async () => {
    mockSupportedLiveSource();
    raw.getSandboxConfig.mockResolvedValue({
      ...configuration(),
      policySource: 2,
      globalPolicyVersion: 4,
    });
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "effective-policy",
    });
  });

  it("maps route and policy revision drift to controlled read failures", async () => {
    mockSupportedLiveSource(4, 3);
    await expect(createLiveExportSnapshotReader().read("alpha")).resolves.toEqual({
      kind: "read-failed",
      stage: "effective-policy",
    });

    mockSupportedLiveSource();
    vi.mocked(captureSanitizedResolvedOpenshell).mockReturnValue({
      status: 0,
      output: "Gateway inference:\n  Provider: nvidia-prod\n  Model: model-b\n",
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
    const document = asExportedConfig(YAML.parse(yaml));
    expect(document.spec.inferenceProviders).toEqual([
      {
        name: "hosted-nvidia-prod",
        provider: "openai",
        api: "openai-completions",
        endpoint,
        credential: { env: "NVIDIA_INFERENCE_API_KEY" },
      },
    ]);
    expect(document.spec.sandboxes[0].harness.kind).toBe("openclaw");
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

  it.each([
    { sampleRate: 0, serviceName: "s", collectorAllowed: true },
    { sampleRate: 0.5, serviceName: "research-assistant", collectorAllowed: true },
    { sampleRate: 1, serviceName: "s".repeat(256), collectorAllowed: true },
    { sampleRate: 0.5, serviceName: "research assistant", collectorAllowed: false },
  ])(
    "exports retained OTLP settings at sample $sampleRate without changing policy",
    async ({ sampleRate, serviceName, collectorAllowed }) => {
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL", "0");
      vi.stubEnv(
        "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
        "https://ignored.example/credential-canary-value",
      );
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME", "ignored-service");
      vi.stubEnv("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE", "0.9");
      mockSupportedLiveSource(3, 3, telemetryEntry({ sampleRate, serviceName }));
      const effective = configuration();
      const policy = {
        ...effective.policy,
        network_policies: {
          ...effective.policy.network_policies,
          ...(collectorAllowed
            ? {
                collector: {
                  name: "collector",
                  endpoints: [
                    {
                      host: "host.openshell.internal",
                      port: 4318,
                      protocol: "rest",
                      enforcement: "enforce",
                      allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
                      rules: [{ allow: { method: "POST", path: "/v1/traces" } }],
                    },
                  ],
                  binaries: [{ path: "/usr/local/bin/node" }],
                },
              }
            : {}),
        },
      };
      raw.getSandboxConfig.mockResolvedValue({ ...effective, policy });
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
      const yaml = writeStdout.mock.calls[0]?.[0] ?? "";
      const document = asExportedConfig(YAML.parse(yaml));
      expect(document.spec.sandboxes[0]?.harness).toMatchObject({
        kind: "openclaw",
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName,
            sampleRate,
          },
        },
      });
      expect(document.spec.sandboxes[0]?.network.policy.explicit).toMatchObject({
        process: { run_as_user: "1000", run_as_group: "1000" },
      });
      expect(yaml).not.toContain(readFailureCanary);
      expect(yaml).not.toContain("NEMOCLAW_OPENCLAW_OTEL");
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "credential-bearing endpoint",
      telemetry: {
        endpointUrl: "http://user:credential-canary-value@host.openshell.internal:4318",
      },
    },
    {
      label: "collector query",
      telemetry: {
        endpointUrl: "http://host.openshell.internal:4318?token=credential-canary-value",
      },
    },
    {
      label: "remote collector",
      telemetry: { endpointUrl: "https://collector.example/v1/traces" },
    },
    { label: "invalid service", telemetry: { serviceName: "service\n" } },
    { label: "Unicode service", telemetry: { serviceName: "équipe" } },
    { label: "oversized service", telemetry: { serviceName: "s".repeat(257) } },
    { label: "out-of-range sample", telemetry: { sampleRate: 1.1 } },
    { label: "disabled nondefault settings", telemetry: { enabled: false } },
    { label: "invalid agent timeout", settings: { agentTimeoutSeconds: 1000000001 } },
    { label: "conflicting agent", registry: { agent: "hermes" } },
    { label: "DCode observability marker", registry: { observabilityEnabled: true } },
    {
      label: "stale workload",
      registry: {
        workload: { ...telemetryEntry().workload, startupProfileSha256: "c".repeat(64) },
      },
    },
    { label: "missing workload", registry: { workload: undefined } },
  ])("rejects telemetry $label before any output", async ({ telemetry, settings, registry }) => {
    mockSupportedLiveSource(3, 3, { ...telemetryEntry(telemetry, settings), ...registry });
    const writeStdout = vi.fn();
    const publish = vi.fn();

    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "file", outputPath: "/tmp/alpha.yaml", force: false },
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

  it("does not publish telemetry that changes during both observation pairs", async () => {
    mockSupportedLiveSource();
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: telemetryEntry({ sampleRate: reads++ % 2 === 0 ? 0.5 : 1 }) },
      defaultSandbox: null,
    }));
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

    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "observation", attempts: 2, findings: [{ category: "unstable-source" }] },
    });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
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
    expect(raw.getSandboxConfig).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
  });

  it("refuses an observed agent roster before publishing singular v1alpha1 output (#12131)", async () => {
    const built = buildManagedStartupProfile({
      ...startupInput,
      environment: {
        NEMOCLAW_EXTRA_AGENTS_JSON: JSON.stringify([
          { id: "researcher", tools: { allow: ["read"] } },
          { id: "reviewer", tools: { allow: ["read"] } },
        ]),
      },
    });
    mockSupportedLiveSource(3, 3, {
      ...entry,
      workload: {
        ...entry.workload,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
      },
    });
    const { result, writeStdout } = await exportLiveSource();
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([
          expect.objectContaining({ field: "spec.sandboxes[].agent", category: "unsupported" }),
        ]),
      },
    });
    expect(writeStdout).not.toHaveBeenCalled();
    expect(raw.getSandboxConfig).toHaveBeenCalledTimes(2);
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
describe("dashboard export observation", () => {
  it("projects registered dashboard and direct tools through complete live observation (#10904)", async () => {
    const sourceEntry = dashboardSource();
    mockSupportedLiveSource(3, 3, sourceEntry);
    const reader = createLiveExportSnapshotReader();
    const observed = await reader.read("alpha");
    expect(observed).toMatchObject({
      kind: "observed",
      registry: {
        dashboardPort: 19000,
        dashboardRemoteBindPrepared: true,
        toolDisclosure: "direct",
      },
    });
    const writeStdout = vi.fn(async (_yaml: string) => {});
    const result = await runConfigExport(
      {
        sandboxName: "alpha",
        documentName: parseNemoClawConfigDocumentName("alpha"),
        target: { kind: "stdout" },
      },
      {
        observe: (name) => observeStableExportSource(name, reader),
        createDocumentUid: () =>
          parseNemoClawConfigDocumentUid("123e4567-e89b-42d3-a456-426614174001"),
        writeStdout,
        publish: vi.fn(),
      },
    );
    expect(result).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(JSON.stringify(result)).not.toContain(readFailureCanary);
    const yaml = writeStdout.mock.calls[0]?.[0] ?? "";
    expect(yaml).not.toContain(readFailureCanary);
    const document = asExportedConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]?.harness).toMatchObject({
      kind: "openclaw",
      interfaces: { dashboard: { port: 19000, bind: "0.0.0.0" } },
    });
    expect(document.spec.sandboxes[0]!.agent).toMatchObject({
      tools: { disclosure: "direct" },
    });
  });

  it("refuses dashboard registry changes without publishing (#10904)", async () => {
    mockSupportedLiveSource();
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: { ...entry, dashboardPort: reads++ % 2 === 0 ? 18789 : 19000 } },
      defaultSandbox: null,
    }));
    const exported = await exportLiveSource();
    expectExportRefusal(exported, { category: "unstable-source" });
  });
});

describe("Hermes interface export observation", () => {
  it("reads only retained interface fields and includes allocation changes in stability (#11433)", async () => {
    mockSupportedLiveSource();
    const first = {
      ...entry,
      hermesApiPort: 8643,
      hermesDashboardEnabled: true,
      hermesDashboardPort: 19000,
      hermesDashboardInternalPort: 19120,
      hermesDashboardTui: true,
    };
    vi.mocked(loadRegistry).mockReturnValue({ sandboxes: { alpha: first }, defaultSandbox: null });
    const reader = createLiveExportSnapshotReader();
    expect(await reader.read("alpha")).toMatchObject({
      kind: "observed",
      registry: {
        hermesApiPort: 8643,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 19000,
        hermesDashboardInternalPort: 19120,
        hermesDashboardTui: true,
      },
    });
    let reads = 0;
    vi.mocked(loadRegistry).mockImplementation(() => ({
      sandboxes: { alpha: { ...first, hermesApiPort: reads++ % 2 === 0 ? 8643 : 8644 } },
      defaultSandbox: null,
    }));
    expect(await observeStableExportSource("alpha", reader)).toMatchObject({
      ok: false,
      findings: [expect.objectContaining({ category: "unstable-source" })],
    });
    expect(reads).toBe(4);
  });
});
