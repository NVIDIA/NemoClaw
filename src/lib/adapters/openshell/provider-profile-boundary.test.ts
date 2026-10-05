// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { parseCheckedInProviderProfileContract } from "./provider-profile";

const profile = {
  id: "compatible-test",
  inference_capable: true,
  credentials: [
    {
      name: "api_key",
      env_vars: ["TEST_KEY"],
      required: true,
      auth_style: "bearer",
      header_name: "authorization",
      query_param: "",
    },
  ],
  endpoints: [{ host: "api.example.com", port: 443, protocol: "rest", enforcement: "enforce" }],
  binaries: ["/usr/bin/curl"],
};
const expectedProfile = parseCheckedInProviderProfileContract(JSON.stringify(profile));
assert(expectedProfile);

it("observes a matching endpoint profile without importing it", async () => {
  const run = vi.fn<RunProviderCommand>(() => ({
    status: 0,
    stdout: JSON.stringify(profile),
    stderr: "",
  }));
  const adapter = createCliOpenShellProviderAdapter({ run });
  const result = await adapter.inspectProviderProfile({
    target: { kind: "selected" },
    profileType: profile.id,
    expectedProfile,
  });
  expect(result.ok).toBe(true);
  expect(run.mock.calls.map(([args]) => args)).toEqual([
    ["provider", "profile", "export", profile.id, "--output", "json"],
  ]);
});

it.each([
  { ...profile, endpoints: [{ ...profile.endpoints[0], host: "other.example.com" }] },
  {
    ...profile,
    credentials: [{ ...profile.credentials[0], path_template: "/credential/{api_key}" }],
  },
  {
    ...profile,
    credentials: [
      {
        ...profile.credentials[0],
        token_grant: { token_endpoint: "https://other.example.com/token" },
      },
    ],
  },
  { ...profile, discovery: { credentials: ["unexpected-source"] } },
])(
  "refuses a changed credential or destination boundary without mutation [case %#]",
  async (liveProfile) => {
    const run = vi.fn<RunProviderCommand>(() => ({
      status: 0,
      stdout: JSON.stringify(liveProfile),
      stderr: "",
    }));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => JSON.stringify(profile),
    });
    await expect(
      adapter.inspectProviderProfile({
        target: { kind: "selected" },
        profileType: profile.id,
        expectedProfile,
      }),
    ).resolves.toMatchObject({ ok: false, error: { reason: "profile_incompatible" } });
    expect(
      adapter.importProviderProfile({
        target: { kind: "selected" },
        profilePath: "/test/profile.yaml",
      }),
    ).toMatchObject({ ok: false, error: { reason: "profile_incompatible" } });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", profile.id, "--output", "json"],
      ["provider", "profile", "export", profile.id, "--output", "json"],
    ]);
  },
);
