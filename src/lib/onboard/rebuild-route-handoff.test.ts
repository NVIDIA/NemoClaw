// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import { createRebuildRouteHandoff, type RegistryInferenceRoute } from "./rebuild-route-handoff";

function registryRoute(): RegistryInferenceRoute {
  return {
    provider: "compatible-endpoint",
    model: "nvidia/model",
    endpointUrl: "https://inference.example.test/v1",
    preferredInferenceApi: "openai-completions",
    source: "registry",
  };
}

describe("createRebuildRouteHandoff", () => {
  it("defensively copies and freezes the complete registry route", () => {
    const route = registryRoute();
    const handoff = createRebuildRouteHandoff("alpha", route);

    expect(handoff).toEqual({ sandboxName: "alpha", route });
    expect(handoff.route).not.toBe(route);
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.route)).toBe(true);
    expect(Reflect.set(handoff, "sandboxName", "other")).toBe(false);
    expect(Reflect.set(handoff.route, "provider", "attacker")).toBe(false);
    expect(handoff).toEqual({ sandboxName: "alpha", route });
    expectTypeOf(handoff.route.source).toEqualTypeOf<"registry">();
  });

  it("rejects an untyped session route before it can become registry authority", () => {
    const sessionRoute = {
      ...registryRoute(),
      source: "session",
    } as unknown as RegistryInferenceRoute;

    expect(() => createRebuildRouteHandoff("alpha", sessionRoute)).toThrow(
      "Rebuild route handoff requires a registry-derived route",
    );
  });
});
