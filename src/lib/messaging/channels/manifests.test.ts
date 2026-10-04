// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { knownChannelNames } from "../../sandbox/channels";
import type { MessagingAgentId } from "../manifest";
import {
  BUILT_IN_CHANNEL_MANIFESTS,
  createBuiltInChannelManifestRegistry,
  getBuiltInRenderedConfigParser,
} from "./index";

describe("built-in channel manifests", () => {
  it("registers every known channel for supported gateway agents", () => {
    const registry = createBuiltInChannelManifestRegistry();
    const channelNames = knownChannelNames();

    expect(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => manifest.id)).toEqual(channelNames);
    expect(registry.list().map((manifest) => manifest.id)).toEqual(channelNames);
    expect(registry.listAvailable({ agent: "openclaw" }).map((manifest) => manifest.id)).toEqual(
      channelNames,
    );
    expect(registry.listAvailable({ agent: "hermes" }).map((manifest) => manifest.id)).toEqual(
      channelNames,
    );
  });

  it("keeps built-in manifests fully JSON-serializable", () => {
    expect(JSON.parse(JSON.stringify(BUILT_IN_CHANNEL_MANIFESTS))).toEqual(
      BUILT_IN_CHANNEL_MANIFESTS,
    );
  });

  it("keeps rendered config parsers aligned with built-in manifests", () => {
    expect(
      BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => [
        manifest.id,
        Boolean(getBuiltInRenderedConfigParser(manifest.id)),
      ]),
    ).toEqual(BUILT_IN_CHANNEL_MANIFESTS.map((manifest) => [manifest.id, true]));
  });

  it("limits the WhatsApp status hook to OpenClaw live health and Hermes session-location checks", () => {
    const whatsapp = BUILT_IN_CHANNEL_MANIFESTS.find((manifest) => manifest.id === "whatsapp");
    const statusHealth = whatsapp?.hooks.find((hook) => hook.id === "whatsapp-status-health");
    expect(statusHealth?.agents).toEqual(["openclaw", "hermes"]);
  });

  it("keeps rendered config parser keys limited to manifest config inputs", () => {
    const agentIds: readonly MessagingAgentId[] = ["openclaw", "hermes"];
    const secretLikePattern = /(?:token|secret|password|client_secret|client-secret)/i;
    expect(
      BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest) => {
        const configInputIds: ReadonlySet<string> = new Set(
          manifest.inputs.filter((input) => input.kind === "config").map((input) => input.id),
        );
        const parser = getBuiltInRenderedConfigParser(manifest.id);
        return agentIds.flatMap((agentId) =>
          (parser?.listConfigVisibilityKeys({ manifest, agentId, inputs: [] }) ?? [])
            .filter(
              (key) =>
                !configInputIds.has(key.inputId) ||
                secretLikePattern.test(key.envKey ?? "") ||
                secretLikePattern.test(key.target),
            )
            .map((key) => `${manifest.id}.${agentId}.${key.inputId}:${key.envKey ?? key.target}`),
        );
      }),
    ).toEqual([]);
  });
});
