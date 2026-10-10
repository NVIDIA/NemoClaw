// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativeCustomProfile } from "../../inference/native-custom/profile";

import {
  endpointlessProviderProfilePath,
  exportedProviderProfileMatchesContract,
  parseCheckedInProviderProfileContract,
} from "./provider-profile";

const PROFILE_ID = "langfuse-hermes-v1";

describe("OpenShell endpointless provider profiles", () => {
  it.each([
    [[], undefined, true],
    [[], [], true],
    [[], ["8.8.8.8"], false],
    [["8.8.8.8"], undefined, false],
    [["8.8.8.8"], ["1.1.1.1"], false],
  ] as const)(
    "preserves native profile address restrictions across OpenShell export: %j -> %j",
    (addresses, exportedAddresses, matches) => {
      const profile = buildNativeCustomProfile({
        sandboxName: "native-profile-test",
        provider: "compatible-endpoint",
        endpointUrl: "http://host.openshell.internal:8088/v1",
        api: "openai-completions",
        addresses,
      }).profile;
      const expected = parseCheckedInProviderProfileContract(JSON.stringify(profile));
      expect(expected).not.toBeNull();
      const exported = {
        ...profile,
        endpoints: [{ ...profile.endpoints[0], allowed_ips: exportedAddresses }],
      };
      expect(exportedProviderProfileMatchesContract(JSON.stringify(exported), expected!)).toBe(
        matches,
      );
    },
  );

  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "langfuse-hermes-v1.yaml"),
    );
  });

  it.each([
    ["path_template", "/v1/{credential}"],
    ["token_grant", { endpoint: "https://attacker.example/token" }],
  ])("rejects an unowned exported credential control: %s (#12558)", (key, value) => {
    const profile = {
      id: "native",
      credentials: [
        {
          name: "api_key",
          env_vars: ["API_KEY"],
          required: true,
          auth_style: "bearer",
          header_name: "authorization",
          query_param: "",
        },
      ],
      endpoints: [],
      binaries: ["/usr/bin/curl"],
      inference_capable: true,
    };
    const expected = parseCheckedInProviderProfileContract(JSON.stringify(profile));
    expect(expected).not.toBeNull();
    const exported = { ...profile, credentials: [{ ...profile.credentials[0], [key]: value }] };

    expect(exportedProviderProfileMatchesContract(JSON.stringify(exported), expected!)).toBe(false);
  });
});
