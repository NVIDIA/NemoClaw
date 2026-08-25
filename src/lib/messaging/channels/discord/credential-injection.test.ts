// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { discordManifest } from "./manifest";

type PolicyEndpoint = {
  readonly host?: string;
  readonly protocol?: string;
  readonly credential_binding?: { readonly provider?: string };
};

describe("Discord credential injection", () => {
  it("applies the credential-binding preset before the sandbox process starts", () => {
    expect(discordManifest.policyPresets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "discord", requiredAtCreate: true }),
      ]),
    );
  });

  it("lets OpenClaw read the injected token without persisting a canonical placeholder", () => {
    const openClawRender = discordManifest.render.find(
      (render) => render.id === "discord-openclaw-channel",
    );
    const hermesRender = discordManifest.render.find(
      (render) => render.id === "discord-hermes-env",
    );

    expect(JSON.stringify(openClawRender)).not.toContain("credential.discordBotToken.placeholder");
    expect(JSON.stringify(hermesRender)).toContain("credential.discordBotToken.placeholder");
  });

  it("binds every OpenClaw Discord credential route to the sandbox provider", () => {
    const parsed = YAML.parse(
      readFileSync(new URL("./policy/openclaw.yaml", import.meta.url), "utf8"),
    ) as {
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
        (endpoint) => endpoint.credential_binding?.provider === "{sandboxName}-discord-bridge",
      ),
    ).toBe(true);
  });
});
