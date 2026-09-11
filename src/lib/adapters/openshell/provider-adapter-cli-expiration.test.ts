// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

const PROVIDER_GET_OUTPUT = [
  "Name: search-prod",
  "Type: tavily",
  "Credential keys: TAVILY_API_KEY",
  "Config keys: <none>",
].join("\n");

describe("CLI OpenShell provider credential expiration metadata", () => {
  it("returns requested non-secret expirations from the exact gateway (#10394)", async () => {
    const credentialValue = "must-not-cross-the-adapter";
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, PROVIDER_GET_OUTPUT))
      .mockReturnValueOnce(
        captured(
          0,
          JSON.stringify([
            {
              name: "other-provider",
              credential_expires_at_ms: { OTHER_API_KEY: 999 },
            },
            {
              name: "search-prod",
              credentials: { TAVILY_API_KEY: credentialValue },
              credential_expires_at_ms: { TAVILY_API_KEY: 1_234_567_890 },
            },
          ]),
        ),
      );
    const adapter = createCliOpenShellProviderAdapter({ run });

    const result = await adapter.getProvider({
      target: namedOpenShellGateway("nemoclaw-18080"),
      providerName: "search-prod",
      includeCredentialExpirations: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        name: "search-prod",
        type: "tavily",
        credentialKeys: ["TAVILY_API_KEY"],
        configKeys: [],
        revision: null,
        credentialExpiresAtMs: { TAVILY_API_KEY: 1_234_567_890 },
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
    expect(run).toHaveBeenNthCalledWith(
      2,
      [
        "provider",
        "list",
        "-g",
        "nemoclaw-18080",
        "--limit",
        "1000",
        "--offset",
        "0",
        "--output",
        "json",
      ],
      expect.objectContaining({
        maxBuffer: 4 * 1024 * 1024,
        suppressOutput: true,
      }),
    );
  });

  it.each([
    [
      "duplicate target",
      JSON.stringify([
        { name: "search-prod", credential_expires_at_ms: {} },
        { name: "search-prod", credential_expires_at_ms: {} },
      ]),
    ],
    [
      "unsafe credential key",
      JSON.stringify([
        { name: "search-prod", credential_expires_at_ms: { "TAVILY_API_KEY=value": 1_000 } },
      ]),
    ],
    [
      "unsafe expiry timestamp",
      JSON.stringify([
        { name: "search-prod", credential_expires_at_ms: { TAVILY_API_KEY: "1000" } },
      ]),
    ],
  ])("rejects %s in expiration inventory (#10394)", async (_case, inventory) => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, PROVIDER_GET_OUTPUT))
      .mockReturnValueOnce(captured(0, inventory));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.getProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        includeCredentialExpirations: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "schema",
        message: "OpenShell returned invalid provider credential expiration metadata.",
      },
    });
  });
});
