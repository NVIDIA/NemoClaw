// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

// The reservation helper must not inspect the operator's real registry.
vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandbox: vi.fn(() => null),
}));

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("legacy local inference resume", () => {
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

  it("resumes an unchanged published Pi local selection through its shared route", async () => {
    const session = createSession({
      agent: "pi",
      sandboxName: "my-assistant",
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
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
    const { deps, calls } = createDeps({ getSandboxRegistryEntry: () => recorded });

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
      "ollama-local",
      session.endpointUrl,
      session.credentialEnv,
      null,
      [],
      expect.objectContaining({ preserveLegacyPiSharedLocalRoute: true }),
    );
    expect(calls.preflightGatewayRouteDiscovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ nativeLocalSelection: true }),
    );
  });
});
