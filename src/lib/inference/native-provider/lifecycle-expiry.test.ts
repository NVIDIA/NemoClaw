// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { verifyNativeProviderAttachment } from "./lifecycle";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";

it.each(["never", "future", "expired", "missing", "invalid", "identity", "revision"])(
  "binds credential expiry to the exact provider: %s",
  async (scenario) => {
    const metadata = {
      name: "local-provider",
      type: "local-profile",
      credentialKeys: ["API_KEY"],
      configKeys: [],
      revision: { id: "owned", resourceVersion: 1 },
      ...(scenario === "missing"
        ? {}
        : {
            credentialExpiresAtMs: {
              API_KEY:
                scenario === "expired"
                  ? 1
                  : scenario === "invalid"
                    ? -1
                    : scenario === "future"
                      ? Date.now() + 60_000
                      : 0,
            },
          }),
    };
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ...metadata,
          revision: {
            id: scenario === "identity" ? "replacement" : "owned",
            resourceVersion: scenario === "revision" ? 2 : 1,
          },
        },
      });
    const adapter = {
      getProvider,
      listProviderAttachments: vi.fn(async () => ({
        ok: true,
        value: { names: ["local-provider"] },
      })),
    } as unknown as OpenShellProviderAdapter;
    const result = verifyNativeProviderAttachment({
      profile: {
        providerName: "local-provider",
        profileId: "local-profile",
        credentialEnv: "API_KEY",
        label: "host-local",
        profilePath: "",
      },
      adapter,
      target: { kind: "named", gatewayName: "selected" },
      sandboxName: "sandbox",
      expected: {
        schemaVersion: 1,
        profileId: "local-profile",
        providerName: "local-provider",
        providerId: "owned",
      },
      requireUnexpiredCredential: true,
    });
    const observation = await result.then(
      (value) => ({ providerId: value.providerId }),
      (error: Error) => ({ error: error.message }),
    );
    expect(observation).toEqual(
      scenario === "never" || scenario === "future"
        ? { providerId: "owned" }
        : { error: expect.stringMatching(/credential/) },
    );
    expect(getProvider).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ includeCredentialExpirations: true }),
    );
    expect(getProvider).toHaveBeenCalledTimes(2);
  },
);
