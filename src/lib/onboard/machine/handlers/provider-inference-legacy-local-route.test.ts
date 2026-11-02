// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { getInstalledOpenshellVersion } from "../../openshell-version";

// The reservation helper must not inspect the operator's real registry.
vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandbox: vi.fn(() => null),
}));

import { cliOpenShellInstalledVersionObserver } from "../../../adapters/openshell/installed-version-cli";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function retainedPublicCustomResume(provider: string, version: string | null) {
  vi.spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion").mockReturnValue(
    version === null
      ? { ok: false, error: { kind: "unavailable", message: "unavailable" } }
      : { ok: true, version },
  );
  const session = createSession({
    agent: "openclaw",
    sandboxName: "my-assistant",
    provider,
    model: "served-model",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
  session.steps.provider_selection.status = "complete";
  const recorded = {
    name: "my-assistant",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    createdAt: "2026-09-01T00:00:00Z",
    provider: session.provider,
    model: session.model,
    endpointUrl: session.endpointUrl,
    credentialEnv: session.credentialEnv,
    preferredInferenceApi: session.preferredInferenceApi,
  } as SandboxEntry;
  const before = structuredClone({ session, recorded });
  const { deps, calls } = createDeps({
    getSandboxRegistryEntry: () => recorded,
    getInstalledOpenshellVersion,
    hydrateCredentialEnv: vi.fn(() => "host-key"),
    isInferenceRouteReady: vi.fn(() => true),
  });
  calls.complete.mockResolvedValue(session);
  const result = handleProviderInferenceState({
    ...baseOptions(deps, session),
    resume: true,
    agent: { name: "openclaw" },
    sandboxName: "my-assistant",
    selectedMessagingChannels: ["telegram"],
  });
  return { result, calls, session, recorded, before };
}

describe("legacy shared inference resume", () => {
  it.each([
    { provider: "compatible-endpoint", version: "0.1.3" },
    { provider: "compatible-anthropic-endpoint", version: "0.1.3" },
    { provider: "compatible-endpoint", version: null },
  ])(
    "refuses retained public $provider resume before setup on OpenShell $version",
    async ({ provider, version }) => {
      const { result, calls, session, recorded, before } = retainedPublicCustomResume(
        provider,
        version,
      );
      await expect(result).rejects.toThrow(/Back up|back up/);
      expect(calls.setupInference).not.toHaveBeenCalled();
      expect(calls.startStep).not.toHaveBeenCalled();
      expect(calls.updateSandbox).not.toHaveBeenCalled();
      expect(calls.reserveRoute).not.toHaveBeenCalled();
      expect({ session, recorded }).toEqual(before);
    },
  );

  it("resumes a retained public compatible route on verified OpenShell 0.0.x", async () => {
    const { result, calls } = retainedPublicCustomResume("compatible-endpoint", "0.0.116");
    await expect(result).resolves.toBeDefined();
    expect(calls.setupInference).toHaveBeenCalled();
  });

  it("keeps a fresh Pi local selection on the native provider path", async () => {
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        model: "qwen3:8b",
        provider: "ollama-local",
        endpointUrl: "http://host.openshell.internal:11435/v1",
        credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      })),
    });
    await handleProviderInferenceState({
      ...baseOptions(deps, null),
      agent: { name: "pi" },
      sandboxName: "my-assistant",
    });
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "qwen3:8b",
      "ollama-local",
      "http://host.openshell.internal:11435/v1",
      "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      null,
      [],
      expect.not.objectContaining({ preserveLegacyPiSharedLocalRoute: true }),
    );
    expect(calls.preflightGatewayRouteDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ nativeLocalSelection: true }),
    );
  });

  it.each([
    { provider: "ollama-local", endpointUrl: "http://host.openshell.internal:11435/v1" },
    { provider: "compatible-endpoint", endpointUrl: "http://host.openshell.internal:12345/v1" },
  ])(
    "resumes an unchanged published Pi $provider selection through its shared route",
    async (selection) => {
      vi.spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion").mockReturnValue({
        ok: true,
        version: "0.0.116",
      });
      const session = createSession({
        agent: "pi",
        sandboxName: "my-assistant",
        ...selection,
        model: "qwen3:8b",
        credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
        preferredInferenceApi: "openai-completions",
      });
      session.steps.provider_selection.status = "complete";
      const recorded = {
        name: "my-assistant",
        agent: "pi",
        gatewayName: "nemoclaw",
        createdAt: "2026-09-01T00:00:00Z",
        provider: session.provider,
        model: session.model,
        endpointUrl: session.endpointUrl,
        credentialEnv: session.credentialEnv,
        preferredInferenceApi: session.preferredInferenceApi,
      } as SandboxEntry;
      const { deps, calls } = createDeps({
        getSandboxRegistryEntry: () => recorded,
        getInstalledOpenshellVersion,
      });

      await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        agent: { name: "pi" },
        sandboxName: "my-assistant",
      });

      expect(calls.setupNim).not.toHaveBeenCalled();
      expect(calls.setupInference).toHaveBeenCalledWith(
        "my-assistant",
        "qwen3:8b",
        selection.provider,
        session.endpointUrl,
        session.credentialEnv,
        null,
        [],
        expect.objectContaining({ preserveLegacyPiSharedLocalRoute: true }),
      );
      expect(calls.preflightGatewayRouteDiscovery).not.toHaveBeenCalledWith(
        expect.objectContaining({ nativeLocalSelection: true }),
      );
    },
  );
});

it("blocks resume of a legacy OpenClaw compatible route before inference setup", async () => {
  const session = createSession({
    agent: "openclaw",
    sandboxName: "my-assistant",
    provider: "compatible-endpoint",
    model: "served-model",
    endpointUrl: "http://127.0.0.1:8000/v1",
    credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    preferredInferenceApi: "openai-completions",
  });
  session.steps.provider_selection.status = "complete";
  const recorded = {
    name: "my-assistant",
    agent: "openclaw",
    gatewayName: "nemoclaw",
    createdAt: "2026-09-01T00:00:00Z",
    provider: session.provider,
    model: session.model,
    endpointUrl: session.endpointUrl,
    credentialEnv: session.credentialEnv,
    preferredInferenceApi: session.preferredInferenceApi,
  } as SandboxEntry;
  const { deps, calls } = createDeps({
    getSandboxRegistryEntry: () => recorded,
    getInstalledOpenshellVersion,
  });
  await expect(
    handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      agent: { name: "openclaw" },
      sandboxName: "my-assistant",
    }),
  ).rejects.toThrow(/Back up|back up/);
  expect(calls.setupInference).not.toHaveBeenCalled();
});

it.each([
  { label: "0.1.3", observation: { ok: true, version: "0.1.3" } },
  { label: "0.1.0", observation: { ok: true, version: "0.1.0" } },
  {
    label: "unknown",
    observation: { ok: false, error: { kind: "unavailable", message: "unavailable" } },
  },
] as const)(
  "refuses retained Pi shared inference before mutation on OpenShell $label",
  async ({ observation }) => {
    vi.spyOn(cliOpenShellInstalledVersionObserver, "observeInstalledVersion").mockReturnValue(
      observation,
    );
    const session = createSession({
      agent: "pi",
      sandboxName: "my-assistant",
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
    });
    session.steps.provider_selection.status = "complete";
    const recorded = {
      name: "my-assistant",
      agent: "pi",
      gatewayName: "nemoclaw",
      createdAt: "2026-09-01T00:00:00Z",
      provider: session.provider,
      model: session.model,
      endpointUrl: session.endpointUrl,
      credentialEnv: session.credentialEnv,
    } as SandboxEntry;
    const before = structuredClone({ session, recorded });
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: () => recorded,
      getInstalledOpenshellVersion,
    });
    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        agent: { name: "pi" },
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("Back up");
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
    expect(calls.startStep).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect({ session, recorded }).toEqual(before);
  },
);
