// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createCliOpenShellProviderAdapter } from "./provider-adapter-cli";
import { selectedOpenShellGateway } from "./sandbox-observer";

describe("native provider profile metadata bounds", () => {
  it.each([
    [
      `nemoclaw-compatible-${"a".repeat(64)}-v1`,
      true,
      { value: { type: `nemoclaw-compatible-${"a".repeat(64)}-v1` } },
    ],
    ["a".repeat(128), true, { value: { type: "a".repeat(128) } }],
    ["a".repeat(129), false, { error: { kind: "schema" } }],
    ["invalid/profile", false, { error: { kind: "schema" } }],
  ])("bounds native profile metadata type %s", async (type, accepted, expected) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => ({
        status: 0,
        stdout: [
          "Name: search-prod",
          `Type: ${type}`,
          "Credential keys: NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
          "Config keys: <none>",
        ].join("\n"),
        stderr: "",
      }),
    });
    const result = await adapter.getProvider({
      target: selectedOpenShellGateway(),
      providerName: "search-prod",
    });
    expect(result.ok).toBe(accepted);
    expect(result).toMatchObject(expected);
  });
});
