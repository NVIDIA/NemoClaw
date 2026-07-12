// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  ProviderRecoveryReceipt,
  RegistryInferenceRoute,
} from "../../onboard/rebuild-route-handoff";
import { stageRegistryProviderRecoveryReceipt } from "./rebuild-preflight-target-phase";

const target = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "nvidia/model",
};

const registryRoute: RegistryInferenceRoute = {
  provider: target.provider,
  model: target.model,
  endpointUrl: "https://inference.example.test/v1",
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

describe("stageRegistryProviderRecoveryReceipt", () => {
  it("leaves recovery authority absent without a registry-derived route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, null, {
      nonce: "nonce-without-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions).not.toHaveProperty("providerRecoveryReceipt");
  });

  it("binds recovery authority to the captured registry route", () => {
    const recreateOptions: { providerRecoveryReceipt?: ProviderRecoveryReceipt } = {};

    stageRegistryProviderRecoveryReceipt(recreateOptions, target, registryRoute, {
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
    });

    expect(recreateOptions.providerRecoveryReceipt).toEqual({
      ...target,
      route: registryRoute,
      nonce: "nonce-with-route",
      expiresAtMs: 1_000,
      sessionId: null,
    });
  });
});
