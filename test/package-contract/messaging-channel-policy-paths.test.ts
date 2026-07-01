// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { createMessagingCatalog } from "../../dist/lib/messaging/catalog";
import { defineMessagingChannel } from "../../dist/lib/messaging/channels/module";
import type { ChannelManifest } from "../../dist/lib/messaging/manifest";

describe("compiled messaging catalog policy paths", () => {
  it("loads channel-owned policy YAML when compiled modules point at dist paths", () => {
    const manifest = minimalManifest("slack");
    const module = defineMessagingChannel({
      kind: "nemoclaw.messaging.channel",
      apiVersion: 1,
      id: "slack",
      manifest: () => ({
        ...manifest,
        policyPresets: ["slack"],
      }),
      policies: () => [
        {
          preset: "slack",
          agent: "openclaw",
          sourceRoot: path.join(
            import.meta.dirname,
            "..",
            "..",
            "dist",
            "lib",
            "messaging",
            "channels",
            "slack",
          ),
          source: "policy/openclaw.yaml",
        },
      ],
    });

    const catalog = createMessagingCatalog({ modules: [module] });
    const policy = YAML.parse(
      requirePolicy(catalog.loadPolicyPreset("slack", { agent: "openclaw" })),
    );
    const hosts = policy.network_policies.slack.endpoints.map(
      (endpoint: { host?: string }) => endpoint.host,
    );

    expect(hosts).toContain("slack.com");
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
