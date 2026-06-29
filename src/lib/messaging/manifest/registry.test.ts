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
    expect(() => new ChannelManifestRegistry([TELEGRAM_MANIFEST, TELEGRAM_MANIFEST])).toThrow(
      "Duplicate channel manifest id 'telegram'",
    );
  });

  it("filters available manifests by agent and explicit channel support lists", () => {
    const registry = new ChannelManifestRegistry([TELEGRAM_MANIFEST, WECHAT_MANIFEST]);

    expect(registry.listAvailable().map((manifest) => manifest.id)).toEqual(["telegram", "wechat"]);
    expect(registry.listAvailable({ agent: "hermes" }).map((manifest) => manifest.id)).toEqual([
      "telegram",
    ]);
    expect(
      registry
        .listAvailable({ agent: "openclaw", supportedChannelIds: ["wechat"] })
        .map((manifest) => manifest.id),
    ).toEqual(["wechat"]);
  });

  it("treats an explicit empty supportedChannelIds array as deny-all", () => {
    const registry = new ChannelManifestRegistry([TELEGRAM_MANIFEST, WECHAT_MANIFEST]);

    expect(
      registry.listAvailable({ supportedChannelIds: [] }).map((manifest) => manifest.id),
    ).toEqual([]);
    expect(
      registry
        .listAvailable({ agent: "openclaw", supportedChannelIds: [] })
        .map((manifest) => manifest.id),
    ).toEqual([]);
  });

  it("treats null or undefined supportedChannelIds as no constraint", () => {
    const registry = new ChannelManifestRegistry([TELEGRAM_MANIFEST, WECHAT_MANIFEST]);

    expect(
      registry.listAvailable({ supportedChannelIds: null }).map((manifest) => manifest.id),
    ).toEqual(["telegram", "wechat"]);
    expect(
      registry.listAvailable({ supportedChannelIds: undefined }).map((manifest) => manifest.id),
    ).toEqual(["telegram", "wechat"]);
  });

  it("rejects registration when a config input declares valueDisplay keys outside validValues", () => {
    const malformed: ChannelManifest = {
      ...TELEGRAM_MANIFEST,
      id: "malformed-display",
      inputs: [
        {
          id: "bogus",
          kind: "config",
          required: false,
          validValues: ["0", "1"],
          valueDisplay: { "2": "two" },
        },
      ],
    };

    expect(() => createChannelManifestRegistry([malformed])).toThrow(
      "valueDisplay key '2' is not in validValues",
    );
  });

  it("rejects registration when a config input declares an agentApplicability not in supportedAgents", () => {
    const malformed: ChannelManifest = {
      ...TELEGRAM_MANIFEST,
      id: "malformed-agent",
      supportedAgents: ["openclaw"],
      inputs: [
        {
          id: "bogus",
          kind: "config",
          required: false,
          validValues: ["0", "1"],
          agentApplicability: ["hermes"],
        },
      ],
    };

    expect(() => createChannelManifestRegistry([malformed])).toThrow(
      "agentApplicability 'hermes' is not in supportedAgents",
    );
  });

  it("rejects registration when a secret input declares safeToPrintInDiagnostics", () => {
    const malformed = {
      ...TELEGRAM_MANIFEST,
      id: "malformed-secret",
      inputs: [
        {
          id: "leakySecret",
          kind: "secret",
          required: false,
          safeToPrintInDiagnostics: true,
        },
      ],
    } as unknown as ChannelManifest;

    expect(() => createChannelManifestRegistry([malformed])).toThrow(
      "is not kind 'config' yet declares safeToPrintInDiagnostics=true",
    );
  });

  it("rejects registration when a config input declares safeToPrintInDiagnostics without a validValues allowlist", () => {
    const malformed = {
      ...TELEGRAM_MANIFEST,
      id: "malformed-open-ended",
      inputs: [
        {
          id: "openEnded",
          kind: "config",
          required: false,
          safeToPrintInDiagnostics: true,
        },
      ],
    } as unknown as ChannelManifest;

    expect(() => createChannelManifestRegistry([malformed])).toThrow(
      "has safeToPrintInDiagnostics=true but no validValues allowlist",
    );
  });
});
