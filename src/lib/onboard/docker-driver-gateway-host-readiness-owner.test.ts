// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareHostRuntime: vi.fn(() => ({ sandboxHostAddress: "169.254.2.2" })),
}));

vi.mock("./runtime-provider/selection", () => ({
  resolveConfiguredRuntimeProvider: (
    _platform: NodeJS.Platform,
    _architecture: NodeJS.Architecture,
    environment: NodeJS.ProcessEnv,
  ) => ({
    gateway: {
      supported: true,
      ownsHostReadiness: environment.NEMOCLAW_GATEWAY_RUNTIME === "podman",
      prepareHostRuntime: mocks.prepareHostRuntime,
    },
  }),
}));

import { configuredRuntimeProviderOwnsHostReadiness } from "./docker-driver-gateway-env";

afterEach(() => {
  vi.clearAllMocks();
});

describe("configured runtime provider host readiness", () => {
  it.each([
    ["docker", false],
    ["podman", true],
  ] as const)("reports %s provider ownership as %s", (runtime, expected) => {
    const environment = { NEMOCLAW_GATEWAY_RUNTIME: runtime };

    expect(configuredRuntimeProviderOwnsHostReadiness({ environment, platform: "linux" })).toBe(
      expected,
    );
    expect(mocks.prepareHostRuntime).not.toHaveBeenCalled();
  });

  it("does not prepare runtime topology to infer ownership", () => {
    const environment = { NEMOCLAW_GATEWAY_RUNTIME: "docker" };

    expect(configuredRuntimeProviderOwnsHostReadiness({ environment, platform: "linux" })).toBe(
      false,
    );
    expect(mocks.prepareHostRuntime).not.toHaveBeenCalled();
  });

  it("keeps portable Podman compatibility on standard Docker readiness", () => {
    expect(
      configuredRuntimeProviderOwnsHostReadiness({
        environment: {
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
          NEMOCLAW_GATEWAY_RUNTIME: "podman",
        },
        platform: "linux",
      }),
    ).toBe(false);
    expect(mocks.prepareHostRuntime).not.toHaveBeenCalled();
  });
});
