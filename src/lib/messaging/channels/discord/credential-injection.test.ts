// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { discordManifest } from "./manifest";
import { loadMessagingChannelPolicyPreset } from "../policy";

type PolicyEndpoint = {
  readonly host?: string;
  readonly protocol?: string;
  readonly credential_binding?: { readonly provider?: string };
};

describe("Discord placeholder routing", () => {
  it("applies the credential-binding preset before the sandbox process starts", () => {
    expect(discordManifest.policyPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "discord", requiredAtCreate: true }),
      ]),
    );
  });

  it("omits the OpenClaw token field while preserving the Hermes placeholder", () => {
    const openClawRender = discordManifest.render.find(
      (render) => render.id === "discord-openclaw-channel",
    );
    const hermesRender = discordManifest.render.find(
      (render) => render.id === "discord-hermes-env",
    );

    expect(JSON.stringify(openClawRender)).not.toContain("credential.discordBotToken.placeholder");
    expect(JSON.stringify(hermesRender)).toContain("credential.discordBotToken.placeholder");
  });

  it("binds every OpenClaw Discord credential endpoint to the sandbox provider", () => {
    const content = loadMessagingChannelPolicyPreset("discord", {
      agent: "openclaw",
      sandboxName: "discord-proof",
    });
    expect(content).not.toBeNull();
    const parsed = YAML.parse(content!) as {
      network_policies?: Record<string, { endpoints?: PolicyEndpoint[] }>;
    };
    const endpoints = Object.values(parsed.network_policies ?? {}).flatMap(
      (policy) => policy.endpoints ?? [],
    );
    const credentialRoutes = endpoints.filter(
      (endpoint) =>
        endpoint.host === "discord.com" ||
        endpoint.host === "gateway.discord.gg" ||
        endpoint.host === "*.discord.gg",
    );

    expect(credentialRoutes).toHaveLength(3);
    expect(credentialRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: "discord.com", protocol: "rest" }),
        expect.objectContaining({ host: "gateway.discord.gg", protocol: "websocket" }),
        expect.objectContaining({ host: "*.discord.gg", protocol: "websocket" }),
      ]),
    );
    expect(
      credentialRoutes.every(
        (endpoint) => endpoint.credential_binding?.provider === "discord-proof-discord-bridge",
      ),
    ).toBe(true);
  });
});
