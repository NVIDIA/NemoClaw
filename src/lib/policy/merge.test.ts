// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { stripProviderComposedPolicies, withoutProviderComposedPolicies } from "./merge";

describe("OpenShell provider-composed policy boundary", () => {
  it("preserves ordinary entries while removing reserved provider entries", () => {
    expect(
      withoutProviderComposedPolicies({
        safe_entry: { name: "safe-entry" },
        _provider_injected: { name: "must-not-submit" },
      }),
    ).toEqual({ safe_entry: { name: "safe-entry" } });
  });

  it("fails closed when malformed YAML cannot be filtered", () => {
    expect(() => stripProviderComposedPolicies("version: [unterminated")).toThrow(
      /Cannot filter provider-composed policy entries from invalid YAML/,
    );
  });
});
