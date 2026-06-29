// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { reconcileReusedSandboxMessaging } from "./sandbox-messaging";

const channelIds = ["telegram", "unsupported"];

function mixedChannelPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: channelId === "telegram",
      selected: true,
      configured: true,
      disabled: channelId !== "telegram",
      inputs: [],
      hooks: [],
    })),
    disabledChannels: ["unsupported"],
    credentialBindings: channelIds.map((channelId) => ({
      channelId,
      credentialId: "token",
      sourceInput: "token",
      providerName: `alpha-${channelId}`,
      providerEnvKey: `${channelId.toUpperCase()}_TOKEN`,
      placeholder: `openshell:resolve:env:${channelId.toUpperCase()}_TOKEN`,
      credentialAvailable: true,
    })),
    networkPolicy: {
      presets: [...channelIds],
      entries: channelIds.map((channelId) => ({
        channelId,
        presetName: channelId,
        policyKeys: [`${channelId}_api`],
        source: "manifest",
      })),
    },
    agentRender: channelIds.map((channelId) => ({
      channelId,
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      path: `channels.${channelId}`,
      value: { enabled: true },
      templateRefs: [],
    })),
    buildSteps: channelIds.map((channelId) => ({
      channelId,
      kind: "build-arg",
      outputId: `${channelId}-arg`,
      required: true,
      value: "enabled",
    })),
    runtimeSetup: {
      nodePreloads: channelIds.map((channelId) => ({
        channelId,
        module: `${channelId}-preload`,
        source: "manifest",
        target: "agent",
      })),
      secretScans: channelIds.map((channelId) => ({
        channelId,
        path: `/sandbox/${channelId}`,
        pattern: "secret",
        message: "secret found",
      })),
    },
    stateUpdates: channelIds.map((channelId) => ({
      channelId,
      kind: "persist-inputs",
      stateKey: `${channelId}Config`,
      inputIds: ["token"],
    })),
    healthChecks: channelIds.map((channelId) => ({
      channelId,
      phase: "health-check",
      requiredBefore: "lifecycle-success",
      hookIds: [`${channelId}-health`],
    })),
  };
}

function channelIdsFrom<T extends { readonly channelId: string }>(entries: readonly T[]): string[] {
  return entries.map((entry) => entry.channelId);
}

describe("reconcileReusedSandboxMessaging", () => {
  it("removes every unsupported channel artifact from a reused plan", () => {
    const result = reconcileReusedSandboxMessaging(
      mixedChannelPlan(),
      { name: "openclaw" },
      { clearPlanEnv() {} },
    );
    const filtered = result.plan;

    expect(filtered).not.toBeNull();
    expect(result.selectedChannels).toEqual(["telegram"]);
    expect(result.changed).toBe(true);
    expect({
      channels: channelIdsFrom(filtered?.channels ?? []),
      disabledChannels: filtered?.disabledChannels,
      credentialBindings: channelIdsFrom(filtered?.credentialBindings ?? []),
      networkPolicyPresets: filtered?.networkPolicy.presets,
      networkPolicyEntries: channelIdsFrom(filtered?.networkPolicy.entries ?? []),
      agentRender: channelIdsFrom(filtered?.agentRender ?? []),
      buildSteps: channelIdsFrom(filtered?.buildSteps ?? []),
      nodePreloads: channelIdsFrom(filtered?.runtimeSetup?.nodePreloads ?? []),
      secretScans: channelIdsFrom(filtered?.runtimeSetup?.secretScans ?? []),
      stateUpdates: channelIdsFrom(filtered?.stateUpdates ?? []),
      healthChecks: channelIdsFrom(filtered?.healthChecks ?? []),
    }).toEqual({
      channels: ["telegram"],
      disabledChannels: [],
      credentialBindings: ["telegram"],
      networkPolicyPresets: ["telegram"],
      networkPolicyEntries: ["telegram"],
      agentRender: ["telegram"],
      buildSteps: ["telegram"],
      nodePreloads: ["telegram"],
      secretScans: ["telegram"],
      stateUpdates: ["telegram"],
      healthChecks: ["telegram"],
    });
  });
});
