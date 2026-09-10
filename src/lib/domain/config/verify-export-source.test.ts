// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import YAML from "yaml";
import { Check } from "typebox/value";
import { ExportSourceValuesSchema } from "./export-evidence";
import { describe, expect, it, vi } from "vitest";
import { runConfigExport } from "../../actions/config/export";
import { buildChain } from "../../dashboard/contract";
import { validateNemoClawConfig } from "../../config/schema";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
  type NemoClawConfig,
} from "../../config/model";
import { observeStableExportSource } from "../../actions/config/observe-export-source";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import type { ObservedExportSnapshot, QualifiedExportSnapshot } from "./export-evidence";
import { classifyExportRegistry, verifyExportSource } from "./verify-export-source";
import {
  sandboxId,
  imageRef,
  hermesImageRef,
  policy,
  canonicalPolicy,
  profileInput,
  hermesProfileInput,
  managedWorkload,
  entry,
  snapshot,
  braveSnapshot,
  hermesSnapshot,
  hermesManagedAuthSnapshot,
  tunedEnvironment,
  tunedSnapshot,
  compatibleSnapshot,
  proxySnapshot,
} from "./export-source-test-fixture";

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

async function exportSnapshots(sequence: readonly ObservedExportSnapshot[]) {
  let index = 0;
  const read = vi.fn(async () => sequence[Math.min(index++, sequence.length - 1)]!);
  const writeStdout = vi.fn(async (_contents: string) => undefined);
  const publish = vi.fn(() => ({ ok: true, outputPath: "/tmp/alpha.yaml" }) as const);
  const outcome = await runConfigExport(
    {
      sandboxName: "alpha",
      documentName: parseNemoClawConfigDocumentName("alpha"),
      target: { kind: "stdout" },
    },
    {
      observe: (name) => observeStableExportSource(name, { read }),
      createDocumentUid: () => parseNemoClawConfigDocumentUid(sandboxId),
      writeStdout,
      publish,
    },
  );
  return { outcome, read, writeStdout, publish };
}

function primaryOpenClawAgent(config: NemoClawConfig) {
  const agent = config.spec.sandboxes[0]!.agents[0]!;
  expect(agent.type).toBe("openclaw");
  return agent as Extract<typeof agent, { type: "openclaw" }>;
}

describe("config export source verification (#10938)", () => {
  it.each([
    { label: "default proxy", environment: {}, expected: {} },
    {
      label: "managed proxy",
      environment: { NEMOCLAW_PROXY_HOST: "proxy.internal", NEMOCLAW_PROXY_PORT: "3129" },
      expected: { proxy: { host: "proxy.internal", port: 3129 } },
    },
  ])("exports retained OpenClaw telemetry with $label", ({ environment, expected }) => {
    const value = snapshot({
      registry: entry({
        workload: managedWorkload(
          profileInput({
            environment: {
              NEMOCLAW_OPENCLAW_OTEL: "1",
              NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: "http://host.openshell.internal:4318",
              NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: "research-assistant",
              NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: "0.5",
              ...environment,
            },
          }),
        ),
      }),
    });

    expect(verifiedSource(verify(value))).toMatchObject({
      ...expected,
      observability: {
        otlp: {
          enabled: true,
          endpoint: "http://host.openshell.internal:4318",
          serviceName: "research-assistant",
          sampleRate: 0.5,
        },
      },
    });
  });

  it.each([false, true])(
    "verifies Brave with optional inference attachment %s (#10904)",
    (attached) => {
      const value = braveSnapshot();
      const providers = attached
        ? [value.inference.provider, "alpha-brave-search"]
        : ["alpha-brave-search"];
      const result = verify({ ...value, sandbox: { ...value.sandbox, providerNames: providers } });
      expect(verifiedSource(result).webSearch).toEqual({
        provider: "brave",
        agentRefs: ["primary"],
        credential: { env: "BRAVE_API_KEY" },
      });
    },
  );

  it.each([
    [],
    ["foreign-brave-search"],
    ["alpha-brave-search", "alpha-brave-search"],
    ["alpha-brave-search", "extra"],
    ["alpha-brave-search", "openai-api", "openai-api"],
  ])("rejects missing or unexpected Brave attachments %j (#10904)", (...providerNames) => {
    const value = braveSnapshot();
    expect(
      findings(verify({ ...value, sandbox: { ...value.sandbox, providerNames } })),
    ).toContainEqual(
      expect.objectContaining({ field: "source.sandbox.providers", category: "unsupported" }),
    );
  });

  it.each([
    { gatewayName: "foreign" },
    { workspace: "foreign" },
    { name: "foreign-brave-search" },
    { id: "" },
    { resourceVersion: "" },
    { resourceVersion: "0" },
    { type: "generic" },
    { credentialKeys: ["TAVILY_API_KEY"] },
    { credentialKeys: ["BRAVE_API_KEY", "OTHER_KEY"] },
    { configKeys: ["BASE_URL"] },
    { profileWorkspace: "foreign" },
    { profileWorkspace: undefined },
    { profile: undefined },
    { profile: { id: "other", source: "builtin", scope: "", resourceVersion: "0" } },
    { profile: { id: "brave", source: "user", scope: "platform", resourceVersion: "1" } },
    { profile: { id: "brave", source: "builtin", scope: "workspace", resourceVersion: "0" } },
    { profile: { id: "brave", source: "builtin", scope: "", resourceVersion: "1" } },
  ])("rejects mismatched Brave metadata %j (#10904)", (change) => {
    const value = braveSnapshot();
    expect(
      findings(verify({ ...value, webSearchProvider: { ...value.webSearchProvider!, ...change } })),
    ).toContainEqual(expect.objectContaining({ field: "source.webSearch", category: "drifted" }));
  });

  it("requires Brave metadata and matching startup intent (#10904)", () => {
    const value = braveSnapshot();
    expect(findings(verify({ ...value, webSearchProvider: undefined }))).toContainEqual(
      expect.objectContaining({ field: "source.webSearch", category: "missing-provenance" }),
    );
    expect(
      findings(verify({ ...value, registry: { ...value.registry, workload: managedWorkload() } })),
    ).toContainEqual(
      expect.objectContaining({ field: "source.workload.startupProfile", category: "unsupported" }),
    );
    expect(
      findings(verify({ ...value, registry: { ...value.registry, webSearchProvider: "tavily" } })),
    ).toContainEqual(
      expect.objectContaining({
        field: "spec.sandboxes[].integrations.webSearch",
        category: "unsupported",
      }),
    );
  });

  it("retains OpenClaw execution settings with Brave enabled (#10904)", () => {
    const value = braveSnapshot();
    const workload = managedWorkload(
      profileInput({
        webSearch: { fetchEnabled: true, provider: "brave" },
        environment: { NEMOCLAW_AGENT_TIMEOUT: "900" },
      }),
    );
    expect(
      verifiedSource(verify({ ...value, registry: { ...value.registry, workload } })),
    ).toMatchObject({
      execution: { timeoutSeconds: 900 },
      webSearch: { provider: "brave" },
    });
  });

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

  it.each([
    { telemetry: false, expected: {} },
    {
      telemetry: true,
      expected: {
        observability: {
          otlp: {
            enabled: true,
            endpoint: "http://host.openshell.internal:4318",
            serviceName: "openclaw-gateway",
            sampleRate: 1,
          },
        },
      },
    },
  ])(
    "exports retained tuning and execution with telemetry $telemetry",
    async ({ telemetry, expected }) => {
      const observed = tunedSnapshot({
        ...tunedEnvironment,
        ...(telemetry ? { NEMOCLAW_OPENCLAW_OTEL: "1" } : {}),
      });
      const result = await exportSnapshots([observed]);
      expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
      expect(result.read).toHaveBeenCalledTimes(2);
      const [yaml] = result.writeStdout.mock.calls[0]!;
      const config = validateNemoClawConfig(YAML.parse(yaml));
      const agent = primaryOpenClawAgent(config);
      expect(agent.inference.routes[0]!.overrides).toEqual({
        model: "gpt-5",
        contextWindow: 65536,
        maxTokens: 8192,
        reasoning: true,
        reasoningEffort: "high",
      });
      expect(agent.execution).toEqual({ timeoutSeconds: 900, heartbeatEvery: "30m" });
      expect(agent).toMatchObject(expected);
      expect(Object.hasOwn(agent, "observability")).toBe(telemetry);
      expect(config.spec.sandboxes[0]!.network.policy.explicit).toEqual(canonicalPolicy);
      expect(config.spec.inferenceProviders[0]).toEqual(
        expect.objectContaining({ credential: { env: "OPENAI_API_KEY" } }),
      );
      const verifiedInference = verifiedSource(verify(observed)).inference;
      expect("overrides" in verifiedInference).toBe(true);
      const hostedInference = verifiedInference as Extract<
        typeof verifiedInference,
        { readonly endpoint: string }
      >;
      expect(Object.isFrozen(hostedInference.overrides)).toBe(true);
      expect(result.publish).not.toHaveBeenCalled();
    },
  );

  it("preserves canonical output when all six settings use their defaults", async () => {
    const baseline = await exportSnapshots([snapshot()]);
    const explicit = await exportSnapshots([
      tunedSnapshot({
        NEMOCLAW_CONTEXT_WINDOW: "131072",
        NEMOCLAW_MAX_TOKENS: "4096",
        NEMOCLAW_REASONING: "false",
        NEMOCLAW_REASONING_EFFORT: "default",
        NEMOCLAW_AGENT_TIMEOUT: "600",
      }),
    ]);
    expect(explicit.outcome.ok).toBe(true);
    expect(explicit.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    const config = validateNemoClawConfig(YAML.parse(explicit.writeStdout.mock.calls[0]![0]));
    expect(config.spec.sandboxes[0]!.agents[0]!.inference.routes[0]!.overrides).toEqual({
      model: "gpt-5",
    });
    expect(config.spec.sandboxes[0]!.agents[0]).not.toHaveProperty("execution");
  });

  it("retains an explicit zero heartbeat duration", async () => {
    const result = await exportSnapshots([tunedSnapshot({ NEMOCLAW_AGENT_HEARTBEAT_EVERY: "0m" })]);
    expect(result.outcome.ok).toBe(true);
    const config = validateNemoClawConfig(YAML.parse(result.writeStdout.mock.calls[0]![0]));
    expect(primaryOpenClawAgent(config).execution).toEqual({ heartbeatEvery: "0m" });
  });

  it.each(Object.entries(tunedEnvironment))(
    "rejects unstable retained setting %s before publication",
    async (key, value) => {
      const changed = tunedSnapshot({ [key]: value });
      const result = await exportSnapshots([snapshot(), changed, snapshot(), changed]);
      expect(result.outcome).toMatchObject({
        ok: false,
        failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
      });
      expect(result.read).toHaveBeenCalledTimes(4);
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
    },
  );

  it("exports a stable tuning observation after one changed pair", async () => {
    const changed = tunedSnapshot();
    const result = await exportSnapshots([snapshot(), changed, changed, changed]);
    expect(result.outcome.ok).toBe(true);
    expect(result.read).toHaveBeenCalledTimes(4);
    const config = validateNemoClawConfig(YAML.parse(result.writeStdout.mock.calls[0]![0]));
    expect(primaryOpenClawAgent(config).execution?.timeoutSeconds).toBe(900);
  });

  it.each([
    ["true", "high"],
    ["false", undefined],
  ] as const)("exports consistent compatible endpoint reasoning %s", async (reasoning, effort) => {
    const observed = compatibleSnapshot(
      { NEMOCLAW_REASONING: reasoning, ...(effort ? { NEMOCLAW_REASONING_EFFORT: effort } : {}) },
      { compatibleEndpointReasoning: reasoning, compatibleEndpointReasoningEffort: effort ?? null },
    );
    const result = await exportSnapshots([observed]);
    expect(result.outcome.ok).toBe(true);
    const route = validateNemoClawConfig(YAML.parse(result.writeStdout.mock.calls[0]![0])).spec
      .sandboxes[0]!.agents[0]!.inference.routes[0]!;
    expect(route.overrides).toEqual(
      reasoning === "true"
        ? { model: "gpt-5", reasoning: true, reasoningEffort: "high" }
        : { model: "gpt-5" },
    );
  });

  it.each([
    {},
    { compatibleEndpointReasoning: null, compatibleEndpointReasoningEffort: null },
    { compatibleEndpointReasoning: "false" },
    { compatibleEndpointReasoning: false },
    { compatibleEndpointReasoningEffort: "low" },
    { compatibleEndpointReasoning: "credential-canary" },
  ])("rejects inconsistent reasoning evidence without publication", async (change) => {
    const observed = compatibleSnapshot(tunedEnvironment, change as Partial<SandboxEntry>);
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "drifted" })] },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outcome)).not.toContain("credential-canary");
  });

  it("rejects enabled registry reasoning when the receipt retains false", async () => {
    const result = await exportSnapshots([
      compatibleSnapshot({}, { compatibleEndpointReasoning: "true" }),
    ]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "drifted" })] },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("rejects stale compatible endpoint reasoning on another provider", async () => {
    const observed = tunedSnapshot();
    const result = await exportSnapshots([
      { ...observed, registry: { ...observed.registry, compatibleEndpointReasoning: "true" } },
    ]);
    expect(result.outcome.ok).toBe(false);
    expect(result.writeStdout).not.toHaveBeenCalled();
  });

  it.each([
    ["tuning", { contextWindow: 4194305 }],
    ["tuning", { maxTokens: 1000000001 }],
    ["tuning", { reasoning: null }],
    ["tuning", { reasoningEffort: "credential-canary" }],
    ["tuning", { unexpected: "credential-canary" }],
    ["agentConfig", { agentTimeoutSeconds: 1000000001 }],
    ["agentConfig", { heartbeatEvery: "3".repeat(256) + "m" }],
    ["agentConfig", { heartbeatEvery: "30m\n" }],
    ["agentConfig", { minimalBootstrap: true }],
    [
      "agentConfig",
      {
        otel: {
          enabled: true,
          endpointUrl: "https://unsupported-collector.example",
          serviceName: "openclaw-gateway",
          sampleRate: 1,
        },
      },
    ],
    ["tools", { disclosure: "direct" }],
    ["inference", { inputModalities: ["text", "image"] }],
  ] as const)(
    "rejects unrepresentable %s settings alongside valid tuning",
    async (section, change) => {
      const workload = managedWorkload(profileInput({ environment: tunedEnvironment }));
      const profile = JSON.parse(
        Buffer.from(workload.encodedProfile, "base64url").toString("utf8"),
      );
      Object.assign(profile[section], change);
      const encodedProfile = Buffer.from(JSON.stringify(profile)).toString("base64url");
      const observed = snapshot({
        registry: entry({
          workload: {
            ...workload,
            encodedProfile,
            startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
          },
        }),
      });
      const result = await exportSnapshots([observed]);
      expect(result.outcome.ok).toBe(false);
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result.outcome)).not.toContain("credential-canary");
    },
  );

  it("rejects a tuned source with a mismatched receipt hash", async () => {
    const observed = tunedSnapshot();
    const workload = observed.registry.workload!;
    const result = await exportSnapshots([
      {
        ...observed,
        registry: {
          ...observed.registry,
          workload: { ...workload, startupProfileSha256: "c".repeat(64) } as SandboxWorkloadReceipt,
        },
      },
    ]);
    expect(result.outcome.ok).toBe(false);
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
  it("exports retained managed proxy settings through the complete action", async () => {
    const observed = proxySnapshot();
    const result = await exportSnapshots([observed]);

    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.read).toHaveBeenCalledTimes(2);
    expect(result.publish).not.toHaveBeenCalled();
    const [yaml] = result.writeStdout.mock.calls[0]!;
    const config = validateNemoClawConfig(YAML.parse(yaml));
    expect(config.spec.sandboxes[0]!.network).toEqual({
      proxy: { host: "proxy.internal", port: 3129 },
      policy: { explicit: canonicalPolicy },
    });
    expect(Object.isFrozen(verifiedSource(verify(observed)).proxy)).toBe(true);
  });

  it("omits the default proxy from existing canonical exports", async () => {
    const result = await exportSnapshots([snapshot()]);
    expect(result.outcome.ok).toBe(true);
    const [yaml] = result.writeStdout.mock.calls[0]!;
    expect(validateNemoClawConfig(YAML.parse(yaml)).spec.sandboxes[0]!.network).toEqual({
      policy: { explicit: canonicalPolicy },
    });
    expect(verifiedSource(verify(snapshot()))).not.toHaveProperty("proxy");
  });

  it("exports a complete proxy pair when only its port changes", () => {
    const observed = proxySnapshot({
      NEMOCLAW_PROXY_HOST: "10.200.0.1",
      NEMOCLAW_PROXY_PORT: "3129",
    });
    expect(verifiedSource(verify(observed)).proxy).toEqual({ host: "10.200.0.1", port: 3129 });
  });

  it("uses a stable proxy observation after one changed pair", async () => {
    const changed = proxySnapshot();
    const result = await exportSnapshots([snapshot(), changed, changed, changed]);
    expect(result.outcome.ok).toBe(true);
    expect(result.read).toHaveBeenCalledTimes(4);
    const [yaml] = result.writeStdout.mock.calls[0]!;
    expect(validateNemoClawConfig(YAML.parse(yaml)).spec.sandboxes[0]!.network.proxy).toEqual({
      host: "proxy.internal",
      port: 3129,
    });
  });

  it("does not publish proxy settings when both snapshot pairs change", async () => {
    const result = await exportSnapshots([
      snapshot(),
      proxySnapshot(),
      snapshot(),
      proxySnapshot(),
    ]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("does not publish while retained Hermes auth provenance is changing (#11432)", async () => {
    const accepted = hermesManagedAuthSnapshot();
    const missing = hermesManagedAuthSnapshot({ hermesAuthMethod: null });
    const result = await exportSnapshots([accepted, missing, accepted, missing]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(result.read).toHaveBeenCalledTimes(4);
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([
    { managedHost: "user:secret-canary@proxy.internal" },
    { managedHost: "http://proxy.internal" },
    { managedHost: "proxy.internal\n" },
    { managedHost: "a".repeat(257) },
    { managedPort: 0 },
    { managedPort: 65_536 },
    { managedPort: 3129.5 },
    { unexpected: "secret-canary" },
    { hostHttpUrl: "http://proxy.internal:3129" },
    { hostHttpsUrl: "http://proxy.internal:3129" },
    { hostNoProxy: ["private.internal"] },
  ])("does not publish invalid or unsupported retained proxy fields", async (change) => {
    const workload = managedWorkload();
    const profile = JSON.parse(Buffer.from(workload.encodedProfile, "base64url").toString("utf8"));
    Object.assign(profile.proxy, change);
    const encodedProfile = Buffer.from(JSON.stringify(profile)).toString("base64url");
    const observed = snapshot({
      registry: entry({
        workload: {
          ...workload,
          encodedProfile,
          startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
        },
      }),
    });
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outcome)).not.toContain("secret-canary");
  });

  it.each([
    { credentialProxyReplayRequired: true },
    { corporateCaB64: "secret-canary" },
    { startupProfileSha256: "c".repeat(64) },
    { reference: imageRef.replace(/a{64}$/, "b".repeat(64)) },
  ])(
    "does not publish proxy settings without eligible matching workload authority",
    async (change) => {
      const observed = proxySnapshot();
      const workload = observed.registry.workload!;
      const result = await exportSnapshots([
        {
          ...observed,
          registry: { ...observed.registry, workload: { ...workload, ...change } },
        },
      ]);
      expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(result.writeStdout).not.toHaveBeenCalled();
      expect(result.publish).not.toHaveBeenCalled();
      expect(JSON.stringify(result.outcome)).not.toContain("secret-canary");
    },
  );

  it("narrows one supported snapshot to an immutable verified source", () => {
    const result = verify(snapshot());

    expect(result).toMatchObject({
      kind: "verified",
      source: {
        sandboxName: "alpha",
        agent: "openclaw",
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

  it("verifies a canonical managed Hermes source (#11286)", () => {
    const result = verify(hermesSnapshot());

    expect(result).toMatchObject({
      kind: "verified",
      source: {
        sandboxName: "alpha",
        agent: "hermes",
        runtime: { provider: "docker", imageRef: hermesImageRef },
        inference: { api: "openai-responses" },
      },
    });
    expect(Check(ExportSourceValuesSchema, verifiedSource(result))).toBe(true);
  });

  it("exports explicit retained Hermes Nous API-key authentication (#11432)", async () => {
    const observed = hermesManagedAuthSnapshot();
    expect(verifiedSource(verify(observed)).auth).toEqual({ method: "api-key" });

    const result = await exportSnapshots([observed]);
    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.read).toHaveBeenCalledTimes(2);
    expect(result.publish).not.toHaveBeenCalled();
    const [yaml] = result.writeStdout.mock.calls[0]!;
    const document = validateNemoClawConfig(YAML.parse(yaml));
    expect(document.spec.sandboxes[0]!.agents[0]!.auth).toEqual({
      method: "api-key",
      providerRef: "hosted-hermes-provider",
    });
    expect(document.spec.inferenceProviders[0]).toMatchObject({
      name: "hosted-hermes-provider",
      provider: "hermes-provider",
      credential: { env: "NOUS_API_KEY" },
    });
  });

  it.each([
    ["OAuth", { hermesAuthMethod: "oauth" as const }, "unsupported", "api-key"],
    ["missing auth provenance", { hermesAuthMethod: null }, "missing-provenance", "api-key"],
    ["foreign auth provenance", { hermesAuthMethod: "api_key" as const }, "drifted", "generic"],
    [
      "API-key authentication with a foreign API",
      { preferredInferenceApi: "anthropic-messages" },
      "drifted",
      "api-key",
    ],
    [
      "API-key authentication with a foreign endpoint",
      { endpointUrl: "https://api.example.com/v1" },
      "drifted",
      "api-key",
    ],
  ])("does not export Hermes %s (#11432)", async (_case, registryOverrides, category, source) => {
    const observed =
      source === "generic"
        ? hermesSnapshot(registryOverrides)
        : hermesManagedAuthSnapshot(registryOverrides);
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([
          expect.objectContaining({
            category,
            field: "spec.sandboxes[].agents[0].auth",
          }),
        ]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([
    { sandboxName: "alpha--beta" },
    { runtime: { provider: "docker", imageRef: "registry/image:latest" } },
    { gateway: { name: "nemoclaw", port: 0 } },
    { inference: { provider: "e\u0301".repeat(257) } },
    { inference: { provider: "vllm-local" } },
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
        agent: "unsupported-agent",
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

  it.each([
    [
      "Hermes tool gateways",
      { hermesToolGateways: ["browser"] },
      "spec.sandboxes[].agents[0].tools",
    ],
    [
      "Hermes dashboard",
      { hermesDashboardEnabled: true, hermesDashboardPort: 18_790 },
      "spec.sandboxes[].agents[0].dashboard",
    ],
    [
      "invalid Hermes dashboard port evidence",
      { hermesDashboardPort: 0 },
      "spec.sandboxes[].agents[0].dashboard",
    ],
    [
      "Hermes inference provider",
      { hermesInferenceProvider: "hermes-provider" },
      "spec.sandboxes[].agents[0].auth",
    ],
    ["non-default Hermes API port", { hermesApiPort: 8643 }, "spec.sandboxes[].agents[0].api"],
  ])("rejects excluded %s state (#11286)", (_case, registryOverrides, field) => {
    expect(findings(verify(hermesSnapshot(registryOverrides)))).toContainEqual(
      expect.objectContaining({ category: "unsupported", field }),
    );
  });

  it("rejects stale agent-specific state on an OpenClaw registry row (#11286)", () => {
    expect(
      findings(verify(snapshot({ registry: entry({ hermesToolGateways: ["browser"] }) }))),
    ).toContainEqual({
      category: "unsupported",
      diagnostic: "V1 export does not support stale agent-specific registry state.",
      field: "source.registry",
    });
  });

  it("rejects OpenClaw workload authority for a Hermes registry row (#11286)", () => {
    const result = verify(
      hermesSnapshot({ workload: managedWorkload(profileInput(), hermesImageRef) }),
    );

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "source.workload", category: "missing-provenance" }),
    );
  });

  it("rejects a noncanonical managed Hermes startup profile (#11286)", () => {
    const configured = hermesProfileInput();
    const workload = managedWorkload(
      {
        ...configured,
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: "http://127.0.0.1:19189",
          browserUrl: "http://127.0.0.1:19189",
          publicPort: 19_189,
          internalPort: 29_189,
          tuiEnabled: false,
        },
      },
      hermesImageRef,
    );
    const result = verify(hermesSnapshot({ workload }));

    expect(findings(result)).toContainEqual(
      expect.objectContaining({ field: "source.workload.startupProfile", category: "unsupported" }),
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

  it.each([
    { label: "default proxy", environment: {} },
    {
      label: "managed proxy",
      environment: { NEMOCLAW_PROXY_HOST: "proxy.internal", NEMOCLAW_PROXY_PORT: "3129" },
    },
  ])("rejects a custom dashboard URL alongside $label", async ({ environment }) => {
    const base = profileInput();
    const dashboard = base.dashboard as Extract<
      ManagedStartupProfileBuilderInput["dashboard"],
      { agent: "openclaw" }
    >;
    const configured = profileInput({
      dashboard: {
        ...dashboard,
        mode: "remote",
        url: "https://dashboard.example.com:18888",
        port: 18_888,
      },
      environment,
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

function dashboardSnapshot(
  port = 19000,
  bind: "127.0.0.1" | "0.0.0.0" = "0.0.0.0",
  environment: ManagedStartupProfileBuilderInput["environment"] = {},
) {
  const chain = buildChain({ port, bindOverride: bind });
  const workload = managedWorkload(
    profileInput({
      dashboard: {
        agent: "openclaw",
        mode: chain.shouldDisableDeviceAuth ? "remote" : "loopback",
        url: chain.accessUrl,
        port: chain.port,
        bindAddress: bind,
        wslExposure: false,
      },
      environment,
    }),
  );
  return snapshot({
    registry: entry({
      dashboardPort: port,
      dashboardRemoteBindPrepared: bind === "0.0.0.0",
      workload,
    }),
  });
}

function changeDashboardProfile(
  observed: ObservedExportSnapshot,
  change: (profile: Record<string, Record<string, unknown>>) => void,
) {
  const workload = observed.registry.workload as Extract<
    SandboxWorkloadReceipt,
    { kind: "managed-image" }
  >;
  expect(workload?.kind).toBe("managed-image");
  const value = JSON.parse(Buffer.from(workload.encodedProfile, "base64url").toString("utf8"));
  change(value);
  const serialized = JSON.stringify(value);
  const encodedProfile = Buffer.from(serialized).toString("base64url");
  return {
    ...observed,
    registry: {
      ...observed.registry,
      workload: {
        ...workload,
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
      },
    },
  };
}

async function exportDashboardSnapshots(observed: readonly ObservedExportSnapshot[]) {
  const writeStdout = vi.fn(async (_yaml: string) => {});
  const publish = vi.fn();
  let index = 0;
  const read = vi.fn(async () => observed[index++ % observed.length]!);
  const result = await runConfigExport(
    {
      sandboxName: "alpha",
      documentName: parseNemoClawConfigDocumentName("alpha"),
      target: { kind: "stdout" },
    },
    {
      observe: (name) => observeStableExportSource(name, { read }),
      createDocumentUid: () =>
        parseNemoClawConfigDocumentUid("11111111-1111-4111-8111-111111111111"),
      writeStdout,
      publish,
    },
  );
  return { result, writeStdout, publish, read };
}

describe("dashboard settings export", () => {
  it("keeps canonical Hermes export free of dashboard interfaces (#10904)", async () => {
    const exported = await exportSnapshots([hermesSnapshot()]);
    expect(exported.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]).toEqual({
      type: "hermes",
      name: "primary",
      inference: {
        routes: [
          { name: "primary", providerRef: "hosted-openai-api", overrides: { model: "gpt-5" } },
        ],
      },
    });
  });

  it.each([
    { hermesDashboardEnabled: true, hermesDashboardPort: 19000 },
    { dashboardRemoteBindPrepared: true },
  ])("does not publish unsupported Hermes dashboard state %j (#10904)", async (registry) => {
    const exported = await exportSnapshots([hermesSnapshot(registry)]);
    expect(exported.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([
          expect.objectContaining({
            category: "unsupported",
            field: "spec.sandboxes[].agents[0].dashboard",
          }),
        ]),
      },
    });
    expect(exported.writeStdout).not.toHaveBeenCalled();
    expect(exported.publish).not.toHaveBeenCalled();
  });

  it.each([
    [19000, "0.0.0.0", { port: 19000, bind: "0.0.0.0" }],
    [19000, "127.0.0.1", { port: 19000 }],
    [18789, "0.0.0.0", { bind: "0.0.0.0" }],
  ] as const)(
    "exports prepared dashboard port %s and bind %s (#10904)",
    async (port, bind, dashboard) => {
      const observed = dashboardSnapshot(port, bind);
      const outcome = await exportDashboardSnapshots([observed]);
      expect(outcome.result).toEqual({ ok: true, completion: { kind: "stdout" } });
      const raw = outcome.writeStdout.mock.calls[0]![0];
      const document = validateNemoClawConfig(YAML.parse(raw));
      expect(document.spec.sandboxes[0]!.agents[0]).toMatchObject({
        type: "openclaw",
        interfaces: { dashboard },
      });
      expect(raw).not.toContain("deviceAuth");
      expect(raw).not.toContain("http://127.0.0.1");
      expect(outcome.read).toHaveBeenCalledTimes(2);
      expect(outcome.publish).not.toHaveBeenCalled();
    },
  );

  it("exports prepared dashboard settings alongside a managed proxy (#10904)", async () => {
    const observed = dashboardSnapshot(19000, "0.0.0.0", {
      NEMOCLAW_PROXY_HOST: "proxy.internal",
      NEMOCLAW_PROXY_PORT: "3129",
    });
    const exported = await exportDashboardSnapshots([observed]);
    expect(exported.result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]).toMatchObject({
      type: "openclaw",
      interfaces: { dashboard: { port: 19000, bind: "0.0.0.0" } },
    });
    expect(document.spec.sandboxes[0]!.network.proxy).toEqual({
      host: "proxy.internal",
      port: 3129,
    });
  });

  it("keeps explicit and legacy canonical dashboard exports identical (#10904)", async () => {
    const legacy = await exportDashboardSnapshots([snapshot()]);
    const explicit = await exportDashboardSnapshots([dashboardSnapshot(18789, "127.0.0.1")]);
    expect(explicit.result).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(explicit.writeStdout.mock.calls).toEqual(legacy.writeStdout.mock.calls);
    expect(explicit.writeStdout.mock.calls[0]![0]).not.toContain("interfaces:");
  });

  it("preserves inference and execution tuning alongside dashboard settings (#10904)", async () => {
    const observed = dashboardSnapshot(19000, "0.0.0.0", {
      NEMOCLAW_CONTEXT_WINDOW: "65536",
      NEMOCLAW_MAX_TOKENS: "8192",
      NEMOCLAW_AGENT_TIMEOUT: "900",
      NEMOCLAW_AGENT_HEARTBEAT_EVERY: "30m",
    });
    const exported = await exportDashboardSnapshots([observed]);
    expect(exported.result).toEqual({ ok: true, completion: { kind: "stdout" } });
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]).toMatchObject({
      interfaces: { dashboard: { port: 19000, bind: "0.0.0.0" } },
      execution: { timeoutSeconds: 900, heartbeatEvery: "30m" },
      inference: { routes: [{ overrides: { contextWindow: 65536, maxTokens: 8192 } }] },
    });
  });

  it.each([
    ["missing port", { dashboardPort: undefined }],
    ["null port", { dashboardPort: null }],
    ["different port", { dashboardPort: 19001 }],
    ["missing preparation", { dashboardRemoteBindPrepared: undefined }],
    ["unprepared bind", { dashboardRemoteBindPrepared: false }],
  ] as const)("rejects %s without output (#10904)", async (_label, registry) => {
    const observed = dashboardSnapshot();
    const outcome = await exportDashboardSnapshots([
      { ...observed, registry: { ...observed.registry, ...registry } },
    ]);
    expect(outcome.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(outcome.writeStdout).not.toHaveBeenCalled();
    expect(outcome.publish).not.toHaveBeenCalled();
  });

  it.each([
    { dashboardPort: "19000" },
    { dashboardPort: 19000.5 },
    { dashboardRemoteBindPrepared: "true" },
    { dashboardRemoteBindPrepared: null },
  ])("rejects malformed registry dashboard evidence %j (#10904)", async (invalid) => {
    const observed = dashboardSnapshot();
    const changed = { ...observed, registry: { ...observed.registry } };
    Object.assign(changed.registry, invalid);
    const outcome = await exportDashboardSnapshots([changed]);
    expect(outcome.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(outcome.writeStdout).not.toHaveBeenCalled();
    expect(outcome.publish).not.toHaveBeenCalled();
  });

  it("rejects stale preparation for a loopback dashboard (#10904)", async () => {
    const observed = dashboardSnapshot(19000, "127.0.0.1");
    const outcome = await exportDashboardSnapshots([
      { ...observed, registry: { ...observed.registry, dashboardRemoteBindPrepared: true } },
    ]);
    expect(outcome.result).toMatchObject({
      ok: false,
      failure: {
        findings: expect.arrayContaining([expect.objectContaining({ category: "drifted" })]),
      },
    });
    expect(outcome.writeStdout).not.toHaveBeenCalled();
    expect(outcome.publish).not.toHaveBeenCalled();
  });

  it.each([
    [
      "custom URL",
      (p: Record<string, Record<string, unknown>>) => {
        p.dashboard!.url = "https://dashboard.example.com:19000";
      },
    ],
    [
      "URL credential",
      (p: Record<string, Record<string, unknown>>) => {
        p.dashboard!.url = "https://user:dashboard-secret-canary@dashboard.example.com:19000";
      },
    ],
    [
      "URL path",
      (p: Record<string, Record<string, unknown>>) => {
        p.dashboard!.url = "http://127.0.0.1:19000/custom";
      },
    ],
    [
      "WSL exposure",
      (p: Record<string, Record<string, unknown>>) => {
        p.dashboard!.wslExposure = true;
      },
    ],
    [
      "malformed port",
      (p: Record<string, Record<string, unknown>>) => {
        p.dashboard!.port = "dashboard-secret-canary";
      },
    ],
    [
      "device auth change",
      (p: Record<string, Record<string, unknown>>) => {
        p.agentConfig!.deviceAuth = { disabled: true, optOutSource: "operator" };
      },
    ],
    [
      "unrepresented setting",
      (p: Record<string, Record<string, unknown>>) => {
        p.agentConfig!.minimalBootstrap = true;
      },
    ],
  ] as const)(
    "rejects retained %s without output or private values (#10904)",
    async (label, change) => {
      const outcome = await exportDashboardSnapshots([
        changeDashboardProfile(dashboardSnapshot(), change),
      ]);
      const category = ["malformed port", "URL credential"].includes(label)
        ? "missing-provenance"
        : "unsupported";
      expect(outcome.result).toMatchObject({
        ok: false,
        failure: {
          kind: "observation",
          findings: expect.arrayContaining([expect.objectContaining({ category })]),
        },
      });
      expect(JSON.stringify(outcome.result)).not.toContain("dashboard-secret-canary");
      expect(outcome.writeStdout).not.toHaveBeenCalled();
      expect(outcome.publish).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid retained dashboard receipt hash (#10904)", async () => {
    const observed = dashboardSnapshot();
    const workload = observed.registry.workload as Extract<
      SandboxWorkloadReceipt,
      { kind: "managed-image" }
    >;
    expect(workload?.kind).toBe("managed-image");
    const outcome = await exportDashboardSnapshots([
      {
        ...observed,
        registry: {
          ...observed.registry,
          workload: { ...workload, startupProfileSha256: "f".repeat(64) },
        },
      },
    ]);
    expect(outcome.result).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(outcome.writeStdout).not.toHaveBeenCalled();
    expect(outcome.publish).not.toHaveBeenCalled();
  });

  it("rejects dashboard changes across both observation pairs (#10904)", async () => {
    const outcome = await exportDashboardSnapshots([dashboardSnapshot(), dashboardSnapshot(19001)]);
    expect(outcome.result).toMatchObject({
      ok: false,
      failure: {
        attempts: 2,
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(outcome.read).toHaveBeenCalledTimes(4);
    expect(outcome.writeStdout).not.toHaveBeenCalled();
    expect(outcome.publish).not.toHaveBeenCalled();
  });
});
