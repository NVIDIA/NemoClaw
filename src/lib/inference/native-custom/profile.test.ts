// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { prepareNativeCustomProfile } from "./profile";

const publicLookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

describe("native custom endpoint profile", () => {
  it("binds one selected API and credential to the canonical host and checked addresses (#12636)", async () => {
    const prepared = await prepareNativeCustomProfile({
      sandboxName: "sandbox",
      provider: "compatible-endpoint",
      endpointUrl: "https://API.example.com:443/v1/",
      api: "openai-completions",
      lookup: publicLookup,
    });
    expect(prepared).toMatchObject({
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
      credentialEnv: "COMPATIBLE_API_KEY",
      profile: {
        credentials: [{ env_vars: ["COMPATIBLE_API_KEY"], auth_style: "bearer" }],
        endpoints: [
          {
            host: "api.example.com",
            port: 443,
            allowed_ips: ["8.8.8.8"],
            rules: [
              { allow: { method: "GET", path: "/v1/models" } },
              { allow: { method: "POST", path: "/v1/chat/completions" } },
            ],
          },
        ],
      },
    });
    const equivalent = await prepareNativeCustomProfile({
      sandboxName: "sandbox",
      provider: "compatible-endpoint",
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
      lookup: publicLookup,
    });
    const responses = await prepareNativeCustomProfile({
      sandboxName: "sandbox",
      provider: "compatible-endpoint",
      endpointUrl: "https://api.example.com/v1",
      api: "openai-responses",
      lookup: publicLookup,
    });
    expect([
      prepared.profile.id === equivalent.profile.id,
      prepared.profile.id === responses.profile.id,
      prepared.providerName.length <= 63,
    ]).toEqual([true, false, true]);
  });

  it("preserves admitted HTTP and the Anthropic header without broadening paths (#12636)", async () => {
    const prepared = await prepareNativeCustomProfile({
      sandboxName: "sandbox",
      provider: "compatible-anthropic-endpoint",
      endpointUrl: "http://api.example.com/tenant",
      api: "anthropic-messages",
      lookup: publicLookup,
    });
    expect(prepared.profile).toMatchObject({
      credentials: [
        {
          env_vars: ["COMPATIBLE_ANTHROPIC_API_KEY"],
          auth_style: "header",
          header_name: "x-api-key",
        },
      ],
      endpoints: [
        {
          port: 80,
          rules: [
            { allow: { method: "GET", path: "/tenant/v1/models" } },
            { allow: { method: "POST", path: "/tenant/v1/messages" } },
          ],
        },
      ],
    });
  });

  it.each([
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1?key=secret",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/%0a",
    "https://api.example.com/*",
    "http://127.0.0.1:11434/v1",
    "http://169.254.169.254/v1",
  ])("rejects endpoint %s before returning a profile (#12636)", async (endpointUrl) => {
    await expect(
      prepareNativeCustomProfile({
        sandboxName: "sandbox",
        provider: "compatible-endpoint",
        endpointUrl,
        api: "openai-completions",
        lookup: publicLookup,
      }),
    ).rejects.toThrow();
  });

  it("rejects a mixed public and private DNS answer (#12636)", async () => {
    await expect(
      prepareNativeCustomProfile({
        sandboxName: "sandbox",
        provider: "compatible-endpoint",
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
        lookup: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/private|internal/);
  });

  it("requires exact operator trust for private hosted addresses (#12636)", async () => {
    const lookup = async () => [{ address: "10.2.3.4", family: 4 }];
    const input = {
      sandboxName: "sandbox",
      provider: "compatible-endpoint" as const,
      endpointUrl: "https://inference.example.com/v1",
      api: "openai-completions" as const,
      lookup,
    };
    await expect(prepareNativeCustomProfile(input)).rejects.toThrow(/private|internal/);
    const accepted = await prepareNativeCustomProfile({
      ...input,
      trustedPrivateHosts: ["inference.example.com"],
    });
    expect(accepted.profile.endpoints[0].allowed_ips).toEqual(["10.2.3.4"]);
  });

  it("rejects unsupported API selection before DNS (#12636)", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(
      prepareNativeCustomProfile({
        sandboxName: "sandbox",
        provider: "compatible-endpoint",
        endpointUrl: "https://api.example.com/v1",
        api: "unknown",
        lookup,
      }),
    ).rejects.toThrow(/API/);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("custom provider credential isolation (#12636)", () => {
  it("shares canonical profile security identity while separating sandbox credential ownership", async () => {
    const input = {
      provider: "compatible-endpoint" as const,
      endpointUrl: "https://api.example.com/v1",
      api: "openai-completions",
      lookup: publicLookup,
    };
    const alpha = await prepareNativeCustomProfile({ ...input, sandboxName: "alpha" });
    const beta = await prepareNativeCustomProfile({ ...input, sandboxName: "beta" });
    expect(alpha.profile).toEqual(beta.profile);
    expect(alpha.providerName).not.toBe(beta.providerName);
    expect(
      (await prepareNativeCustomProfile({ ...input, sandboxName: "alpha" })).providerName,
    ).toBe(alpha.providerName);
  });
});
