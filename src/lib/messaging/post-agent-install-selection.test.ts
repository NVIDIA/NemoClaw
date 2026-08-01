// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { filterEnabledPlanEntries } from "./applier/plan-filter";
import type {
  SandboxMessagingAgentRenderPlan,
  SandboxMessagingBuildStepPlan,
  SandboxMessagingChannelPlan,
  SandboxMessagingPlan,
} from "./manifest";
import {
  selectActiveMessagingChannelIds,
  selectEnabledMessagingAgentRender,
  selectEnabledPostAgentInstallBuildFiles,
} from "./post-agent-install-selection";

function channel(
  channelId: string,
  hooks: SandboxMessagingChannelPlan["hooks"] = [],
): SandboxMessagingChannelPlan {
  return {
    channelId,
    displayName: channelId,
    authMode: "none",
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks,
  };
}

function plan(overrides: Partial<SandboxMessagingPlan> = {}): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "selection-test",
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

function render(channelId: string): SandboxMessagingAgentRenderPlan {
  return {
    channelId,
    kind: "json-fragment",
    agent: "openclaw",
    target: "/sandbox/.openclaw/openclaw.json",
    path: "channels.telegram.enabled",
    value: true,
    templateRefs: [],
  };
}

function buildFile(
  channelId: string,
  outputId: string,
  hookId?: string,
): SandboxMessagingBuildStepPlan {
  return {
    channelId,
    kind: "build-file",
    hookId,
    outputId,
    required: true,
    value: "fixture",
  };
}

describe("post-agent-install messaging selection", () => {
  it("loads through Node's direct TypeScript ESM path used by image builds", () => {
    const moduleUrl = new URL("./post-agent-install-selection.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(moduleUrl)})`,
      ],
      { encoding: "utf8" },
    );

    expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
  });

  it("uses the shared enabled-channel contract and preserves canonical ordering", () => {
    const selection = plan({
      channels: [channel(" Discord "), channel(" TeLeGrAm "), channel("DISCORD")],
      disabledChannels: [" telegram "],
    });

    expect(selectActiveMessagingChannelIds(selection)).toEqual(["discord"]);
    expect(
      filterEnabledPlanEntries(selection, [
        { channelId: "DISCORD", value: "kept" },
        { channelId: "telegram", value: "disabled" },
      ]),
    ).toEqual([{ channelId: "DISCORD", value: "kept" }]);
  });

  it("matches normalized channel ids across channels, render entries, and build steps", () => {
    const selection = plan({
      channels: [
        channel(" Telegram ", [
          {
            channelId: " Telegram ",
            id: "post-install",
            phase: "post-agent-install",
            handler: "telegram.post-install",
          },
          {
            channelId: " Telegram ",
            id: "render-only",
            phase: "render",
            handler: "telegram.render",
          },
        ]),
      ],
      agentRender: [render("TELEGRAM"), render("discord")],
      buildSteps: [
        buildFile("telegram", "post-install-file", "post-install"),
        buildFile(" TELEGRAM ", "render-file", "render-only"),
        buildFile("discord", "unrelated-file"),
      ],
    });

    expect(selectEnabledMessagingAgentRender(selection).map(({ channelId }) => channelId)).toEqual([
      "TELEGRAM",
    ]);
    expect(
      selectEnabledPostAgentInstallBuildFiles(selection).map(({ outputId }) => outputId),
    ).toEqual(["post-install-file"]);
  });

  it("fails closed instead of selecting a hook phase from ambiguous normalized ids", () => {
    const selection = plan({
      channels: [
        channel("telegram", [
          {
            channelId: "telegram",
            id: "shared-hook",
            phase: "post-agent-install",
            handler: "telegram.post-install",
          },
        ]),
        channel(" TELEGRAM ", [
          {
            channelId: " TELEGRAM ",
            id: "shared-hook",
            phase: "render",
            handler: "telegram.render",
          },
        ]),
      ],
      buildSteps: [buildFile("TELEGRAM", "ambiguous-file", "shared-hook")],
    });

    expect(selectEnabledPostAgentInstallBuildFiles(selection)).toEqual([]);
  });

  it("fails closed when a build step references a missing hook", () => {
    const selection = plan({
      channels: [
        channel("telegram", [
          {
            channelId: "telegram",
            id: "post-install",
            phase: "post-agent-install",
            handler: "telegram.post-install",
          },
        ]),
      ],
      buildSteps: [buildFile("telegram", "stale-hook-file", "missing-hook")],
    });

    expect(selectEnabledPostAgentInstallBuildFiles(selection)).toEqual([]);
  });
});
