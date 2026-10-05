// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import { ensureNativeCompatibleProfile, prepareNativeCompatibleProfile } from "./profile";

const input = {
  endpointUrl: "https://api.example.com/v1",
  api: "openai-completions",
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
};

describe("native compatible profile", () => {
  it("restricts credential access to validated addresses and the selected API", async () => {
    const result = await prepareNativeCompatibleProfile(input);
    expect(result.document.endpoints).toEqual([
      {
        host: "api.example.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        allowed_ips: ["93.184.216.34"],
        rules: [
          { allow: { method: "GET", path: "/v1/models" } },
          { allow: { method: "POST", path: "/v1/chat/completions" } },
        ],
      },
    ]);
    expect(result.document.credentials[0].header_name).toBe("authorization");
    const anthropic = await prepareNativeCompatibleProfile({ ...input, api: "anthropic-messages" });
    expect(anthropic.document.credentials[0].header_name).toBe("x-api-key");
    expect(anthropic.document.credentials[0].auth_style).toBe("header");
  });

  it("makes no adapter call when endpoint validation fails", async () => {
    const importProviderProfile = vi.fn();
    await expect(
      ensureNativeCompatibleProfile({
        ...input,
        endpointUrl: "https://user:secret@example.com/v1",
        adapter: { importProviderProfile },
        target: { kind: "selected" },
      }),
    ).rejects.toThrow();
    expect(importProviderProfile).not.toHaveBeenCalled();
  });

  it("refuses a conflicting live profile without an import or provider mutation", async () => {
    const prepared = await prepareNativeCompatibleProfile(input);
    const run = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: JSON.stringify({ ...prepared.document, endpoints: [] }),
      stderr: "",
    }));
    const adapter = createCliOpenShellProviderAdapter({ run });
    await expect(
      ensureNativeCompatibleProfile({ ...input, adapter, target: { kind: "selected" } }),
    ).rejects.toThrow("No provider was activated");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "provider",
      "profile",
      "export",
      prepared.profileId,
      "--output",
      "json",
    ]);
  });

  it.each([
    { path_template: "/credential/{api_key}" },
    { token_grant: { token_endpoint: "https://other.example.com/token" } },
  ])("rejects a live credential-routing extension without mutation", async (extension) => {
    const prepared = await prepareNativeCompatibleProfile(input);
    const run = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: JSON.stringify({
        ...prepared.document,
        credentials: [{ ...prepared.document.credentials[0], ...extension }],
      }),
      stderr: "",
    }));
    const adapter = createCliOpenShellProviderAdapter({ run });
    await expect(
      ensureNativeCompatibleProfile({ ...input, adapter, target: { kind: "selected" } }),
    ).rejects.toThrow("No provider was activated");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("removes the temporary profile file after import failure", async () => {
    let file = "";
    const adapter = {
      importProviderProfile: vi.fn(async (request: { profilePath: string }) => {
        file = request.profilePath;
        expect(fs.existsSync(file)).toBe(true);
        return { ok: false as const, error: { kind: "validation" as const, message: "denied" } };
      }),
    };
    await expect(
      ensureNativeCompatibleProfile({ ...input, adapter, target: { kind: "selected" } }),
    ).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});
