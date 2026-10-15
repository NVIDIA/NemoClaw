// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { nativeLocalIdentity } from "../inference/native-local/contract";
import type { ConfigObject } from "../security/credential-filter";
import { createDeps } from "../../../test/helpers/inference-set";
import { runInferenceSet } from "./inference-set";

vi.mock("../adapters/openshell/provider-policy", () => ({
  requireNativeProviderPolicy: vi.fn(async () => {}),
}));

const binding = {
  agent: "openclaw" as const,
  provider: "ollama-local" as const,
  endpointUrl: "http://host.openshell.internal:11435/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "sentinel" as const,
  gatewayName: "nemoclaw",
  sandboxName: "alpha",
};
const attachment = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned-local-provider",
};

function fixture() {
  const config: ConfigObject = {
    agents: { defaults: { model: { primary: "inference/old-model" } } },
    models: {
      providers: {
        inference: {
          baseUrl: binding.endpointUrl,
          apiKey: "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
          api: "openai-completions",
          models: [{ id: "old-model" }],
        },
      },
    },
  };
  return createDeps({
    config,
    entry: {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      provider: binding.provider,
      model: "old-model",
      endpointUrl: binding.endpointUrl,
      preferredInferenceApi: "openai-completions",
      nativeLocalProviderAttachment: attachment,
    },
  });
}

describe("OpenClaw native local live selection", () => {
  it("detaches and retires local authority before publishing a shared selection", async () => {
    const deps = fixture();
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    const deletion = vi.spyOn(deps.providerAdapter, "deleteProvider");
    await runInferenceSet(
      {
        provider: "nvidia-router",
        model: "routed-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: attachment.providerName,
      }),
    );
    expect(deletion).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-router",
        nativeLocalProviderAttachment: undefined,
      }),
    );
    expect(deps.calls.clearNativeLocalProviderAuthority).toHaveBeenCalledWith(attachment);
  });

  it("changes the selected model without touching the shared gateway route", async () => {
    const deps = fixture();
    const result = await runInferenceSet(
      {
        provider: "ollama-local",
        model: "new-model",
        sandboxName: "alpha",
      },
      deps,
    );
    expect(result.provider).toBe("ollama-local");
    expect(deps.calls.probeSandboxRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeProvider: true,
        nativeLocalProviderAttachment: attachment,
        agentName: "openclaw",
        model: "new-model",
      }),
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        model: "new-model",
        nativeLocalProviderAttachment: attachment,
      }),
    );
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalled();
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });
});
