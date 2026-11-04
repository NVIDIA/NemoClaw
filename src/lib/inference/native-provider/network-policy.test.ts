// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { customNativeProvider } from "./custom";
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

describe("custom NVIDIA endpoint policy ownership", () => {
  function fixture(endpointUrl = "https://integrate.api.nvidia.com/v1") {
    const definition = customNativeProvider({
      provider: "compatible-endpoint",
      endpointUrl,
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      allowedIps: ["8.8.8.8"],
    });
    const policy = YAML.parse(
      fs.readFileSync(
        path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        "utf8",
      ),
    );
    const build = () =>
      buildNativeHostedSandboxPolicy(YAML.stringify(policy), definition.providerName, {
        schemaVersion: 1,
        providerId: "custom-provider-id",
        profileId: definition.profileId,
        providerName: definition.providerName,
        endpointUrl: definition.endpointUrl,
        allowedIps: definition.allowedIps,
        custom: definition.custom,
      });
    return { policy, build };
  }

  it.each([
    ["rules", { endpoints: [{ host: "integrate.api.nvidia.com", port: 443, rules: [] }] }],
    ["binaries", { binaries: [{ path: "/usr/bin/operator-client" }] }],
    [
      "pins",
      { endpoints: [{ host: "integrate.api.nvidia.com", port: 443, allowed_ips: ["1.1.1.1"] }] },
    ],
  ])("refuses to replace an operator's changed NVIDIA %s (#14013)", (_change, override) => {
    const { policy, build } = fixture();
    const nvidia = policy.network_policies.nvidia;
    Object.assign(nvidia, override);
    const original = structuredClone(policy);
    expect(build).toThrow(/policy "nvidia".*conflicting IP pins/u);
    expect(policy).toEqual(original);
  });

  it("preserves an operator rule whose pins already match the selected endpoint (#14013)", () => {
    const { policy, build } = fixture();
    policy.network_policies.nvidia.endpoints[0].allowed_ips = ["8.8.8.8"];
    expect(YAML.parse(build()).network_policies.nvidia).toEqual(policy.network_policies.nvidia);
  });

  it.each(["https://other.example/v1", "https://integrate.api.nvidia.com:8443/v1"])(
    "preserves the bundled NVIDIA rule when selecting %s (#14013)",
    (endpointUrl) => {
      const { policy, build } = fixture(endpointUrl);
      expect(YAML.parse(build()).network_policies.nvidia).toEqual(policy.network_policies.nvidia);
    },
  );

  it("preserves unrelated rules and produces the same policy on resume (#14013)", () => {
    const { policy, build } = fixture();
    const original = structuredClone(policy.network_policies);
    delete original.nvidia;
    const first = build();
    const parsed = YAML.parse(first);
    expect(parsed.network_policies).toEqual(original);
    policy.network_policies = parsed.network_policies;
    expect(build()).toBe(first);
  });
});
