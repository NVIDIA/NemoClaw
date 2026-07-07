// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCustomPolicies, runCapture } = vi.hoisted(() => ({
  getCustomPolicies: vi.fn(),
  runCapture: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runner")>()),
  runCapture,
}));

vi.mock("../state/registry", () => ({ getCustomPolicies }));

import { customPresetOwnsNetworkPolicyKey } from "./index";

const MATCHING_POLICY = `version: 1
network_policies:
  shared-otel:
    endpoints:
      - host: collector.internal
        port: 4318
`;

const DRIFTED_PRESET = `preset:
  name: drifted
network_policies:
  shared-otel:
    endpoints:
      - host: stale.internal
        port: 4318
`;

const MATCHING_PRESET = `preset:
  name: matching
network_policies:
  shared-otel:
    endpoints:
      - host: collector.internal
        port: 4318
`;

const MATCHING_KEY_WITH_DRIFTED_SIBLING = `preset:
  name: matching-with-sibling
network_policies:
  shared-otel:
    endpoints:
      - host: collector.internal
        port: 4318
  unrelated-policy:
    endpoints:
      - host: stale.internal
        port: 443
`;

describe("customPresetOwnsNetworkPolicyKey", () => {
  beforeEach(() => {
    getCustomPolicies.mockReset();
    runCapture.mockReset();
  });

  it("compares two matching-key candidates against one live policy read (#3915)", () => {
    getCustomPolicies.mockReturnValue([
      { name: "drifted", content: DRIFTED_PRESET },
      { name: "matching", content: MATCHING_PRESET },
    ]);
    runCapture.mockReturnValue(MATCHING_POLICY);

    expect(customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toBe(true);
    expect(runCapture).toHaveBeenCalledOnce();
    expect(runCapture.mock.calls[0]?.[0]?.slice(1)).toEqual([
      "policy",
      "get",
      "--base",
      "my-sandbox",
    ]);
  });

  it("compares only the requested key when another key in the custom preset drifts", () => {
    getCustomPolicies.mockReturnValue([
      { name: "matching-with-sibling", content: MATCHING_KEY_WITH_DRIFTED_SIBLING },
    ]);
    runCapture.mockReturnValue(
      `${MATCHING_POLICY}  unrelated-policy:\n    endpoints:\n      - host: live.internal\n        port: 443\n`,
    );

    expect(customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toBe(true);
    expect(runCapture).toHaveBeenCalledOnce();
  });

  it("does not read live policy when no custom candidate owns the key (#3915)", () => {
    getCustomPolicies.mockReturnValue([
      {
        name: "unrelated",
        content: "network_policies:\n  unrelated:\n    endpoints: []\n",
      },
    ]);

    expect(customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toBe(false);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("aborts before mutation when registered custom ownership content is malformed", () => {
    getCustomPolicies.mockReturnValue([
      {
        name: "corrupt-otel",
        content: "network_policies:\n  shared-otel: [unterminated",
      },
    ]);

    expect(() => customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toThrow(
      /Could not inspect registered custom policy ownership.*refusing to reconcile/,
    );
    expect(runCapture).not.toHaveBeenCalled();
  });

  it("aborts reconciliation when the single live policy read fails (#3915)", () => {
    getCustomPolicies.mockReturnValue([{ name: "matching", content: MATCHING_PRESET }]);
    runCapture.mockImplementation(() => {
      throw new Error("gateway unavailable");
    });

    expect(() => customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toThrow(
      /Could not read live policy ownership.*refusing to reconcile/,
    );
    expect(runCapture).toHaveBeenCalledOnce();
  });

  it("aborts reconciliation when the live policy response is indeterminate", () => {
    getCustomPolicies.mockReturnValue([{ name: "matching", content: MATCHING_PRESET }]);
    runCapture.mockReturnValue("version: [invalid");

    expect(() => customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toThrow(
      /Could not determine live policy ownership.*refusing to reconcile/,
    );
    expect(runCapture).toHaveBeenCalledOnce();
  });
});
