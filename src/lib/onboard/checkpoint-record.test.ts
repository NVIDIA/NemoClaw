// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decisionDeclined,
  decisionSelected,
  decisionUnset,
} from "../state/onboard-checkpoint-decision";
import { CHECKPOINT_SCHEMA_VERSION } from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import {
  recordCheckpointProviderEffectGroup,
  recordCheckpointProviderEffectGroups,
} from "./checkpoint-record";

const ISO = "2026-01-01T00:00:00.000Z";

function sessionWithProviderReceipts() {
  const session = createSession({ sandboxName: "my-assistant" });
  session.checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    machineState: "sandbox",
    updatedAt: ISO,
    sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
    webSearch: decisionDeclined(),
    messaging: decisionDeclined(),
    resourceProfile: decisionUnset(),
    gatewayAuthority: decisionUnset(),
    effectGroups: {
      web_search_provider: { completedAt: ISO, fingerprint: "old-web" },
      messaging_providers: { completedAt: ISO, fingerprint: "old-chat" },
      sandbox_create: { completedAt: ISO, fingerprint: "create" },
    },
    bindings: {
      credentialEnvs: ["OLD_WEB_KEY", "SHARED_KEY"],
      registeredProviders: [
        { name: "old-web", type: "brave", credentialEnv: "OLD_WEB_KEY" },
        { name: "old-chat", type: "generic", credentialEnv: "SHARED_KEY" },
      ],
    },
    sandboxRecreate: null,
  };
  return session;
}

describe("recordCheckpointProviderEffectGroups", () => {
  it("replaces the provider ledger with both current groups and keeps shared credential keys", () => {
    const session = sessionWithProviderReceipts();

    recordCheckpointProviderEffectGroups(session, {
      webSearch: [{ name: "new-web", type: "tavily", credentialEnv: "SHARED_KEY" }],
      messaging: [{ name: "new-chat", type: "generic", credentialEnv: "SHARED_KEY" }],
    });

    expect(session.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SHARED_KEY"],
      registeredProviders: [
        { name: "new-web", type: "tavily", credentialEnv: "SHARED_KEY" },
        { name: "new-chat", type: "generic", credentialEnv: "SHARED_KEY" },
      ],
    });
    expect(session.checkpoint?.effectGroups).toMatchObject({
      web_search_provider: { fingerprint: "new-web" },
      messaging_providers: { fingerprint: "new-chat" },
      sandbox_create: { completedAt: ISO, fingerprint: "create" },
    });
  });

  it("clears a disabled group and its obsolete bindings without removing the other group", () => {
    const session = sessionWithProviderReceipts();
    const currentChat = { name: "current-chat", type: "generic", credentialEnv: "SHARED_KEY" };

    recordCheckpointProviderEffectGroups(session, {
      webSearch: [],
      messaging: [currentChat],
    });

    expect(session.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SHARED_KEY"],
      registeredProviders: [currentChat],
    });
    expect(session.checkpoint?.effectGroups.web_search_provider).toBeUndefined();
    expect(session.checkpoint?.effectGroups.messaging_providers?.fingerprint).toBe("current-chat");
    expect(session.checkpoint?.effectGroups.sandbox_create).toEqual({
      completedAt: ISO,
      fingerprint: "create",
    });
  });

  it("rejects duplicate provider names instead of recording ambiguous ownership", () => {
    const session = sessionWithProviderReceipts();
    const previousCheckpoint = session.checkpoint;

    expect(() =>
      recordCheckpointProviderEffectGroups(session, {
        webSearch: [{ name: "shared", type: "tavily", credentialEnv: "TAVILY_API_KEY" }],
        messaging: [{ name: "shared", type: "generic", credentialEnv: "SLACK_BOT_TOKEN" }],
      }),
    ).toThrow("provider effect groups contain invalid or duplicate credential bindings");
    expect(session.checkpoint).toBe(previousCheckpoint);
  });

  it("rejects incomplete provider bindings instead of recording an invalid receipt", () => {
    const session = sessionWithProviderReceipts();
    const previousCheckpoint = session.checkpoint;

    expect(() =>
      recordCheckpointProviderEffectGroups(session, {
        webSearch: [{ name: "new-web", type: "tavily", credentialEnv: "" }],
        messaging: [],
      }),
    ).toThrow("provider effect groups contain invalid or duplicate credential bindings");
    expect(session.checkpoint).toBe(previousCheckpoint);
  });
});

describe("recordCheckpointProviderEffectGroup", () => {
  it("records a completed group before the next provider group starts", () => {
    const session = sessionWithProviderReceipts();
    const currentWeb = {
      name: "current-web",
      type: "tavily",
      credentialEnv: "CURRENT_WEB_KEY",
    };

    recordCheckpointProviderEffectGroup(session, "web_search_provider", [currentWeb]);

    expect(session.checkpoint?.effectGroups.web_search_provider?.fingerprint).toBe(currentWeb.name);
    expect(session.checkpoint?.effectGroups.messaging_providers?.fingerprint).toBe("old-chat");
    expect(session.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SHARED_KEY", "CURRENT_WEB_KEY"],
      registeredProviders: [
        { name: "old-chat", type: "generic", credentialEnv: "SHARED_KEY" },
        currentWeb,
      ],
    });
  });

  it("adopts a same-name unowned binding and removes its replaced credential key", () => {
    const session = sessionWithProviderReceipts();
    const checkpoint = session.checkpoint;
    expect(checkpoint).toBeDefined();
    const orphan = {
      name: "current-web",
      type: "tavily",
      credentialEnv: "ORPHAN_WEB_KEY",
    };
    const currentWeb = {
      name: orphan.name,
      type: orphan.type,
      credentialEnv: "CURRENT_WEB_KEY",
    };
    session.checkpoint = {
      ...checkpoint!,
      bindings: {
        credentialEnvs: [...checkpoint!.bindings.credentialEnvs, orphan.credentialEnv],
        registeredProviders: [...checkpoint!.bindings.registeredProviders, orphan],
      },
    };

    recordCheckpointProviderEffectGroup(session, "web_search_provider", [currentWeb]);

    expect(session.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SHARED_KEY", "CURRENT_WEB_KEY"],
      registeredProviders: [
        { name: "old-chat", type: "generic", credentialEnv: "SHARED_KEY" },
        currentWeb,
      ],
    });
    expect(session.checkpoint?.effectGroups.web_search_provider?.fingerprint).toBe(currentWeb.name);
  });

  it("clears an empty provider group and its owned binding", () => {
    const session = sessionWithProviderReceipts();

    recordCheckpointProviderEffectGroup(session, "web_search_provider", []);

    expect(session.checkpoint?.effectGroups.web_search_provider).toBeUndefined();
    expect(session.checkpoint?.effectGroups.messaging_providers?.fingerprint).toBe("old-chat");
    expect(session.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SHARED_KEY"],
      registeredProviders: [{ name: "old-chat", type: "generic", credentialEnv: "SHARED_KEY" }],
    });
  });

  it("rejects a malformed previous group receipt without changing the checkpoint", () => {
    const session = sessionWithProviderReceipts();
    const checkpoint = session.checkpoint;
    const previousReceipt = checkpoint?.effectGroups.web_search_provider;
    expect(checkpoint).toBeDefined();
    expect(previousReceipt).toBeDefined();
    session.checkpoint = {
      ...checkpoint!,
      effectGroups: {
        ...checkpoint!.effectGroups,
        web_search_provider: { ...previousReceipt!, fingerprint: ",old-web" },
      },
    };
    const previousCheckpoint = session.checkpoint;

    expect(() =>
      recordCheckpointProviderEffectGroup(session, "web_search_provider", [
        { name: "current-web", type: "tavily", credentialEnv: "CURRENT_WEB_KEY" },
      ]),
    ).toThrow("provider effect group receipt contains invalid or duplicate provider names");
    expect(session.checkpoint).toBe(previousCheckpoint);
  });

  it("rejects a provider name owned by the other group without changing the checkpoint", () => {
    const session = sessionWithProviderReceipts();
    const previousCheckpoint = session.checkpoint;

    expect(() =>
      recordCheckpointProviderEffectGroup(session, "web_search_provider", [
        { name: "old-chat", type: "tavily", credentialEnv: "CURRENT_WEB_KEY" },
      ]),
    ).toThrow("provider effect group conflicts with another group's provider ownership");
    expect(session.checkpoint).toBe(previousCheckpoint);
  });
});
