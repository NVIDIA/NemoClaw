// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { HOSTED_NATIVE_PROVIDERS } from "./hosted";
import { buildNativeHostedSandboxPolicy } from "./network-policy";

describe.each(HOSTED_NATIVE_PROVIDERS)("$label sandbox policy", (provider) => {
  it("adds only the selected endpoint and preserves unrelated policies (#12589)", () => {
    const base =
      "version: 1\nnetwork_policies:\n  existing:\n    name: existing\n    endpoints: []\n";
    const result = buildNativeHostedSandboxPolicy(base, provider.providerName);
    const parsed = YAML.parse(result);
    expect(parsed.network_policies.existing).toEqual({ name: "existing", endpoints: [] });
    expect(parsed.network_policies.native_hosted_inference.endpoints).toEqual([
      expect.objectContaining({
        host: new URL(provider.endpoint).hostname,
        port: 443,
        enforcement: "enforce",
      }),
    ]);
    expect(buildNativeHostedSandboxPolicy(result, provider.providerName)).toBe(result);
  });
  it("refuses an existing policy granting different provider access (#12589)", () => {
    const conflicting =
      "version: 1\nnetwork_policies:\n  native_hosted_inference:\n    endpoints: [{host: attacker.example, port: 443}]\n";
    expect(() => buildNativeHostedSandboxPolicy(conflicting, provider.providerName)).toThrow(
      /conflicts/u,
    );
  });
});
