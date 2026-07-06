// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createInferenceRouteHelpers } from "./inference-route";
import {
  bindGatewayUpsertProvider,
  createGatewayScopedOpenshellRunner,
  scopeGatewayOpenshellArgs,
} from "./setup-inference";

const GATEWAY = "nemoclaw-9090";

describe("gateway-scoped onboarding OpenShell commands", () => {
  it.each([
    [
      ["provider", "get", "openai-api"],
      ["provider", "get", "-g", GATEWAY, "openai-api"],
    ],
    [
      ["inference", "set", "--provider", "openai-api", "--model", "gpt-test"],
      ["inference", "set", "-g", GATEWAY, "--provider", "openai-api", "--model", "gpt-test"],
    ],
    [
      ["sandbox", "provider", "detach", "alpha", "openai-api"],
      ["sandbox", "provider", "detach", "-g", GATEWAY, "alpha", "openai-api"],
    ],
  ])("adds the target gateway to %j", (input, expected) => {
    expect(scopeGatewayOpenshellArgs(input, GATEWAY)).toEqual(expected);
  });

  it("targets sandbox execution at the same gateway", () => {
    expect(
      scopeGatewayOpenshellArgs(["sandbox", "exec", "-n", "alpha", "--", "true"], GATEWAY),
    ).toEqual(["sandbox", "exec", "-g", GATEWAY, "-n", "alpha", "--", "true"]);
  });

  it.each([
    ["-g", GATEWAY],
    ["--gateway", GATEWAY],
    [`--gateway=${GATEWAY}`],
  ])("accepts an identical existing target: %j", (...gatewayArgs) => {
    const command = ["provider", "list", ...gatewayArgs];
    expect(scopeGatewayOpenshellArgs(command, GATEWAY)).toEqual(command);
  });

  it("rejects a conflicting, duplicate, missing, or selection-based target", () => {
    expect(() =>
      scopeGatewayOpenshellArgs(["provider", "get", "-g", "nemoclaw", "openai-api"], GATEWAY),
    ).toThrow(/instead of 'nemoclaw-9090'/);
    expect(() =>
      scopeGatewayOpenshellArgs(["inference", "get", "-g", GATEWAY, "--gateway", GATEWAY], GATEWAY),
    ).toThrow(/multiple gateway targets/);
    expect(() => scopeGatewayOpenshellArgs(["provider", "list", "-g"], GATEWAY)).toThrow(
      /instead of 'nemoclaw-9090'/,
    );
    expect(() => scopeGatewayOpenshellArgs(["gateway", "select", GATEWAY], GATEWAY)).toThrow(
      /must not change the selected gateway/,
    );
  });

  it("scopes every command sent through the runner without mutating the caller argv", () => {
    const run = vi.fn((_args: string[], _options?: { ignoreError?: boolean }) => ({ status: 0 }));
    const scoped = createGatewayScopedOpenshellRunner(run, GATEWAY);
    const command = ["provider", "delete", "openai-api"];
    scoped(command, { ignoreError: true });
    expect(command).toEqual(["provider", "delete", "openai-api"]);
    expect(run).toHaveBeenCalledWith(["provider", "delete", "-g", GATEWAY, "openai-api"], {
      ignoreError: true,
    });
  });

  it("keeps an omitted provider env separate from the bound gateway", () => {
    const upsert = vi.fn(() => ({ ok: true }));
    bindGatewayUpsertProvider(upsert, GATEWAY)("openai-api", "openai", "OPENAI_API_KEY", null);
    expect(upsert).toHaveBeenCalledWith(
      "openai-api",
      "openai",
      "OPENAI_API_KEY",
      null,
      undefined,
      GATEWAY,
    );
  });
});

describe("gateway-scoped inference route readers", () => {
  const output = [
    "Gateway inference:",
    "  Provider: openai-api",
    "  Model: gpt-test",
    "  Version: 1",
  ].join("\n");

  it("uses the explicit gateway for verification and readiness", () => {
    const capture = vi.fn(() => output);
    const route = createInferenceRouteHelpers(capture);

    route.verifyInferenceRoute(GATEWAY, "openai-api", "gpt-test");
    expect(route.isInferenceRouteReady(GATEWAY, "openai-api", "gpt-test")).toBe(true);
    expect(route.isInferenceRouteReady(GATEWAY, "openai-api", "other")).toBe(false);
    expect(capture).toHaveBeenCalledTimes(3);
    for (const call of capture.mock.calls) {
      expect(call).toEqual([["inference", "get", "-g", GATEWAY], { ignoreError: true }]);
    }
  });
});
