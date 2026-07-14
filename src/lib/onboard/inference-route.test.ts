// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { createInferenceRouteHelpers } from "./inference-route";

afterEach(() => {
  vi.restoreAllMocks();
});

function gatewayRoute(provider: string, model: string): string {
  return [
    "Gateway inference:",
    "",
    "  Route: inference.local",
    `  Provider: ${provider}`,
    `  Model: ${model}`,
    "  Version: 1",
    "",
    "System inference:",
    "",
    "  Not configured",
  ].join("\n");
}

describe("verifyInferenceRoute", () => {
  it("accepts the exact gateway provider and model despite unconfigured system inference (#6114)", () => {
    const helpers = createInferenceRouteHelpers(() =>
      gatewayRoute("compatible-endpoint", "test-model"),
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
    const helpers = createInferenceRouteHelpers(() => gatewayRoute("openai-api", "other-model"));

    expect(() =>
      helpers.verifyInferenceRoute("nemoclaw", "compatible-endpoint", "test-model"),
    ).toThrow("process.exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.flat().join("\n")).toContain(
      "does not match provider 'compatible-endpoint' and model 'test-model'",
    );
  });
});
