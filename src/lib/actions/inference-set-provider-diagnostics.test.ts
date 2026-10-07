// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderInventory,
  OpenShellProviderResult,
} from "../adapters/openshell/provider-adapter";
import { classifyGatewayProviderNames, isBridgeProviderName } from "../credentials/provider-list";
import {
  buildInferenceSetFailure,
  queryRegisteredGatewayProviders,
} from "./inference-set-provider-diagnostics";

const STATIC_WARNING =
  "  ⚠ Could not query registered OpenShell providers while formatting the failure.";

function adapterWithList(
  result: OpenShellProviderResult<OpenShellProviderInventory>,
): OpenShellProviderAdapter {
  return {
    listProviders: vi.fn(async () => result),
  } as unknown as OpenShellProviderAdapter;
}

describe("inference set provider diagnostics", () => {
  it("queries the route's named gateway and excludes messaging providers (#9806)", async () => {
    const providerAdapter = adapterWithList({
      ok: true,
      value: { names: ["nvidia-prod", "alpha-telegram-bridge", "anthropic-prod"] },
    });
    const log = vi.fn();

    await expect(
      queryRegisteredGatewayProviders("non-default-gateway", { providerAdapter, log }),
    ).resolves.toEqual(["anthropic-prod", "nvidia-prod"]);
    expect(providerAdapter.listProviders).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "non-default-gateway" },
      timeoutMs: 5_000,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("partitions empty and messaging-only provider inventories (#5924)", () => {
    expect(classifyGatewayProviderNames([])).toEqual({ bridgeNames: [], credentialNames: [] });
    expect(classifyGatewayProviderNames(["alpha-telegram-bridge", "alpha-slack-app"])).toEqual({
      bridgeNames: ["alpha-telegram-bridge", "alpha-slack-app"],
      credentialNames: [],
    });
    expect(isBridgeProviderName("alpha-discord-bridge")).toBe(true);
    expect(isBridgeProviderName("nvidia-prod")).toBe(false);
  });

  it("normalizes the internal native NVIDIA provider to its public name", () => {
    expect(
      classifyGatewayProviderNames(["nemoclaw-nvidia-prod-v1", "nvidia-prod", "custom-provider"]),
    ).toEqual({
      bridgeNames: [],
      credentialNames: ["custom-provider", "nvidia-prod"],
    });
  });

  it.each([
    {
      name: "thrown adapter error",
      list: async () => {
        throw new Error("query-secret");
      },
    },
    {
      name: "timeout",
      list: async () => ({
        ok: false as const,
        error: { kind: "timeout" as const, message: "safe timeout" },
      }),
    },
    {
      name: "command failure",
      list: async () => ({
        ok: false as const,
        error: { kind: "command" as const, reason: "failed" as const, message: "safe failure" },
      }),
    },
  ])("uses the static fallback for $name (#5924)", async ({ list }) => {
    const providerAdapter = {
      listProviders: vi.fn(list),
    } as unknown as OpenShellProviderAdapter;
    const log = vi.fn();

    await expect(
      queryRegisteredGatewayProviders("non-default-gateway", { providerAdapter, log }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(STATIC_WARNING);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("query-secret"));
  });

  it("normalizes a status-zero route failure to a nonzero public CLI exit", async () => {
    const providerAdapter = adapterWithList({ ok: true, value: { names: [] } });

    await expect(
      buildInferenceSetFailure(
        {
          kind: "command",
          reason: "indeterminate",
          exitCode: 0,
          message: "The route result is unknown.",
        },
        true,
        "nemoclaw",
        { providerAdapter, log: vi.fn() },
      ),
    ).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("Inspect gateway 'nemoclaw'"),
    });
    expect(providerAdapter.listProviders).not.toHaveBeenCalled();
  });
});
