// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  endpointlessProviderProfilePath,
  exportedProviderProfileMatchesContract,
  parseCheckedInProviderProfileContract,
} from "./provider-profile";

const PROFILE_ID = "langfuse-hermes-v1";

describe("OpenShell endpointless provider profiles", () => {
  it.each([
    ["omitted files", undefined, true],
    ["empty files", [], true],
    [
      "workload file",
      [{ path: "client.yaml", content: "unowned", env_var: "CLIENT_CONFIG" }],
      false,
    ],
    ["malformed files", {}, false],
    ["null files", null, false],
  ] as const)(
    "checks provider-managed files before profile reuse: %s",
    (_name, files, accepted) => {
      const profile = {
        id: PROFILE_ID,
        credentials: [],
        endpoints: [],
        binaries: [],
        inference_capable: false,
      };
      const expected = parseCheckedInProviderProfileContract(JSON.stringify(profile));
      assert.ok(expected, "Valid fixture profile");
      const exported = JSON.stringify({ ...profile, files });

      expect(exportedProviderProfileMatchesContract(exported, expected)).toBe(accepted);
      expect(parseCheckedInProviderProfileContract(exported) !== null).toBe(accepted);
    },
  );

  it("resolves a checked-in profile path for the requested profile", () => {
    expect(endpointlessProviderProfilePath("/repo", PROFILE_ID)).toBe(
      path.join("/repo", "nemoclaw-blueprint", "provider-profiles", "langfuse-hermes-v1.yaml"),
    );
  });

  it.each([
    ["stable_placeholder", true],
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
