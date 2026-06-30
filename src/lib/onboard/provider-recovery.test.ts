// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as onboardSession from "../state/onboard-session";
import * as registry from "../state/registry";
import { createProviderRecoveryHelpers, validateLiveGatewayInference } from "./provider-recovery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateLiveGatewayInference", () => {
  it("accepts a complete bounded provider/model pair", () => {
    expect(
      validateLiveGatewayInference({
        provider: " compatible-endpoint ",
        model: " nvidia/nemotron-3-ultra ",
      }),
    ).toEqual({ provider: "compatible-endpoint", model: "nvidia/nemotron-3-ultra" });
  });

  it.each([
    ["missing provider", { provider: null, model: "model" }],
    ["missing model", { provider: "nvidia-prod", model: null }],
    ["unsafe provider", { provider: "nvidia-prod\nModel: attacker", model: "model" }],
    ["oversized provider", { provider: `p${"x".repeat(128)}`, model: "model" }],
    ["unsafe model", { provider: "nvidia-prod", model: "model;touch /tmp/pwned" }],
    ["oversized model", { provider: "nvidia-prod", model: `m${"x".repeat(512)}` }],
  ])("rejects %s", (_label, inference) => {
    expect(validateLiveGatewayInference(inference)).toBeNull();
  });
});

describe("provider recovery persisted routing state", () => {
  function helpers() {
    return createProviderRecoveryHelpers({
      parseGatewayInference: () => ({ provider: "nvidia-prod", model: null }),
      runCaptureOpenshell: () => "Gateway inference:",
    });
  }

  it("rejects partial live gateway output", () => {
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    });

    expect(helpers().readLiveInference("alpha")).toBeNull();
  });

  it("prefers the selected sandbox registry endpoint over session state", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      endpointUrl: "https://registry.example/v1",
    });
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        endpointUrl: "https://session.example/v1",
      }),
    );

    expect(helpers().readRecordedEndpointUrl("alpha")).toBe("https://registry.example/v1");
  });

  it("reads a complete route atomically from registry or a matching session", () => {
    vi.spyOn(registry, "getSandbox")
      .mockReturnValueOnce({
        name: "alpha",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: " https://registry.example/v1 ",
        preferredInferenceApi: "openai-completions",
      })
      .mockReturnValueOnce(null);
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "model-b",
        endpointUrl: "https://session.example/v1",
        preferredInferenceApi: "openai-responses",
      }),
    );
    const recovery = helpers();

    expect(recovery.readRecordedInferenceRoute("alpha")).toEqual({
      provider: "compatible-endpoint",
      model: "model-a",
      endpointUrl: "https://registry.example/v1",
      preferredInferenceApi: "openai-completions",
      source: "registry",
    });
    expect(recovery.readRecordedInferenceRoute("alpha")).toEqual({
      provider: "compatible-endpoint",
      model: "model-b",
      endpointUrl: "https://session.example/v1",
      preferredInferenceApi: "openai-responses",
      source: "session",
    });
  });

  it("rejects a partial current registry route instead of mixing in stale session fields", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      provider: "compatible-endpoint",
      model: "current-model",
      endpointUrl: "https://current.example/v1",
      preferredInferenceApi: null,
    });
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(
      onboardSession.createSession({
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "stale-model",
        endpointUrl: "https://stale.example/v1",
        preferredInferenceApi: "openai-completions",
      }),
    );

    expect(helpers().readRecordedInferenceRoute("alpha")).toBeNull();
  });

  it("reports every other recorded endpoint for the same global provider", () => {
    vi.spyOn(registry, "listSandboxes").mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [
        { name: "alpha", provider: "compatible-endpoint", endpointUrl: "https://a.example/v1" },
        { name: "beta", provider: "compatible-endpoint", endpointUrl: "https://b.example/v1" },
        { name: "gamma", provider: "compatible-endpoint", endpointUrl: null },
        { name: "delta", provider: "openai-api", endpointUrl: "https://api.openai.com/v1" },
      ],
    });

    expect(helpers().readRecordedProviderEndpoints("compatible-endpoint", "alpha")).toEqual([
      "https://b.example/v1",
      "",
    ]);
  });
});
