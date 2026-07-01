// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BUILT_IN_CHANNEL_MANIFESTS } from "../channels";
import type { ChannelManifest } from "../manifest";
import { createBuiltInMessagingCatalog, createMessagingCatalog } from "./index";

const demoManifest = {
  schemaVersion: 1,
  id: "demo",
  displayName: "Demo",
  supportedAgents: ["openclaw"],
  auth: { mode: "none" },
  inputs: [],
  credentials: [],
  policyPresets: ["demo-policy", { name: "demo-extra-policy" }],
  render: [],
  hooks: [],
} as const satisfies ChannelManifest;

describe("MessagingCatalog", () => {
  it("assembles built-in messaging dependencies behind one boundary", () => {
    const catalog = createBuiltInMessagingCatalog();
    const builtInIds = BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id);

    expect(catalog.manifests.map((manifest) => manifest.id)).toEqual(builtInIds);
    expect(catalog.manifestRegistry.list().map((manifest) => manifest.id)).toEqual(builtInIds);
    expect(catalog.hookRegistry.listIds()).toContain("common.staticOutputs");
    expect(catalog.renderTemplateResolver("unknown.reference", { inputs: [] })).toBeUndefined();
    expect(catalog.policySources).toContainEqual({
      channelId: "telegram",
      presetName: "telegram",
    });
  });

  it("builds custom catalogs from supplied manifests, hooks, resolver, and policy sources", () => {
    const hookHandler = () => ({ outputs: {} });
    const renderTemplateResolver = () => ({ matched: true, value: "resolved" }) as const;
    const catalog = createMessagingCatalog({
      manifests: [demoManifest],
      hookRegistrations: [{ id: "demo.hook", handler: hookHandler }],
      renderTemplateResolver,
      policySources: [{ channelId: "demo", presetName: "demo-policy" }],
    });

    expect(catalog.manifestRegistry.get("demo")).toBe(demoManifest);
    expect(catalog.hookRegistry.require("demo.hook")).toBe(hookHandler);
    expect(catalog.renderTemplateResolver("demo.reference", { inputs: [] })).toEqual({
      matched: true,
      value: "resolved",
    });
    expect(catalog.policySources).toEqual([{ channelId: "demo", presetName: "demo-policy" }]);
  });

  it("keeps manifest id validation at the catalog boundary", () => {
    expect(() =>
      createMessagingCatalog({
        manifests: [demoManifest, demoManifest],
      }).manifestRegistry.list(),
    ).toThrow("Duplicate channel manifest id 'demo'");
  });
});
