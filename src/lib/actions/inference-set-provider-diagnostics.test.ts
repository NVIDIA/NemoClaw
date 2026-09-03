// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderInventory,
  OpenShellProviderResult,
} from "../adapters/openshell/provider-adapter";
import { classifyGatewayProviderNames, isBridgeProviderName } from "../credentials/provider-list";
import { queryRegisteredGatewayProviders } from "./inference-set-provider-diagnostics";

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
  it("returns sorted credential provider names and excludes messaging providers (#5924)", async () => {
    const providerAdapter = adapterWithList({
      ok: true,
      value: { names: ["nvidia-prod", "alpha-telegram-bridge", "anthropic-prod"] },
    });
    const log = vi.fn();

    await expect(queryRegisteredGatewayProviders({ providerAdapter, log })).resolves.toEqual([
      "anthropic-prod",
      "nvidia-prod",
    ]);
    expect(providerAdapter.listProviders).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "selected" },
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
      queryRegisteredGatewayProviders({ providerAdapter, log }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(STATIC_WARNING);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("query-secret"));
  });
});
