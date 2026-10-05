// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  endpointlessProviderProfilePath,
  parseCheckedInProviderProfileContract,
  exportedProviderProfileMatchesContract,
} from "./provider-profile";

const PROFILE_ID = "langfuse-hermes-v1";

describe("OpenShell endpointless provider profiles", () => {
  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "langfuse-hermes-v1.yaml"),
    );
  });
});

describe("provider credential discovery boundary", () => {
  const profile = {
    id: "test",
    credentials: [],
    endpoints: [],
    binaries: [],
    inference_capable: true,
  };
  it.each([
    [{ credentials: [] }, true],
    [{ credentials: ["foreign-source"] }, false],
    [{ credentials: "invalid" }, false],
    [{ credentials: [1] }, false],
  ])("compares credential discovery sources [case %#]", (discovery, accepted) => {
    const expected = parseCheckedInProviderProfileContract(JSON.stringify(profile));
    assert(expected, "invalid fixture");
    expect(
      exportedProviderProfileMatchesContract(JSON.stringify({ ...profile, discovery }), expected),
    ).toBe(accepted);
  });
});
