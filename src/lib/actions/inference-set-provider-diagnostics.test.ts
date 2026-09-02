// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { isBridgeProviderName, parseGatewayProviderNames } from "../credentials/provider-list";
import { queryRegisteredGatewayProviders } from "./inference-set-provider-diagnostics";

const STATIC_WARNING =
  "  ⚠ Could not query registered OpenShell providers while formatting the failure.";

describe("inference set provider diagnostics", () => {
  it("returns sorted gateway credentials and excludes messaging providers (#5924)", () => {
    const captureOpenshell = vi.fn(() => ({
      status: 0,
      output: "nvidia-prod\nalpha-telegram-bridge\nanthropic-prod\n",
    }));
    const log = vi.fn();

    expect(queryRegisteredGatewayProviders({ captureOpenshell, log })).toEqual([
      "anthropic-prod",
      "nvidia-prod",
    ]);
    expect(captureOpenshell).toHaveBeenCalledWith(["provider", "list", "--names"], {
      ignoreError: true,
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("partitions empty and messaging-only provider output", () => {
    expect(parseGatewayProviderNames("")).toEqual({ bridgeNames: [], credentialNames: [] });
    expect(parseGatewayProviderNames("alpha-telegram-bridge\nalpha-slack-app\n")).toEqual({
      bridgeNames: ["alpha-telegram-bridge", "alpha-slack-app"],
      credentialNames: [],
    });
    expect(isBridgeProviderName("alpha-discord-bridge")).toBe(true);
    expect(isBridgeProviderName("nvidia-prod")).toBe(false);
  });

  it.each([
    {
      name: "thrown capture error",
      capture: () => {
        throw new Error("query-secret");
      },
    },
    {
      name: "timeout",
      capture: () => ({
        status: null,
        output: "partial-timeout-provider",
        error: Object.assign(new Error("query-secret"), { code: "ETIMEDOUT" }),
      }),
    },
    {
      name: "buffer overflow",
      capture: () => ({
        status: null,
        output: "partial-overflow-provider",
        error: Object.assign(new Error("query-secret"), { code: "ENOBUFS" }),
      }),
    },
    {
      name: "nonzero status",
      capture: () => ({ status: 17, output: "query-secret" }),
    },
  ])("uses the static fallback for $name", ({ capture }) => {
    const captureOpenshell = vi.fn(capture);
    const log = vi.fn();

    expect(queryRegisteredGatewayProviders({ captureOpenshell, log })).toBeUndefined();
    expect(log).toHaveBeenCalledWith(STATIC_WARNING);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("query-secret"));
  });
});
