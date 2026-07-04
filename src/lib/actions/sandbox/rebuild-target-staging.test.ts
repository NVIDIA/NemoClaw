// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { RegistryInferenceRoute } from "../../onboard/rebuild-route-handoff";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import { prepareRebuildRecreateOptions } from "./rebuild-target-staging";

const SANDBOX_ENTRY = {
  name: "alpha",
  dashboardPort: 18789,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
} as RebuildSandboxEntry;

const REGISTRY_ROUTE: RegistryInferenceRoute = {
  provider: "compatible-endpoint",
  model: "nvidia/model",
  endpointUrl: "https://inference.example.test/v1",
  preferredInferenceApi: "openai-completions",
  source: "registry",
};

const bail = (message: string): never => {
  throw new Error(message);
};

describe("prepareRebuildRecreateOptions", () => {
  it("carries the immutable pre-delete registry route into the one-shot onboard call", () => {
    const options = prepareRebuildRecreateOptions(
      "alpha",
      SANDBOX_ENTRY,
      "openclaw",
      null,
      REGISTRY_ROUTE,
      true,
      bail,
    );

    expect(options?.rebuildRegistryInferenceRoute).toEqual({
      sandboxName: "alpha",
      route: REGISTRY_ROUTE,
    });
    expect(options?.rebuildRegistryInferenceRoute?.route).not.toBe(REGISTRY_ROUTE);
    expect(Object.isFrozen(options?.rebuildRegistryInferenceRoute)).toBe(true);
    expect(Object.isFrozen(options?.rebuildRegistryInferenceRoute?.route)).toBe(true);
  });

  it("omits registry authority when preflight did not produce a complete registry route", () => {
    const options = prepareRebuildRecreateOptions(
      "alpha",
      SANDBOX_ENTRY,
      "openclaw",
      null,
      null,
      true,
      bail,
    );

    expect(options).not.toHaveProperty("rebuildRegistryInferenceRoute");
  });
});
