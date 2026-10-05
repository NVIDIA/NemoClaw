// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { prepareNativeCompatibleEndpoint } from "./endpoint";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("native compatible endpoint preparation", () => {
  it("binds the profile identity to the endpoint and API", async () => {
    const input = { endpointUrl: "https://api.example.com/v1", api: "openai-completions", lookup };
    const completions = await prepareNativeCompatibleEndpoint(input);
    const responses = await prepareNativeCompatibleEndpoint({ ...input, api: "openai-responses" });
    const other = await prepareNativeCompatibleEndpoint({
      ...input,
      endpointUrl: "https://other.example.com/v1",
    });
    expect(completions.profileId).not.toBe(responses.profileId);
    expect(completions.profileId).not.toBe(other.profileId);
    expect(completions.inferencePath).toBe("/v1/chat/completions");
    expect(responses.inferencePath).toBe("/v1/responses");
    expect(completions.addresses).toEqual(["93.184.216.34"]);
  });

  it("preserves the Anthropic base path and native API", async () => {
    const result = await prepareNativeCompatibleEndpoint({
      endpointUrl: "https://api.example.com/custom/v1/messages",
      api: "anthropic-messages",
      lookup,
    });
    expect(result.endpoint).toBe("https://api.example.com/custom");
    expect(result.inferencePath).toBe("/custom/v1/messages");
  });

  it.each([
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret",
    "https://example.com/v1#secret",
    "not-a-url",
    "https://example.com/*",
    "https://example.com/a%2fb",
  ])("rejects unsafe endpoint %s before DNS", async (endpointUrl) => {
    const resolve = vi.fn(lookup);
    await expect(
      prepareNativeCompatibleEndpoint({ endpointUrl, api: "openai-completions", lookup: resolve }),
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("rejects a private DNS answer", async () => {
    await expect(
      prepareNativeCompatibleEndpoint({
        endpointUrl: "https://api.example.com/v1",
        api: "openai-completions",
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow("network validation");
  });

  it("rejects unsupported APIs before DNS", async () => {
    const resolve = vi.fn(lookup);
    await expect(
      prepareNativeCompatibleEndpoint({
        endpointUrl: "https://api.example.com/v1",
        api: "unknown",
        lookup: resolve,
      }),
    ).rejects.toThrow("Unsupported");
    expect(resolve).not.toHaveBeenCalled();
  });
});
