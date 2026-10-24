// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as endpointSecurity from "../security/trusted-private-endpoint";
import fs from "node:fs";
import YAML from "yaml";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { nativeLocalIdentity } from "../inference/native-local/contract";
import { customNativeProvider } from "../inference/native-provider/custom";
import { HOSTED_NATIVE_PROVIDERS, hostedNativeProvider } from "../inference/native-provider/hosted";
import type { NativeProviderAttachment } from "../inference/native-provider/contract";
import { fixedNativeProvider } from "../inference/native-provider/fixed";
import { normalizeNativeNvidiaProviderAttachment } from "../inference/native-nvidia";
import type { SandboxEntry } from "../state/registry";
import { runInferenceSet } from "./inference-set";
import { prepareRebuildResumeConfig } from "./sandbox/rebuild-resume-config";
import {
  createDeps,
  HERMES_TARGET,
  OPENCLAW_TARGET,
  nativeLocalTestReceipt,
} from "../../../test/helpers/inference-set";

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
    authorities.set(`${gateway}/${receipt.custom ? receipt.providerName : provider}`, receipt);
  };
  return { deps, calls, attached, authorities, entry, existing };
}

it("rejects Pi runtime switching before changing its native attachment (#12589)", async () => {
  const { deps, calls, entry, attached } = fixture();
  entry.agent = "pi";
  entry.provider = "openai-api";
  const definition = hostedNativeProvider("openai-api")!;
  entry.nativeHostedProviderAttachment = {
    schemaVersion: 1,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: "owned-provider-id",
  };
  attached.get("alpha")!.add(definition.providerName);
  const previous = structuredClone(entry);
  await expect(
    runInferenceSet({ provider: "openrouter-api", model: "replacement-model" }, deps),
  ).rejects.toThrow("inference set supports OpenClaw and Hermes");
  expect(entry).toEqual(previous);
  expect([...attached.get("alpha")!]).toEqual([definition.providerName]);
  expect(calls.attachProvider).not.toHaveBeenCalled();
  expect(calls.detachProvider).not.toHaveBeenCalled();
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
});

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

  it("points a registry-only receipt with a missing provider at destroy", async () => {
    const { deps, calls, authorities } = fixture();
    await runInferenceSet({ provider: definition.logicalProvider, model: "first-model" }, deps);
    authorities.clear();
    calls.getProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "not found" },
    });
    await expect(
      runInferenceSet({ provider: definition.logicalProvider, model: "second-model" }, deps),
    ).rejects.toThrow(
      /only the NemoClaw registry record for sandbox 'alpha'.*'nemoclaw alpha destroy'/su,
    );
    expect(calls.createProvider).toHaveBeenCalledTimes(1);
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

describe.each([OPENCLAW_TARGET, HERMES_TARGET])(
  "recorded Hermes endpoint for $agentName",
  (target) => {
    it.each([
      "http://custom.example/team/v1",
      "https://8.8.8.8/team/v1",
      "http://host.openshell.internal:42103/team/v1",
    ])(
      "migrates %s to an attached provider and preserves it across model changes and rebuild",
      async (endpointUrl) => {
        const validateEndpoint = endpointSecurity.assertEndpointResolvesPublic;
        vi.spyOn(endpointSecurity, "assertEndpointResolvesPublic").mockImplementation((url) =>
          validateEndpoint(url, async () => [{ address: "8.8.8.8", family: 4 }]),
        );
        const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
        const { deps, calls, entry, attached } = fixture([definition]);
        entry.provider = "hermes-provider";
        entry.agent = target.agentName;
        entry.endpointUrl = endpointUrl;
        entry.credentialEnv = "OPENAI_API_KEY";
        entry.preferredInferenceApi = "openai-completions";
        deps.resolveAgentConfig = () => target;
        const imported: unknown[] = [];
        calls.importProviderProfile.mockImplementation(({ profilePath }) => {
          imported.push(YAML.parse(fs.readFileSync(profilePath, "utf8")));
          return { ok: true };
        });
        await runInferenceSet({ provider: "hermes-provider", model: "new-model" }, deps);
        expect(entry.nativeHostedProviderAttachment).toMatchObject({
          endpointUrl,
          providerName: definition.providerName,
        });
        expect([...attached.get("alpha")!]).toEqual([definition.providerName]);
        expect(imported[0]).toMatchObject({
          endpoints: [
            {
              host: new URL(endpointUrl).hostname,
              rules: [
                { allow: { method: "GET", path: "/team/v1/models" } },
                { allow: { method: "POST", path: "/team/v1/chat/completions" } },
              ],
            },
          ],
        });
        expect(calls.createProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            credentials: [{ name: "OPENAI_API_KEY", value: "canary-host-secret" }],
          }),
        );
        const configWrites =
          target.agentName === "hermes"
            ? deps.calls.writeSandboxConfig.mock.calls
            : deps.calls.setOpenClawConfigValues.mock.calls;
        expect(JSON.stringify(configWrites)).toContain(endpointUrl);
        expect(JSON.stringify(configWrites)).toContain(
          target.agentName === "hermes"
            ? "${OPENAI_API_KEY}"
            : "openshell:resolve:env:OPENAI_API_KEY",
        );
        expect(JSON.stringify(configWrites)).not.toContain("canary-host-secret");
        expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
        deps.resolveCredentialValue = vi.fn(() => "");
        await runInferenceSet({ provider: "hermes-provider", model: "second-model" }, deps);
        expect(deps.resolveCredentialValue).not.toHaveBeenCalled();
        expect(calls.updateProvider).not.toHaveBeenCalled();
        expect(
          prepareRebuildResumeConfig("alpha", entry, target.agentName, vi.fn(), (message) => {
            throw new Error(message);
          }),
        ).toMatchObject({
          endpointUrl,
          nativeHostedProviderAttachment: entry.nativeHostedProviderAttachment,
        });
      },
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

describe("custom native inference selection", () => {
  it("rejects an unverified Anthropic bridge before replacing native local inference", async () => {
    const binding = { ...nativeLocalTestReceipt(), agent: "hermes" as const };
    const local = {
      ...binding,
      ...nativeLocalIdentity(binding),
      providerId: `id-${nativeLocalIdentity(binding).providerName}`,
    };
    const bridge = customNativeProvider({
      provider: "compatible-anthropic-endpoint",
      api: "openai-completions",
      endpointUrl: "http://host.openshell.internal:49152",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      allowedIps: [],
    });
    const { deps, entry, calls, attached, existing } = fixture([
      bridge,
      {
        ...local,
        logicalProvider: local.provider,
        endpoint: local.endpointUrl,
        api: "openai-completions",
        label: "local",
      },
    ]);
    Object.assign(entry, {
      agent: "hermes",
      provider: local.provider,
      endpointUrl: local.endpointUrl,
      nativeLocalProviderAttachment: local,
    });
    deps.resolveAgentConfig = () => HERMES_TARGET;
    deps.providerAdapter.inspectProviderProfile = async () => ({
      ok: true,
      value: { credentialKeys: [local.credentialEnv] },
    });
    attached.get("alpha")!.add(local.providerName);
    existing.add(local.providerName);
    const before = structuredClone(entry);
    await expect(
      runInferenceSet(
        {
          provider: bridge.logicalProvider,
          model: "mock-anthropic-model",
          endpointUrl: bridge.custom.endpointUrl,
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow("cannot use an unverified OpenShell host bridge endpoint");
    expect(entry).toEqual(before);
    expect([...attached.get("alpha")!]).toEqual([local.providerName]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expect(calls.importProviderProfile).not.toHaveBeenCalled();
    expect(calls.createProvider).not.toHaveBeenCalled();
  });
  const custom = customNativeProvider({
    provider: "compatible-endpoint",
    api: "openai-completions",
    endpointUrl: "https://8.8.8.8/team/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    allowedIps: ["8.8.8.8"],
  });
  const replacement = customNativeProvider({
    ...custom.custom,
    endpointUrl: "https://1.1.1.1/team/v1",
    allowedIps: ["1.1.1.1"],
  });
  it("switches a native sandbox, reuses its key for model changes and preserves rebuild authority", async () => {
    const { deps, calls, entry, attached } = fixture([custom, replacement]);
    await runInferenceSet({ provider: "openai-api", model: "first-model" }, deps);
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "custom-model",
        endpointUrl: custom.endpoint,
        inferenceApi: custom.api,
      },
      deps,
    );
    expect(entry.endpointUrl).toBe(custom.endpoint);
    expect(entry.nativeHostedProviderAttachment?.custom).toEqual(custom.custom);
    expect([...attached.get("alpha")!]).toEqual([custom.providerName]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
    deps.resolveCredentialValue = () => "";
    await runInferenceSet({ provider: "compatible-endpoint", model: "second-model" }, deps);
    expect(calls.updateProvider).not.toHaveBeenCalled();
    expect(entry.model).toBe("second-model");
    expect(JSON.stringify(deps.calls.setOpenClawConfigValues.mock.calls)).toContain(
      custom.endpoint,
    );
    const previous = structuredClone(entry);
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "third-model",
          endpointUrl: replacement.endpoint,
          inferenceApi: replacement.api,
        },
        deps,
      ),
    ).rejects.toThrow("A new credential is required");
    expect(entry).toEqual(previous);
    expect([...attached.get("alpha")!]).toEqual([custom.providerName]);
    expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
  });
  it("waits for a replacement endpoint credential with unchanged provider and model (#12603)", async () => {
    const { deps, entry } = fixture([custom, replacement]);
    await runInferenceSet({ provider: "openai-api", model: "first-model" }, deps);
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "custom-model",
        endpointUrl: custom.endpoint,
        inferenceApi: custom.api,
      },
      deps,
    );
    let elapsed = 0;
    deps.sleep = async (milliseconds) => {
      elapsed += milliseconds;
    };
    deps.calls.probeSandboxRoute.mockImplementation(async () =>
      elapsed >= 10_000
        ? { ok: true }
        : { ok: false, detail: "native credential handle pending", httpStatus: null },
    );
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "custom-model",
        endpointUrl: replacement.endpoint,
        inferenceApi: replacement.api,
      },
      deps,
    );
    expect(entry.nativeHostedProviderAttachment?.custom).toEqual(replacement.custom);
  });
  it("restores the prior attachment if a changed custom endpoint fails sandbox verification", async () => {
    const { deps, calls, entry, attached, authorities } = fixture([custom, replacement]);
    await runInferenceSet({ provider: "openai-api", model: "first-model" }, deps);
    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "custom-model",
        endpointUrl: custom.endpoint,
        inferenceApi: custom.api,
      },
      deps,
    );
    const previous = structuredClone(entry);
    const attach = calls.attachProvider.getMockImplementation()!;
    calls.attachProvider.mockImplementation(async (request) => {
      const conflicting =
        request.providerName === custom.providerName
          ? replacement.providerName
          : custom.providerName;
      expect(attached.get(request.sandboxName)).not.toContain(conflicting);
      return attach(request);
    });
    deps.calls.probeSandboxRoute.mockResolvedValue({
      ok: false,
      detail: "endpoint refused",
      httpStatus: 401,
    });
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "third-model",
          endpointUrl: replacement.endpoint,
          inferenceApi: replacement.api,
        },
        deps,
      ),
    ).rejects.toThrow();
    expect(entry).toEqual(previous);
    expect([...attached.get("alpha")!]).toEqual([custom.providerName]);
    expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
    expect(authorities.get(`nemoclaw/${replacement.providerName}`)?.providerId).toBe(
      `id-${replacement.providerName}`,
    );
  });
});

it("restores the prior attachment when a retained Hermes endpoint fails sandbox verification", async () => {
  const endpointUrl = "http://host.openshell.internal:42103/team/v1";
  const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
  const { deps, calls, entry, attached } = fixture([definition]);
  entry.agent = "hermes";
  deps.resolveAgentConfig = () => HERMES_TARGET;
  await runInferenceSet({ provider: "openai-api", model: "previous-model" }, deps);
  const previous = structuredClone(entry);
  deps.loadSession = () =>
    ({
      sandboxName: "alpha",
      provider: "hermes-provider",
      model: "retained-model",
      endpointUrl,
      credentialEnv: "NOUS_API_KEY",
      preferredInferenceApi: "openai-completions",
    }) as never;
  deps.calls.probeSandboxRoute.mockResolvedValue({
    ok: false,
    detail: "retained endpoint refused",
    httpStatus: 401,
  });
  await expect(
    runInferenceSet({ provider: "hermes-provider", model: "retained-model" }, deps),
  ).rejects.toThrow("retained endpoint refused");
  expect(entry).toEqual(previous);
  expect([...attached.get("alpha")!]).toEqual([
    previous.nativeHostedProviderAttachment!.providerName,
  ]);
  expect(calls.detachProvider).toHaveBeenCalledWith(
    expect.objectContaining({ providerName: definition.providerName }),
  );
  expect([...attached.get("beta")!]).toEqual(["unrelated-provider"]);
  expect(deps.inferenceRouteObserver.observeInferenceRoute).not.toHaveBeenCalled();
});

it.each([
  { endpointUrl: "http://host.openshell.internal:42104/team/v1" },
  { preferredInferenceApi: "openai-responses" },
])("rejects changed recorded Hermes authority %j before provider writes", async (change) => {
  const endpointUrl = "http://host.openshell.internal:42103/team/v1";
  const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
  const { deps, calls, entry } = fixture([definition]);
  entry.provider = "hermes-provider";
  entry.endpointUrl = endpointUrl;
  entry.credentialEnv = "OPENAI_API_KEY";
  entry.preferredInferenceApi = "openai-completions";
  await runInferenceSet({ provider: "hermes-provider", model: "first-model" }, deps);
  Object.assign(entry, change);
  calls.createProvider.mockClear();
  calls.attachProvider.mockClear();
  await expect(
    runInferenceSet({ provider: "hermes-provider", model: "second-model" }, deps),
  ).rejects.toThrow("Recorded Hermes selection does not match its endpoint or API authority");
  expect(calls.createProvider).not.toHaveBeenCalled();
  expect(calls.attachProvider).not.toHaveBeenCalled();
});
