// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyMessagingAgentRenderToObject } from "./build/messaging-build-applier.mts";
import { allowRenderedOpenClawPlugins } from "./openclaw-plugin-allow";

describe("allowRenderedOpenClawPlugins", () => {
  it("adds an enabled rendered plugin to the existing allowlist (#8975)", () => {
    const config = { plugins: { allow: ["nemoclaw"], entries: {} } };

    allowRenderedOpenClawPlugins(config, [
      { path: "plugins.entries.telegram", value: { enabled: true } },
    ]);

    expect(config.plugins.allow).toEqual(["nemoclaw", "telegram"]);
  });

  it("does not allow a rendered plugin that remains disabled (#8975)", () => {
    const config = { plugins: { allow: ["nemoclaw"], entries: {} } };

    allowRenderedOpenClawPlugins(config, [
      { path: "plugins.entries.telegram", value: { enabled: false } },
    ]);

    expect(config.plugins.allow).toEqual(["nemoclaw"]);
  });

  it("rejects a non-array OpenClaw plugin allowlist (#8975)", () => {
    const config = { plugins: { allow: "nemoclaw", entries: {} } };

    expect(() =>
      allowRenderedOpenClawPlugins(config, [
        { path: "plugins.entries.telegram", value: { enabled: true } },
      ]),
    ).toThrow("OpenClaw plugins.allow must be an array.");
  });

  it("adds plugins only from renders for the selected OpenClaw config target (#8975)", () => {
    const config = { plugins: { allow: ["nemoclaw"], entries: {} } };
    const plan = {
      schemaVersion: 1 as const,
      sandboxName: "test-sandbox",
      agent: "openclaw" as const,
      channels: [{ channelId: "telegram", active: true, disabled: false }],
      credentialBindings: [],
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw" as const,
          target: "openclaw.json",
          kind: "json-fragment" as const,
          path: "plugins.entries.telegram",
          value: { enabled: true },
        },
        {
          channelId: "telegram",
          agent: "openclaw" as const,
          target: "other.json",
          kind: "json-fragment" as const,
          path: "plugins.entries.other-plugin",
          value: { enabled: true },
        },
      ],
      buildSteps: [],
    };

    applyMessagingAgentRenderToObject(config, plan, "openclaw.json");

    expect(config.plugins.allow).toEqual(["nemoclaw", "telegram"]);
    expect(config.plugins.entries).toEqual({ telegram: { enabled: true } });
  });
});
