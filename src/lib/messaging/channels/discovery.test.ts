// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest } from "../manifest";
import {
  assertMessagingChannelDiscovery,
  discoverMessagingChannelModules,
  discoverMessagingChannelModulesFromDirectory,
} from "./discovery";
import { defineMessagingChannel, validateMessagingChannelModule } from "./module";

describe("messaging channel discovery", () => {
  it("extracts modules from direct, named, and default exports in stable order", () => {
    const alpha = channelModule("alpha");
    const beta = channelModule("beta");
    const gamma = channelModule("gamma");

    const result = discoverMessagingChannelModules(
      [
        { id: "gamma", source: "channels/gamma", load: () => ({ gammaChannelModule: gamma }) },
        { id: "alpha", source: "channels/alpha", load: () => alpha },
        { id: "beta", source: "channels/beta", load: () => ({ default: beta }) },
      ],
      { order: ["alpha", "beta", "gamma"] },
    );

    expect(result.issues).toEqual([]);
    expect(assertMessagingChannelDiscovery(result).map((module) => module.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("reports friendly errors for missing exports and duplicate channel ids", () => {
    const result = discoverMessagingChannelModules([
      { id: "empty", source: "channels/empty", load: () => ({}) },
      { id: "alpha-a", source: "channels/alpha-a", load: () => channelModule("alpha") },
      { id: "alpha-b", source: "channels/alpha-b", load: () => channelModule("alpha") },
    ]);

    expect(result.issues.map((issue) => issue.message)).toEqual([
      "Messaging channel 'empty' must export a MessagingChannelModule from its entrypoint.",
      "Duplicate messaging channel module id 'alpha'.",
    ]);
    expect(() => assertMessagingChannelDiscovery(result)).toThrow(
      "Messaging channel discovery failed.",
    );
  });

  it("discovers directory entries through injectable readers and loaders", () => {
    const result = discoverMessagingChannelModulesFromDirectory("/channels", {
      readChannelDirectories: () => ["beta", "alpha"],
      loadModule: (entrypoint) => {
        const id = entrypoint.includes("alpha") ? "alpha" : "beta";
        return { default: channelModule(id) };
      },
      order: ["alpha", "beta"],
    });

    expect(result.issues).toEqual([]);
    expect(result.modules.map((module) => module.id)).toEqual(["alpha", "beta"]);
  });

  it("reports directory loader failures with the channel source", () => {
    const result = discoverMessagingChannelModulesFromDirectory("/channels", {
      readChannelDirectories: () => ["broken"],
      loadModule: () => {
        throw new Error("boom");
      },
    });

    expect(result.issues).toEqual([
      expect.objectContaining({
        channelId: "broken",
        source: "/channels/broken",
        message: "Messaging channel 'broken' failed to load: boom",
      }),
    ]);
  });

  it("validates the module and manifest shape without executing lazy extension factories", () => {
    const module = channelModule("alpha", {
      manifest: { id: "beta" },
      hooks: () => {
        throw new Error("should stay lazy during discovery");
      },
    });

    const result = discoverMessagingChannelModules([
      { id: "alpha", source: "channels/alpha", load: () => module },
    ]);

    expect(result.issues.map((issue) => issue.message)).toEqual([
      "Channel module id 'alpha' must match manifest id 'beta'.",
    ]);
  });

  it("can evaluate extension factories when explicitly requested", () => {
    const module = channelModule("alpha", {
      hooks: () => [{ id: "alpha-hook", handler: async () => ({}) }],
      templates: () => [
        {
          namespace: "alpha",
          resolve: () => undefined,
        },
      ],
      policies: () => [
        {
          preset: "alpha",
          source: "policy/openclaw.yaml",
        },
      ],
    });

    expect(validateMessagingChannelModule(module, { evaluateExtensions: true })).toEqual([]);
  });
});

function channelModule(
  id: string,
  overrides: {
    readonly manifest?: Partial<ChannelManifest>;
    readonly hooks?: ReturnType<typeof defineMessagingChannel>["hooks"];
    readonly templates?: ReturnType<typeof defineMessagingChannel>["templates"];
    readonly policies?: ReturnType<typeof defineMessagingChannel>["policies"];
  } = {},
) {
  const manifest = minimalManifest(id);
  return defineMessagingChannel({
    kind: "nemoclaw.messaging.channel",
    apiVersion: 1,
    id,
    manifest: () => ({ ...manifest, ...overrides.manifest }),
    ...(overrides.hooks ? { hooks: overrides.hooks } : {}),
    ...(overrides.templates ? { templates: overrides.templates } : {}),
    ...(overrides.policies ? { policies: overrides.policies } : {}),
  });
}

function minimalManifest(id: string): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    supportedAgents: ["openclaw"],
    auth: { mode: "none" },
    inputs: [],
    credentials: [],
    render: [],
    hooks: [],
  };
}
