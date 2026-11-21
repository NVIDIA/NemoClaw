// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../../adapters/openshell/provider-adapter";
import type { SandboxMessagingPlan } from "../../manifest";
import type { MessagingCredentialProviderEphemeralInput } from "../types";

export const target = { kind: "named", gatewayName: "nemoclaw" } as const;
export const plan: SandboxMessagingPlan = {
  schemaVersion: 1,
  sandboxName: "alpha",
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
};

export function definition(
  overrides: Partial<MessagingCredentialProviderEphemeralInput> = {},
): MessagingCredentialProviderEphemeralInput {
  return {
    channelId: "telegram",
    credentialId: "TELEGRAM_BOT_TOKEN",
    providerName: "alpha-telegram-bridge",
    providerType: "nemoclaw-messaging-v1",
    credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "telegram-secret" }],
    profile: { profilePath: "/repo/messaging.yaml", profileType: "nemoclaw-messaging-v1" },
    ...overrides,
  };
}

export function metadata(input: MessagingCredentialProviderEphemeralInput) {
  return {
    name: input.providerName,
    type: input.providerType,
    credentialKeys: input.credentials.map(({ name }) => name),
    configKeys: [],
  };
}

export function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  return {
    ensureProviderPolicyComposition: vi
      .fn<OpenShellProviderAdapter["ensureProviderPolicyComposition"]>()
      .mockResolvedValue({ ok: true, value: undefined }),
    listProviders: vi
      .fn<OpenShellProviderAdapter["listProviders"]>()
      .mockResolvedValue({ ok: true, value: { names: [] } }),
    createProvider: vi
      .fn<OpenShellProviderAdapter["createProvider"]>()
      .mockResolvedValue({ ok: true }),
    getProvider: vi.fn<OpenShellProviderAdapter["getProvider"]>().mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "provider not found" },
    }),
    updateProvider: vi
      .fn<OpenShellProviderAdapter["updateProvider"]>()
      .mockResolvedValue({ ok: true }),
    importProviderProfile: vi
      .fn<OpenShellProviderAdapter["importProviderProfile"]>()
      .mockResolvedValue({ ok: true }),
    inspectProviderProfile: vi
      .fn<OpenShellProviderAdapter["inspectProviderProfile"]>()
      .mockResolvedValue({ ok: true, value: { credentialKeys: [] } }),
    deleteProvider: vi
      .fn<OpenShellProviderAdapter["deleteProvider"]>()
      .mockResolvedValue({ ok: true }),
    detachProvider: vi
      .fn<OpenShellProviderAdapter["detachProvider"]>()
      .mockResolvedValue({ ok: true, value: { changed: true } }),
    attachProvider: vi
      .fn<OpenShellProviderAdapter["attachProvider"]>()
      .mockResolvedValue({ ok: true }),
    listProviderAttachments: vi
      .fn<OpenShellProviderAdapter["listProviderAttachments"]>()
      .mockResolvedValue({ ok: true, value: { names: [] } }),
    configureProviderRefresh: vi
      .fn<OpenShellProviderAdapter["configureProviderRefresh"]>()
      .mockResolvedValue({ ok: true }),
    getProviderRefreshStatus: vi
      .fn<OpenShellProviderAdapter["getProviderRefreshStatus"]>()
      .mockResolvedValue({ ok: true, value: { status: "refreshed" } }),
    ...overrides,
  };
}
