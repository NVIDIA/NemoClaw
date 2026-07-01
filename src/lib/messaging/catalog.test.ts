// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  BUILT_IN_CHANNEL_MANIFESTS,
  BUILT_IN_CHANNEL_MODULES,
  createBuiltInMessagingCatalog,
  createMessagingCatalog,
  defineMessagingChannel,
} from "./index";
import type { ChannelManifest } from "./manifest";

describe("MessagingCatalog", () => {
  it("exposes built-in manifests through the catalog boundary", () => {
    const catalog = createBuiltInMessagingCatalog();

    expect(catalog.listChannels().map((module) => module.id)).toEqual(
      BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id),
    );
    expect(catalog.listChannels()).toEqual(BUILT_IN_CHANNEL_MODULES);
    expect(
      catalog
        .createManifestRegistry()
        .list()
        .map((manifest) => manifest.id),
    ).toEqual(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id));
    expect(catalog.listAvailable({ agent: "openclaw" }).map((module) => module.id)).toEqual(
      BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) =>
        manifest.supportedAgents.includes("openclaw"),
      ).map((manifest) => manifest.id),
    );
  });

  it("creates built-in hook registries and workflow planners", () => {
    const catalog = createBuiltInMessagingCatalog();
    const hookIds = catalog.createHookRegistry().listIds();

    expect(hookIds).toContain("common.tokenPaste");
    for (const manifest of BUILT_IN_CHANNEL_MANIFESTS) {
      for (const hook of manifest.hooks) {
        expect(hookIds, `${manifest.id}.${hook.handler}`).toContain(hook.handler);
      }
    }
    expect(catalog.createWorkflowPlanner()).toBeTruthy();
  });

  it("resolves built-in templates through channel modules", () => {
    const catalog = createBuiltInMessagingCatalog();

    expect(catalog.createTemplateResolver()("proxyUrl", { inputs: [], env: {} })?.value).toBe(
      "http://10.200.0.1:3128",
    );
  });

  it("derives agent-aware policy keys from current manifests", () => {
    const catalog = createBuiltInMessagingCatalog();

    expect(catalog.policyKeysForChannel("telegram", { agent: "openclaw" })).toEqual([
      "telegram_bot",
    ]);
    expect(catalog.policyKeysForChannel("telegram", { agent: "hermes" })).toEqual(["telegram"]);
    expect(
      catalog
        .listPolicyContributions({ agent: "openclaw" })
        .find((contribution) => contribution.preset === "slack"),
    ).toMatchObject({
      preset: "slack",
      requiredAtCreate: true,
      policyKeys: ["slack"],
    });
    expect(
      Object.keys(
        YAML.parse(requirePolicy(catalog.loadPolicyPreset("telegram", { agent: "openclaw" })))
          .network_policies,
      ),
    ).toEqual(["telegram_bot"]);
    expect(
      Object.keys(
        YAML.parse(requirePolicy(catalog.loadPolicyPreset("telegram", { agent: "hermes" })))
          .network_policies,
      ),
    ).toEqual(["telegram"]);
  });

  it("rejects invalid or duplicate channel modules", () => {
    const manifest = minimalManifest("example");
    const first = defineMessagingChannel({
      kind: "nemoclaw.messaging.channel",
      apiVersion: 1,
      id: "example",
      manifest: () => manifest,
    });
    const second = defineMessagingChannel({
      kind: "nemoclaw.messaging.channel",
      apiVersion: 1,
      id: "example",
      manifest: () => manifest,
    });

    expect(() => createMessagingCatalog({ modules: [first, second] })).toThrow(
      "Duplicate messaging channel module id 'example'",
    );
  });
});

function minimalManifest(id: string): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: "Example",
    supportedAgents: ["openclaw"],
    auth: { mode: "none" },
    inputs: [],
    credentials: [],
    render: [],
    hooks: [],
  };
}

function requirePolicy(content: string | null): string {
  expect(content).toBeTruthy();
  return content ?? "";
}
