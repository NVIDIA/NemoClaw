// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import { hostedNativeProvider } from "./hosted";
import { requireHostedProviderAttachment } from "./hosted-attachment";
import { boundHermesNativeProfile, withHermesNativeProfile } from "./hermes-profile";
import { prepareHostedNativeProvider } from "./setup";
import { buildNativeHostedSandboxPolicy } from "./network-policy";
import { nativeHostedAgentConfig } from "./agent-config";

const endpoint = "https://staging.nous.example/api/v1";
const definition = {
  ...hostedNativeProvider("hermes-provider", endpoint)!,
  allowedIps: ["8.8.8.8"],
};
const receipt = {
  schemaVersion: 1 as const,
  profileId: definition.profileId,
  providerName: definition.providerName,
  providerId: "identity",
  endpointUrl: endpoint,
  allowedIps: definition.allowedIps,
};

describe("Hermes authenticated endpoint binding", () => {
  it("binds the receipt, profile host, request paths and agent configuration to the returned endpoint", () => {
    expect(requireHostedProviderAttachment(receipt, "hermes-provider")).toEqual(receipt);
    expect(hostedNativeProvider("hermes-provider", `${endpoint}/`)!.providerName).toBe(
      definition.providerName,
    );
    const profile = YAML.parse(boundHermesNativeProfile(definition));
    expect(profile.id).toBe(definition.profileId);
    expect(profile.endpoints).toEqual([
      {
        host: "staging.nous.example",
        port: 443,
        allowed_ips: ["8.8.8.8"],
        protocol: "rest",
        enforcement: "enforce",
        rules: [
          { allow: { method: "GET", path: "/api/v1/models" } },
          { allow: { method: "POST", path: "/api/v1/chat/completions" } },
        ],
      },
    ]);
    expect(profile.credentials[0].env_vars).toEqual(["OPENAI_API_KEY"]);
    expect(nativeHostedAgentConfig("hermes-provider", endpoint)?.apiKey).toBe(
      "openshell:resolve:env:OPENAI_API_KEY",
    );
    expect(() =>
      requireHostedProviderAttachment(
        { ...receipt, endpointUrl: "https://different.example/v1" },
        "hermes-provider",
      ),
    ).toThrow("Invalid native hosted");
  });

  it.each([
    "http://staging.nous.example/v1",
    "https://user:secret@staging.nous.example/v1",
    "https://staging.nous.example/v1?token=secret",
    "https://staging.nous.example/v1#fragment",
    "https://inference.local/v1",
  ])("rejects unsafe returned endpoint %s before profile registration", async (endpointUrl) => {
    const importProviderProfile = vi.fn();
    await expect(
      prepareHostedNativeProvider({
        provider: "hermes-provider",
        gatewayName: "gateway",
        endpointUrl,
        credentialValue: "host-secret",
        adapter: { importProviderProfile } as unknown as OpenShellProviderAdapter,
        readAuthority: () => undefined,
        writeAuthority: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(importProviderProfile).not.toHaveBeenCalled();
  });

  it("rejects a private DNS answer before importing a profile or handing off a credential", async () => {
    const importProviderProfile = vi.fn();
    await expect(
      prepareHostedNativeProvider({
        provider: "hermes-provider",
        gatewayName: "gateway",
        endpointUrl: endpoint,
        credentialValue: "host-secret",
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
        adapter: { importProviderProfile } as unknown as OpenShellProviderAdapter,
        readAuthority: () => undefined,
        writeAuthority: vi.fn(),
      }),
    ).rejects.toThrow("unsafe inference endpoint");
    expect(importProviderProfile).not.toHaveBeenCalled();
  });

  it("passes the API key only to the restricted provider and keeps returned state credential-free", async () => {
    let present = false;
    const createProvider = vi.fn<OpenShellProviderAdapter["createProvider"]>(async () => {
      present = true;
      return { ok: true };
    });
    const importProviderProfile = vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(
      async ({ profilePath }) => {
        expect(YAML.parse(fs.readFileSync(profilePath, "utf8")).id).toBe(definition.profileId);
        expect(YAML.parse(fs.readFileSync(profilePath, "utf8")).endpoints[0].allowed_ips).toEqual([
          "8.8.8.8",
        ]);
        return { ok: true };
      },
    );
    const adapter = {
      createProvider,
      importProviderProfile,
      ensureProviderPolicyComposition: async () => ({ ok: true, value: undefined }),
      getProvider: async () =>
        present
          ? {
              ok: true,
              value: {
                name: definition.providerName,
                type: definition.profileId,
                credentialKeys: ["OPENAI_API_KEY"],
                configKeys: [],
                revision: { id: "identity", resourceVersion: 1 },
              },
            }
          : { ok: false, error: { kind: "command", reason: "not_found", message: "absent" } },
    } as unknown as OpenShellProviderAdapter;
    const writeAuthority = vi.fn();
    const result = await prepareHostedNativeProvider({
      provider: "hermes-provider",
      gatewayName: "gateway",
      endpointUrl: endpoint,
      credentialValue: "host-secret",
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      adapter,
      readAuthority: () => undefined,
      writeAuthority,
    });
    expect(result).toEqual(receipt);
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: definition.providerName,
        credentials: [{ name: "OPENAI_API_KEY", value: "host-secret" }],
        config: [],
      }),
    );
    expect(JSON.stringify(writeAuthority.mock.calls)).not.toContain("host-secret");
    expect(fs.existsSync(importProviderProfile.mock.calls[0][0].profilePath)).toBe(false);
  });

  it("keeps approved pins on restart instead of accepting rebound DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.1", family: 4 }]);
    const importProviderProfile = vi.fn<OpenShellProviderAdapter["importProviderProfile"]>(
      async ({ profilePath }) => {
        expect(YAML.parse(fs.readFileSync(profilePath, "utf8")).endpoints[0].allowed_ips).toEqual([
          "8.8.8.8",
        ]);
        return {
          ok: false,
          error: {
            kind: "command",
            reason: "profile_incompatible",
            message: "refuse altered boundary",
          },
        };
      },
    );
    await expect(
      prepareHostedNativeProvider({
        provider: "hermes-provider",
        gatewayName: "gateway",
        endpointUrl: endpoint,
        credentialValue: "host-secret",
        lookup,
        adapter: { importProviderProfile } as unknown as OpenShellProviderAdapter,
        readAuthority: () => receipt,
        writeAuthority: vi.fn(),
      }),
    ).rejects.toThrow("conflicts");
    expect(lookup).not.toHaveBeenCalled();
    const policy = YAML.parse(
      buildNativeHostedSandboxPolicy("network_policies: {}", definition.providerName, receipt),
    );
    expect(policy.network_policies.native_hosted_inference.endpoints[0].allowed_ips).toEqual([
      "8.8.8.8",
    ]);
  });

  it.each([undefined, [], ["10.0.0.1"], ["0.0.0.0/0"], ["8.8.8.8", "127.0.0.1"]])(
    "rejects missing or unsafe durable pins %j",
    (allowedIps) => {
      expect(() =>
        requireHostedProviderAttachment({ ...receipt, allowedIps }, "hermes-provider"),
      ).toThrow("Invalid native hosted");
    },
  );

  it("removes temporary profile material when OpenShell rejects an import", async () => {
    let importedPath = "";
    await expect(
      withHermesNativeProfile(definition, (profilePath) => {
        importedPath = profilePath;
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(fs.existsSync(importedPath)).toBe(false);
  });
});
