// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createInferenceRouteHelpers } from "./inference-route";
import {
  bindGatewayUpsertProvider,
  createGatewayScopedOpenshellRunner,
  scopeGatewayOpenshellArgs,
  selectGatewayForFollowupOrExit,
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

  it("does not treat gateway-like sandbox payload arguments as OpenShell options", () => {
    expect(
      scopeGatewayOpenshellArgs(
        [
          "sandbox",
          "exec",
          "-n",
          "alpha",
          "--",
          "tool",
          "--gateway",
          "payload-gateway",
          "--gateway-endpoint=https://payload.example.test",
        ],
        GATEWAY,
      ),
    ).toEqual([
      "sandbox",
      "exec",
      "-g",
      GATEWAY,
      "-n",
      "alpha",
      "--",
      "tool",
      "--gateway",
      "payload-gateway",
      "--gateway-endpoint=https://payload.example.test",
    ]);
  });

  it.each([
    ["--gateway-endpoint", "https://other.example.test"],
    ["--gateway-endpoint=https://other.example.test"],
  ])("rejects an explicit endpoint override before the payload separator: %j", (...endpointArgs) => {
    expect(() =>
      scopeGatewayOpenshellArgs(["provider", "get", ...endpointArgs, "openai-api"], GATEWAY),
    ).toThrow(/--gateway-endpoint may bypass the gateway recorded/);
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

  it("rejects an ambient endpoint override before creating a scoped runner", () => {
    const run = vi.fn();
    expect(() =>
      createGatewayScopedOpenshellRunner(run, GATEWAY, {
        OPENSHELL_GATEWAY_ENDPOINT: "https://other.example.test",
      }),
    ).toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    expect(run).not.toHaveBeenCalled();
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

  it("selects the managed gateway for follow-up commands and fails closed on error", () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 17 });
    const error = vi.fn();
    const exitProcess = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

    expect(() => selectGatewayForFollowupOrExit(GATEWAY, run, error, exitProcess)).not.toThrow();
    expect(() => selectGatewayForFollowupOrExit(GATEWAY, run, error, exitProcess)).toThrow(
      "exit 17",
    );
    expect(run).toHaveBeenNthCalledWith(1, ["gateway", "select", GATEWAY], {
      ignoreError: true,
    });
    expect(run).toHaveBeenNthCalledWith(2, ["gateway", "select", GATEWAY], {
      ignoreError: true,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("No follow-up operations"));
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

  it("reads compatibility peers through the injected registry boundary", () => {
    const listSandboxes = vi.fn(() => ({
      defaultSandbox: "alpha",
      sandboxes: [
        {
          name: "alpha",
          gatewayName: GATEWAY,
          gatewayPort: 9090,
          provider: "openai-api",
          model: "gpt-test",
          gpuEnabled: false,
          policies: [],
        },
      ],
    }));
    const route = createInferenceRouteHelpers(
      vi.fn(() => null),
      listSandboxes,
    );

    expect(
      route.checkGatewayRouteCompatibility({
        gatewayName: GATEWAY,
        sandboxName: "alpha",
        route: { provider: "openai-api", model: "gpt-test" },
      }),
    ).toEqual({ ok: true });
    expect(listSandboxes).toHaveBeenCalledOnce();
  });
});
