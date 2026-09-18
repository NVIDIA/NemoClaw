// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenShellInferenceRouteResult,
  OpenShellSynchronousInferenceRouteObserver,
} from "../adapters/openshell/inference-route";
import { createInferenceRouteHelpers } from "./inference-route";

afterEach(() => {
  vi.restoreAllMocks();
});

function routeObserver(
  result: OpenShellInferenceRouteResult,
): OpenShellSynchronousInferenceRouteObserver {
  return { observeInferenceRoute: vi.fn(() => result) };
}

function configuredRoute(
  provider: string,
  model: string,
): OpenShellSynchronousInferenceRouteObserver {
  return routeObserver({ ok: true, value: { state: "configured", route: { provider, model } } });
}

describe("verifyInferenceRoute", () => {
  it("accepts the exact gateway provider and model despite unconfigured system inference (#6114)", () => {
    const helpers = createInferenceRouteHelpers(
      configuredRoute("compatible-endpoint", "test-model"),
    );

    expect(() =>
      helpers.verifyInferenceRoute("nemoclaw", "compatible-endpoint", "test-model"),
    ).not.toThrow();
  });

  it("rejects a different live gateway route after provider recreation (#6114)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const helpers = createInferenceRouteHelpers(configuredRoute("openai-api", "other-model"));

    expect(() =>
      helpers.verifyInferenceRoute("nemoclaw", "compatible-endpoint", "test-model"),
    ).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "does not match provider 'compatible-endpoint' and model 'test-model'",
    );
  });
});

describe("readInferenceRouteState", () => {
  it("reports a matched route", () => {
    const helpers = createInferenceRouteHelpers(
      configuredRoute("compatible-endpoint", "test-model"),
    );

    expect(helpers.readInferenceRouteState("nemoclaw", "compatible-endpoint", "test-model")).toBe(
      "matched",
    );
  });

  it.each([
    ["openai-api", "test-model"],
    ["compatible-endpoint", "other-model"],
  ])("reports a route answered as %s/%s as mismatched", (provider, model) => {
    const helpers = createInferenceRouteHelpers(configuredRoute(provider, model));

    expect(helpers.readInferenceRouteState("nemoclaw", "compatible-endpoint", "test-model")).toBe(
      "mismatched",
    );
  });

  it("separates a gateway that cannot answer from a mismatched route (#9310)", () => {
    const helpers = createInferenceRouteHelpers(
      routeObserver({
        ok: false,
        error: { kind: "transport", reason: "unreachable", message: "unreachable" },
      }),
    );

    expect(helpers.readInferenceRouteState("nemoclaw", "compatible-endpoint", "test-model")).toBe(
      "unanswered",
    );
    expect(helpers.isInferenceRouteReady("nemoclaw", "compatible-endpoint", "test-model")).toBe(
      false,
    );
  });
});
