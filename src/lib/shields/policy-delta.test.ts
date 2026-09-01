// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { shieldsPolicyDeltaInternals } from "./index";

describe("Shields live policy delta restore", () => {
  it("reverts only unchanged Shields values and preserves host-side edits", () => {
    const before = YAML.stringify({
      version: 1,
      network_policies: {
        changed_by_shields: { mode: "restricted" },
        removed_by_shields: { mode: "allowed" },
      },
    });
    const forward = YAML.stringify({
      version: 1,
      network_policies: {
        changed_by_shields: { mode: "permissive" },
        added_by_shields: { mode: "temporary" },
      },
    });
    const live = YAML.stringify({
      version: 1,
      network_policies: {
        changed_by_shields: { mode: "host-edited" },
        added_by_shields: { mode: "temporary" },
        unrelated_host_entry: { mode: "allowed" },
      },
    });

    const restored = YAML.parse(
      shieldsPolicyDeltaInternals.restoreShieldsDelta(before, forward, live),
    );
    expect(restored.network_policies).toEqual({
      changed_by_shields: { mode: "host-edited" },
      removed_by_shields: { mode: "allowed" },
      unrelated_host_entry: { mode: "allowed" },
    });
  });
});
