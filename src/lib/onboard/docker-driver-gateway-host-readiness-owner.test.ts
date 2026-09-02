// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareHostRuntime: vi.fn(({ environment }: { environment: NodeJS.ProcessEnv }) => ({
    sandboxHostAddress: environment.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "169.254.2.2" : null,
  })),
}));

vi.mock("./runtime-provider/selection", () => ({
  resolveConfiguredRuntimeProvider: () => ({
    gateway: {
      supported: true,
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
    expect(mocks.prepareHostRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ environment, platform: "linux" }),
    );
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
