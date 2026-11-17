// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { cloneSandboxWorkloadReceipt } from "../state/registry/workload";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
  readStoredManagedStartupProfileMetadata,
} from "./managed-startup/profile";
import { readStoredWorkloadProfileMetadata } from "./managed-startup/stored-profile";

const TEAMS_RENDER_IDENTITY = {
  channelId: "teams",
  renderId: "teams-openclaw-channel",
  hookId: "teams-openclaw-channel",
  handler: "common.staticOutputs",
  kind: "json-fragment",
  agent: "openclaw",
  target: "openclaw.json",
  path: "channels.msteams",
} as const;

// Keys are sorted because stored profiles are canonical JSON.
const CURRENT_VALUE = {
  appId: "teams-app",
  enabled: true,
  legacyWebhook: { port: 3978 },
  webhook: { path: "/api/messages" },
};
// OpenClaw before 2026.10.5 rendered the listener port inside webhook.
const PRE_10_5_VALUE = {
  appId: "teams-app",
  enabled: true,
  webhook: { path: "/api/messages", port: 3978 },
};

function currentProfile(): ManagedStartupProfile {
  return {
    ...managedStartupE2eProfile("openclaw"),
    messaging: {
      plan: {
        schemaVersion: 1,
        agent: "openclaw",
        agentRender: [{ ...TEAMS_RENDER_IDENTITY, value: CURRENT_VALUE }],
      },
    },
  };
}

/** Re-encode the valid current profile with a different Teams render, keeping its key order. */
function encodeWithRender(value: unknown, identity: Record<string, unknown> = {}): string {
  const profile = JSON.parse(
    Buffer.from(encodeManagedStartupProfile(currentProfile()), "base64url").toString("utf8"),
  ) as { messaging: { plan: { agentRender: object[] } } };
  Object.assign(profile.messaging.plan.agentRender[0] as object, identity, { value });
  return Buffer.from(JSON.stringify(profile), "utf8").toString("base64url");
}

describe("stored Teams managed startup profiles (#14540)", () => {
  it("reads a profile written before the webhook port moved", () => {
    const encoded = encodeWithRender(PRE_10_5_VALUE);
    expect(readStoredWorkloadProfileMetadata(encoded).agent).toBe("openclaw");
    // The validators that managed startup runs stay strict.
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/credential-shaped field name/);
    expect(() => readStoredManagedStartupProfileMetadata(encoded)).toThrow(
      /credential-shaped field name/,
    );
    expect(
      cloneSandboxWorkloadReceipt({
        schemaVersion: 1,
        kind: "managed-image",
        reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"1".repeat(64)}`,
        release: "v0.0.130",
        sourceRevision: "2".repeat(40),
        sourceCohort: "ghrun-1-1",
        capabilityContractVersion: 1,
        startupProfileContractVersion: 1,
        encodedProfile: encoded,
        startupProfileSha256: createHash("sha256").update(encoded).digest("hex"),
        credentialProxyReplayRequired: false,
        shared: true,
      }),
    ).toMatchObject({ kind: "managed-image", encodedProfile: encoded });
  });

  it("still reads the current render", () => {
    const encoded = encodeManagedStartupProfile(currentProfile());
    expect(decodeManagedStartupProfile(encoded).agent).toBe("openclaw");
    expect(readStoredWorkloadProfileMetadata(encoded)).toEqual(
      readStoredManagedStartupProfileMetadata(encoded),
    );
  });

  it.each([
    ["an extra webhook field", { webhook: { path: "/api/messages", port: 3978, secret: "x" } }, {}],
    ["a different webhook path", { webhook: { path: "/hook", port: 3978 } }, {}],
    ["an out-of-range port", { webhook: { path: "/api/messages", port: 70_000 } }, {}],
    ["a string port", { webhook: { path: "/api/messages", port: "3978" } }, {}],
    [
      "both webhook shapes at once",
      { webhook: { path: "/api/messages", port: 3978 }, legacyWebhook: { port: 3978 } },
      {},
    ],
    ["another channel's render", {}, { channelId: "slack" }],
    ["another render id", {}, { renderId: "teams-other" }],
  ] as const)("rejects a stored profile with %s", (_label, overrides, identity) => {
    const encoded = encodeWithRender({ ...PRE_10_5_VALUE, ...overrides }, identity);
    expect(() => readStoredWorkloadProfileMetadata(encoded)).toThrow(
      /credential-shaped field name/,
    );
  });
});
