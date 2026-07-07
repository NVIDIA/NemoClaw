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

  it("fails closed when the single live policy read fails (#3915)", () => {
    getCustomPolicies.mockReturnValue([{ name: "matching", content: MATCHING_PRESET }]);
    runCapture.mockImplementation(() => {
      throw new Error("gateway unavailable");
    });

    expect(customPresetOwnsNetworkPolicyKey("my-sandbox", "shared-otel")).toBe(false);
    expect(runCapture).toHaveBeenCalledOnce();
  });
});
