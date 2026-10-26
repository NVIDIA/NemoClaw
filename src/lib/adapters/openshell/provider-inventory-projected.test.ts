// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";

const runtime = vi.hoisted(() => ({ version: "0.1.3" }));
vi.mock("../../onboard/openshell-version", async (original) => ({
  ...(await original<typeof import("../../onboard/openshell-version")>()),
  get SUPPORTED_OPENSHELL_FALLBACK_VERSION() {
    return runtime.version;
  },
}));

describe.each(["0.1.3", "0.1.5"])("OpenShell %s projection", (version) => {
  beforeEach(() => {
    runtime.version = version;
  });

  it.each([false, true])(
    "reads projected expiry pages and rejects a repeated token: %s",
    async (repeat) => {
      const first = {
        status: 0,
        stdout: JSON.stringify({ providers: [], next_page_token: "next" }),
      };
      const run = vi
        .fn<RunProviderCommand>()
        .mockReturnValueOnce({
          status: 0,
          stdout:
            "Name: local-provider\nType: local-profile\nCredential keys: API_KEY\nConfig keys: <none>",
        })
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(
          repeat
            ? first
            : {
                status: 0,
                stdout: JSON.stringify({
                  providers: [
                    {
                      name: "local-provider",
                      credential_keys: ["API_KEY"],
                      credential_expires_at_ms: { API_KEY: 123 },
                    },
                  ],
                  next_page_token: "",
                }),
              },
        );
      const result = await createCliOpenShellProviderAdapter({ run }).getProvider({
        target: { kind: "named", gatewayName: "selected" },
        providerName: "local-provider",
        includeCredentialExpirations: true,
      });
      expect(result).toMatchObject(
        repeat ? { ok: false } : { ok: true, value: { credentialExpiresAtMs: { API_KEY: 123 } } },
      );
      expect(run.mock.calls[2]?.[0]).toEqual([
        "provider",
        "list",
        "-g",
        "selected",
        "--page-size",
        "1000",
        "--page-token",
        "next",
        "--output",
        "json",
      ]);
      expect(run).toHaveBeenCalledTimes(3);
    },
  );
});
