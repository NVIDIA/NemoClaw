// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ChannelManifest } from "./index";
import { ChannelManifestRegistry, createChannelManifestRegistry } from "./index";

function makeManifest(
  id: string,
  displayName: string,
  supportedAgents: ChannelManifest["supportedAgents"],
): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName,
    supportedAgents,
    auth: {
      mode: "token-paste",
    },
    inputs: [],
    credentials: [],
    policyPresets: [id],
    render: [],
    state: {},
    hooks: [],
  };
}

const TELEGRAM_MANIFEST = makeManifest("telegram", "Telegram", ["openclaw", "hermes"]);
const WECHAT_MANIFEST = makeManifest("wechat", "WeChat", ["openclaw"]);

describe("ChannelManifestRegistry", () => {
  it("registers, retrieves, and lists manifests in memory", () => {
    const registry = createChannelManifestRegistry();

    registry.register(TELEGRAM_MANIFEST);

    expect(registry.get("telegram")).toBe(TELEGRAM_MANIFEST);
    expect(registry.get("TELEGRAM")).toBeUndefined();
    expect(registry.list()).toEqual([TELEGRAM_MANIFEST]);
  });

  it("rejects duplicate channel ids", () => {
    expect(
      () => new ChannelManifestRegistry([TELEGRAM_MANIFEST, TELEGRAM_MANIFEST]),
    ).toThrow("Duplicate channel manifest id 'telegram'");
  });

  it("filters available manifests by agent and non-empty platform support lists", () => {
    const registry = new ChannelManifestRegistry([TELEGRAM_MANIFEST, WECHAT_MANIFEST]);

    expect(registry.listAvailable().map((manifest) => manifest.id)).toEqual([
      "telegram",
      "wechat",
    ]);
    expect(registry.listAvailable({ agent: "hermes" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
    ]);
    expect(
      registry.listAvailable({ agent: "openclaw", supportedChannelIds: ["wechat"] }).map(
        (manifest) => manifest.id,
      ),
    ).toEqual(["wechat"]);
    expect(
      registry.listAvailable({ supportedChannelIds: [] }).map((manifest) => manifest.id),
    ).toEqual(["telegram", "wechat"]);
  });
});
