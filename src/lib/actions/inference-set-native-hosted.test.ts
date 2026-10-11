// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { HOSTED_NATIVE_PROVIDERS, hostedNativeProvider } from "../inference/native-provider/hosted";
import type { NativeProviderAttachment } from "../inference/native-provider/contract";
import { fixedNativeProvider } from "../inference/native-provider/fixed";
import { normalizeNativeNvidiaProviderAttachment } from "../inference/native-nvidia";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import { prepareRebuildResumeConfig } from "./sandbox/rebuild-resume-config";
import { createDeps, HERMES_TARGET, OPENCLAW_TARGET } from "../../../test/helpers/inference-set";

function fixture(extraDefinitions: ReturnType<typeof hostedNativeProvider>[] = []) {
  const definitions = [
    fixedNativeProvider("nvidia-prod")!,
    ...HOSTED_NATIVE_PROVIDERS,
    ...extraDefinitions.filter((item) => item !== undefined),
  ];
  const existing = new Set<string>();
  const attached = new Map<string, Set<string>>([
    ["alpha", new Set()],
    ["beta", new Set(["unrelated-provider"])],
  ]);
  const authorities = new Map<string, NativeProviderAttachment>();
  const calls = {
    importProviderProfile: vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(() => ({
      ok: true,
    })),
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({ ok: true, value: undefined })),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>(async ({ providerName }) => {
      const definition = definitions.find((item) => item.providerName === providerName)!;
      return existing.has(providerName)
        ? {
            ok: true,
            value: {
              name: providerName,
              type: definition.profileId,
              credentialKeys: [definition.credentialEnv],
              configKeys: [],
              revision: { id: `id-${providerName}`, resourceVersion: 1 },
            },
          }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "not found" } };
    }),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async ({ name }) => {
      existing.add(name);
      return { ok: true };
    }),
    updateProvider: vi.fn<OpenShellProviderAdapter["updateProvider"]>(async () => ({ ok: true })),
    attachProvider: vi.fn<OpenShellProviderAdapter["attachProvider"]>(
      async ({ sandboxName, providerName }) => {
        attached.get(sandboxName)!.add(providerName);
        return { ok: true };
      },
    ),
    detachProvider: vi.fn<OpenShellProviderAdapter["detachProvider"]>(
      async ({ sandboxName, providerName }) => ({
        ok: true,
        value: { changed: attached.get(sandboxName)!.delete(providerName) },
      }),
    ),
    listProviderAttachments: vi.fn<OpenShellProviderAdapter["listProviderAttachments"]>(
      async ({ sandboxName }) => ({ ok: true, value: { names: [...attached.get(sandboxName)!] } }),
    ),
  };
  const entry: SandboxEntry = {
    name: "alpha",
    agent: "openclaw",
    provider: "ollama-local",
    model: "previous-model",
    gatewayName: "nemoclaw",
  };
  const deps = createDeps({
    config: {},
    entry,
    providerAdapter: calls as unknown as OpenShellProviderAdapter,
    resolveCredentialValue: () => "canary-host-secret",
    updateSandbox: (_name, updates) => {
      Object.assign(entry, updates);
      return true;
    },
    getNativeNvidiaProviderAuthority: (gateway) =>
      normalizeNativeNvidiaProviderAttachment(authorities.get(`${gateway}/nvidia-prod`)),
    setNativeNvidiaProviderAuthority: (gateway, receipt) => {
      authorities.set(`${gateway}/nvidia-prod`, receipt);
    },
  });
  deps.getNativeHostedProviderAuthority = (gateway, provider) =>
    authorities.get(`${gateway}/${provider}`);
  deps.setNativeHostedProviderAuthority = (gateway, provider, receipt) => {
    authorities.set(`${gateway}/${provider}`, receipt);
  };
  return { deps, calls, attached, authorities, entry };
}

describe.each(HOSTED_NATIVE_PROVIDERS)("inference set native $label", (definition) => {
  it("attaches and probes only the selected sandbox without changing the shared route", async () => {
    const { deps, calls, attached, authorities } = fixture();
    await runInferenceSet({ provider: definition.logicalProvider, model: "fixture-model" }, deps);
    expect(calls.attachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sandboxName: "alpha", providerName: definition.providerName }),
    );
    expect([...attached.get("alpha")!]).toEqual([definition.providerName]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.filter(([args]) => args.includes("inference")),
    ).toEqual([]);
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: definition.logicalProvider,
        nativeProvider: true,
        sandboxName: "alpha",
      }),
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: definition.logicalProvider,
        nativeHostedProviderAttachment: {
          schemaVersion: 1,
          profileId: definition.profileId,
          providerName: definition.providerName,
          providerId: `id-${definition.providerName}`,
        },
      }),
    );
    expect(authorities.get(`nemoclaw/${definition.logicalProvider}`)?.providerId).toBe(
      `id-${definition.providerName}`,
    );
    expect(JSON.stringify(deps.calls.setOpenClawConfigValues.mock.calls)).not.toContain(
      "canary-host-secret",
    );
    expect(JSON.stringify(deps.calls.setOpenClawConfigValues.mock.calls)).toContain(
      definition.endpoint.replace(/\/$/, ""),
    );
    expect(JSON.stringify(deps.calls.setOpenClawConfigValues.mock.calls)).toContain(
      `openshell:resolve:env:${definition.credentialEnv}`,
    );
  });

  it("reuses the existing credential when selecting another model", async () => {
    const { deps, calls } = fixture();
    await runInferenceSet({ provider: definition.logicalProvider, model: "first-model" }, deps);
    deps.resolveCredentialValue = vi.fn(() => "changed-host-key");
    await runInferenceSet({ provider: definition.logicalProvider, model: "second-model" }, deps);
    expect(calls.updateProvider).not.toHaveBeenCalled();
    expect(deps.resolveCredentialValue).not.toHaveBeenCalled();
  });

  it("migrates a legacy selection without changing the gateway route or deleting its provider", async () => {
    const { deps, calls, entry, attached } = fixture();
    entry.provider = definition.logicalProvider;
    entry.model = "previous-model";
    await runInferenceSet({ provider: definition.logicalProvider, model: "fixture-model" }, deps);
    expect(entry.nativeHostedProviderAttachment?.providerName).toBe(definition.providerName);
    expect(calls.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: definition.providerName }),
    );
    expect(calls.detachProvider).not.toHaveBeenCalled();
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.filter(([args]) => args[0] === "inference"),
    ).toEqual([]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
  });

  it("detaches the new provider on failed verification while preserving authority for recovery", async () => {
    const { deps, calls, attached, authorities } = fixture();
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      detail: "rejected",
      httpStatus: 401,
    });
    await expect(
      runInferenceSet({ provider: definition.logicalProvider, model: "fixture-model" }, deps),
    ).rejects.toThrow("Sandbox-side verification rejected");
    expect(calls.detachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sandboxName: "alpha", providerName: definition.providerName }),
    );
    expect(attached.get("alpha")!.size).toBe(0);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(authorities.has(`nemoclaw/${definition.logicalProvider}`)).toBe(true);
  });
});

describe("native provider switching recovery", () => {
  it.each([
    ["nvidia-prod", "openai-api"],
    ["openai-api", "anthropic-prod"],
    ["openrouter-api", "gemini-api"],
  ])("preserves both gateway authorities across %s to %s and back", async (first, second) => {
    const { deps, calls, attached, authorities, entry } = fixture();
    await runInferenceSet({ provider: first, model: "first-model" }, deps);
    const firstReceipt = authorities.get(`nemoclaw/${first}`);
    await runInferenceSet({ provider: second, model: "second-model" }, deps);
    const secondReceipt = authorities.get(`nemoclaw/${second}`);
    expect([...attached.get("alpha")!]).toEqual([fixedNativeProvider(second)!.providerName]);
    await runInferenceSet({ provider: first, model: "another-model" }, deps);
    expect([...attached.get("alpha")!]).toEqual([fixedNativeProvider(first)!.providerName]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
    expect(authorities.get(`nemoclaw/${first}`)).toEqual(firstReceipt);
    expect(authorities.get(`nemoclaw/${second}`)).toEqual(secondReceipt);
    expect(calls.createProvider).toHaveBeenCalledTimes(2);
    expect(calls.detachProvider).toHaveBeenCalledTimes(2);
    expect(entry.provider).toBe(first);
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  });

  it("restores the previous native attachment if registry publication fails", async () => {
    const { deps, calls, attached, entry } = fixture();
    await runInferenceSet({ provider: "openai-api", model: "first-model" }, deps);
    deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet({ provider: "anthropic-prod", model: "second-model" }, deps),
    ).rejects.toThrow("Failed to update NemoClaw registry");
    expect([...attached.get("alpha")!]).toEqual(["nemoclaw-openai-api-v1"]);
    expect(entry.provider).toBe("openai-api");
    expect(calls.attachProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ sandboxName: "alpha", providerName: "nemoclaw-openai-api-v1" }),
    );
  });

  it("does not publish another native selection when removal of previous access fails", async () => {
    const { deps, calls, attached, entry } = fixture();
    await runInferenceSet({ provider: "openai-api", model: "first-model" }, deps);
    deps.calls.updateSandbox.mockClear();
    calls.detachProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "failed", message: "denied" },
    });
    await expect(
      runInferenceSet({ provider: "anthropic-prod", model: "second-model" }, deps),
    ).rejects.toThrow("Could not detach");
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect([...attached.get("alpha")!]).toEqual(["nemoclaw-openai-api-v1"]);
    expect(entry.provider).toBe("openai-api");
  });
});

it("keeps a Hermes sandbox on its recorded endpoint after another sandbox changes the gateway selection", async () => {
  const older = hostedNativeProvider("hermes-provider", "https://older.nous.example/v1")!;
  const newer = hostedNativeProvider("hermes-provider", "https://newer.nous.example/v1")!;
  const { deps, calls, entry, attached } = fixture([older, newer]);
  const receipt = {
    schemaVersion: 1 as const,
    profileId: older.profileId,
    providerName: older.providerName,
    providerId: `id-${older.providerName}`,
    endpointUrl: older.endpoint,
    allowedIps: ["8.8.8.8"],
  };
  entry.provider = "hermes-provider";
  entry.endpointUrl = older.endpoint;
  entry.nativeHostedProviderAttachment = receipt;
  attached.get("alpha")!.add(older.providerName);
  calls.getProvider.mockResolvedValue({
    ok: true,
    value: {
      name: older.providerName,
      type: older.profileId,
      credentialKeys: ["OPENAI_API_KEY"],
      configKeys: [],
      revision: { id: receipt.providerId, resourceVersion: 1 },
    },
  });
  deps.getNativeHostedProviderAuthority = vi.fn((_gateway, _provider, endpoint) =>
    endpoint === older.endpoint
      ? receipt
      : {
          ...receipt,
          profileId: newer.profileId,
          providerName: newer.providerName,
          providerId: "newer-id",
          endpointUrl: newer.endpoint,
        },
  );
  await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
  expect(entry.nativeHostedProviderAttachment).toEqual(receipt);
  expect([...attached.get("alpha")!]).toEqual([older.providerName]);
  expect(calls.createProvider).not.toHaveBeenCalled();
  expect(deps.getNativeHostedProviderAuthority).toHaveBeenCalledWith(
    "nemoclaw",
    "hermes-provider",
    older.endpoint,
  );
});

it.each([OPENCLAW_TARGET, HERMES_TARGET])(
  "preserves a user-supplied Hermes endpoint in $agentName configuration",
  async (target) => {
    const agent = target.agentName;
    const { deps, calls, entry } = fixture();
    entry.provider = "hermes-provider";
    entry.agent = agent;
    deps.resolveAgentConfig = () => target;
    entry.endpointUrl = "https://custom.example/v1";
    entry.credentialEnv = "OPENAI_API_KEY";
    entry.preferredInferenceApi = "openai-completions";
    await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
    expect(calls.attachProvider).not.toHaveBeenCalled();
    expect(calls.createProvider).not.toHaveBeenCalled();
    expect(entry.nativeHostedProviderAttachment).toBeUndefined();
    const configWrites =
      agent === "hermes"
        ? deps.calls.writeSandboxConfig.mock.calls
        : deps.calls.setOpenClawConfigValues.mock.calls;
    expect(JSON.stringify(configWrites)).toContain("https://inference.local/v1");
    expect(JSON.stringify(configWrites)).not.toContain("https://inference-api.nousresearch.com");
    expect(JSON.stringify(configWrites)).not.toContain("openshell:resolve:env:OPENAI_API_KEY");
    expect(deps.inferenceRouteObserver.observeInferenceRoute).toHaveBeenCalled();
    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["inference", "set", "--provider", "hermes-provider"]),
      expect.anything(),
    );
  },
);

describe.each([OPENCLAW_TARGET, HERMES_TARGET])(
  "native Hermes credentials for $agentName",
  (target) => {
    it("preserves the shared credential after a successful model change", async () => {
      const { deps, calls, entry, attached } = fixture();
      entry.agent = target.agentName;
      deps.resolveAgentConfig = () => target;
      await runInferenceSet({ provider: "hermes-provider", model: "previous-model" }, deps);
      const providerName = entry.nativeHostedProviderAttachment!.providerName;
      attached.get("beta")!.add(providerName);
      calls.updateProvider.mockClear();
      const resolve = vi.fn((name: string) =>
        name === "OPENAI_API_KEY" ? "unrelated-openai-key" : "changed-nous-key",
      );
      deps.resolveCredentialValue = resolve;
      await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
      expect(calls.updateProvider).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect([...attached.get("beta")!]).toContain(providerName);
      expect(entry.model).toBe("new-model");
    });

    it("preserves the shared credential after rejected model verification", async () => {
      const { deps, calls, entry, attached } = fixture();
      entry.agent = target.agentName;
      deps.resolveAgentConfig = () => target;
      await runInferenceSet({ provider: "hermes-provider", model: "previous-model" }, deps);
      const providerName = entry.nativeHostedProviderAttachment!.providerName;
      attached.get("beta")!.add(providerName);
      calls.updateProvider.mockClear();
      const resolve = vi.fn((name: string) =>
        name === "OPENAI_API_KEY" ? "unrelated-openai-key" : "changed-nous-key",
      );
      deps.resolveCredentialValue = resolve;
      deps.calls.probeSandboxRoute.mockResolvedValue({
        ok: false,
        detail: "rejected",
        httpStatus: 401,
      });
      await expect(
        runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps),
      ).rejects.toThrow("Sandbox-side verification rejected");
      expect(calls.updateProvider).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect([...attached.get("beta")!]).toContain(providerName);
      expect(entry.model).toBe("previous-model");
    });

    it("publishes the native binding during legacy migration so rebuild can resume", async () => {
      const { deps, calls, entry } = fixture();
      entry.agent = target.agentName;
      deps.resolveAgentConfig = () => target;
      await runInferenceSet({ provider: "hermes-provider", model: "previous-model" }, deps);
      entry.nativeHostedProviderAttachment = undefined;
      entry.credentialEnv = "NOUS_API_KEY";
      deps.resolveCredentialValue = () => "";
      calls.updateProvider.mockClear();
      await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
      expect(calls.updateProvider).not.toHaveBeenCalled();
      const resume = prepareRebuildResumeConfig(
        "alpha",
        entry,
        target.agentName,
        () => {},
        (message) => {
          throw new Error(message);
        },
      );
      expect(entry.credentialEnv).toBe("OPENAI_API_KEY");
      expect(resume).toEqual(
        expect.objectContaining({ credentialEnv: "OPENAI_API_KEY", model: "new-model" }),
      );
    });

    it("does not create a Hermes provider with an unrelated OpenAI key", async () => {
      const { deps, calls, entry } = fixture();
      entry.agent = target.agentName;
      deps.resolveAgentConfig = () => target;
      deps.resolveCredentialValue = (name) =>
        name === "OPENAI_API_KEY" ? "unrelated-openai-key" : "";
      await expect(
        runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps),
      ).rejects.toThrow("host credential is required");
      expect(calls.createProvider).not.toHaveBeenCalled();
      expect(calls.updateProvider).not.toHaveBeenCalled();
    });

    it("uses the Nous host key for a new native Hermes provider", async () => {
      const { deps, calls, entry } = fixture();
      entry.agent = target.agentName;
      deps.resolveAgentConfig = () => target;
      deps.resolveCredentialValue = (name) =>
        name === "NOUS_API_KEY" ? "synthetic-nous-key" : "unrelated-openai-key";
      await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
      expect(calls.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: [{ name: "OPENAI_API_KEY", value: "synthetic-nous-key" }],
        }),
      );
    });
  },
);

describe("Hermes native gateway credential refresh", () => {
  it("does not restart when native route verification fails before the config commit", async () => {
    const { deps, entry } = fixture();
    entry.agent = "hermes";
    deps.resolveAgentConfig = () => HERMES_TARGET;
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      detail: "rejected",
      httpStatus: 401,
    });
    await expect(
      runInferenceSet({ provider: "gemini-api", model: "fixture-model" }, deps),
    ).rejects.toThrow("Sandbox-side verification rejected");
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("restarts the selected gateway after committing a newly attached credential reference", async () => {
    const { deps, entry } = fixture();
    entry.agent = "hermes";
    deps.resolveAgentConfig = () => HERMES_TARGET;
    await runInferenceSet({ provider: "gemini-api", model: "fixture-model" }, deps);
    expect(JSON.stringify(deps.calls.writeSandboxConfig.mock.calls)).toContain("${GEMINI_API_KEY}");
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(deps.calls.writeSandboxConfig.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.restartSandboxGateway.mock.invocationCallOrder[0]!,
    );
    expect(deps.calls.settleOpenClawPairing).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: "failure",
      restart: async () => ({
        ok: false as const,
        failureLayer: "health timeout",
        detail: "synthetic-secret",
      }),
    },
    {
      failure: "exception",
      restart: async () => {
        throw new Error("synthetic-secret");
      },
    },
  ])(
    "preserves the committed route after restart $failure and retries activation",
    async ({ restart }) => {
      const { deps, entry, calls, attached } = fixture();
      entry.agent = "hermes";
      deps.resolveAgentConfig = () => HERMES_TARGET;
      deps.calls.restartSandboxGateway.mockImplementationOnce(restart);
      await expect(
        runInferenceSet({ provider: "gemini-api", model: "fixture-model" }, deps),
      ).rejects.toThrow(
        /managed Hermes gateway restart.*committed route was not rolled back.*alpha gateway restart/,
      );
      expect(entry.provider).toBe("gemini-api");
      expect([...attached.get("alpha")!]).toEqual([
        hostedNativeProvider("gemini-api")!.providerName,
      ]);
      expect(calls.detachProvider).not.toHaveBeenCalled();
      await runInferenceSet({ provider: "gemini-api", model: "fixture-model" }, deps);
      expect(deps.calls.restartSandboxGateway).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(deps.calls.log.mock.calls)).not.toContain("synthetic-secret");
    },
  );
});
