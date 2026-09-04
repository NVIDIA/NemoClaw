// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS,
  MANAGED_IMAGE_HERMES_SUPPORTED_PLATFORMS,
} from "../../../agents/hermes/config/managed-policy.ts";
import { MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES } from "../../../scripts/generate-openclaw-config.mts";
import {
  applyMessagingBuildPhase,
  collectManagedImageHermesUvPackages,
  collectManagedImageOpenClawPluginInstallSpecs,
  installManagedImageCapabilityUnion,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";
import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../src/lib/messaging/channels/built-ins.ts";
import type { ChannelManifest, MessagingAgentId } from "../../../src/lib/messaging/manifest/types.ts";

function renderedIds(
  manifest: ChannelManifest,
  agent: MessagingAgentId,
  pathPrefix: string,
): string[] {
  return manifest.render.flatMap((render) =>
    render.agent === agent &&
    render.kind === "json-fragment" &&
    render.fragment.path.startsWith(pathPrefix)
      ? [render.fragment.path.slice(pathPrefix.length)]
      : [],
  );
}

describe("managed-image capability union", () => {
  it("derives the complete all-agent package union from trusted manifests (#7744)", () => {
    expect(collectManagedImageOpenClawPluginInstallSpecs({ OPENCLAW_VERSION: "2026.7.1" })).toEqual(
      [
        "npm:@openclaw/discord@2026.7.1",
        "npm:@tencent-weixin/openclaw-weixin@2.4.3",
        "npm:@openclaw/slack@2026.7.1",
        "npm:@openclaw/whatsapp@2026.7.1",
        "npm:@openclaw/msteams@2026.7.1",
        "npm:@openclaw/googlechat@2026.7.1",
      ],
    );
    expect(collectManagedImageHermesUvPackages()).toEqual([
      "microsoft-teams-apps==2.0.13.4",
      "google-cloud-pubsub==2.39.0",
      "google-api-python-client==2.194.0",
      "google-auth==2.55.1",
    ]);
  });

  it("keeps the neutral config contract aligned with every supported manifest (#7744)", () => {
    const openClawCapabilities = BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) =>
      manifest.supportedAgents.some((agent) => agent === "openclaw"),
    ).flatMap((manifest) =>
      renderedIds(manifest, "openclaw", "plugins.entries.").map((pluginId) => ({
        channelId: manifest.runtime?.openclaw?.channelName,
        pluginId,
      })),
    );
    const hermesPlatforms = BUILT_IN_CHANNEL_MANIFESTS.filter((manifest) =>
      manifest.supportedAgents.some((agent) => agent === "hermes"),
    ).flatMap((manifest) => renderedIds(manifest, "hermes", "platforms."));

    expect(MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES).toEqual(openClawCapabilities);
    expect(MANAGED_IMAGE_OPENCLAW_MESSAGING_CAPABILITIES).toContainEqual({
      channelId: "googlechat",
      pluginId: "googlechat",
    });
    expect(MANAGED_IMAGE_HERMES_SUPPORTED_PLATFORMS).toEqual(hermesPlatforms);
    expect(MANAGED_IMAGE_HERMES_NEUTRAL_PLATFORMS).toEqual([
      "a2a",
      "bluebubbles",
      "buzz",
      "dingtalk",
      "discord",
      "email",
      "feishu",
      "google_chat",
      "homeassistant",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "msgraph_webhook",
      "ntfy",
      "photon",
      "qqbot",
      "raft",
      "relay",
      "signal",
      "simplex",
      "slack",
      "sms",
      "teams",
      "telegram",
      "wecom",
      "wecom_callback",
      "weixin",
      "whatsapp",
      "whatsapp_cloud",
      "webhook",
      "yuanbao",
    ]);
  });

  it("emits no runtime activation artifact for a neutral capability union (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-neutral-union-"));
    const runtimePlanPath = path.join(temporaryRoot, "messaging-runtime-plan.json");

    try {
      expect(
        applyMessagingBuildPhase(null, "runtime-setup", {
          NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
          NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH: runtimePlanPath,
        }),
      ).toEqual([]);
      expect(fs.existsSync(runtimePlanPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("requires explicit neutral-image mode before installing the union (#7744)", () => {
    expect(() =>
      installManagedImageCapabilityUnion("hermes", {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
      }),
    ).toThrow(
      "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
    );
  });

  it("installs the pinned Hermes union through its reviewed package boundary (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-union-"));
    const trace = path.join(temporaryRoot, "uv.trace");
    fs.writeFileSync(
      path.join(temporaryRoot, "uv"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$UV_TRACE"\n',
      { mode: 0o755 },
    );

    try {
      installManagedImageCapabilityUnion("hermes", {
        PATH: `${temporaryRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        UV_TRACE: trace,
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      });
      expect(fs.readFileSync(trace, "utf8").trim()).toBe(
        "pip install --python /opt/hermes/.venv/bin/python --no-cache -- microsoft-teams-apps==2.0.13.4 google-cloud-pubsub==2.39.0 google-api-python-client==2.194.0 google-auth==2.55.1",
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
