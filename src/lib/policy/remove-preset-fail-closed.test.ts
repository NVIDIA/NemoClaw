// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { removePresetFromPolicy } from "./index";

describe("removePresetFromPolicy fail-closed boundary", () => {
  it("rejects malformed preset YAML without producing a replacement policy", () => {
    const currentPolicy = "version: 1\nnetwork_policies:\n  pypi: {}\n";

    expect(() => removePresetFromPolicy(currentPolicy, "  pypi: [unterminated")).toThrow(
      /Cannot remove policy preset: preset network_policies entries must be a valid YAML mapping/,
    );
  });
});
