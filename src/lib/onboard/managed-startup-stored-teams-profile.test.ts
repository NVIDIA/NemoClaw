// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import type { SandboxWorkloadReceipt } from "../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../state/registry/workload";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "./managed-image/contract";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
  readStoredManagedStartupProfileMetadata,
} from "./managed-startup/profile";
import { readStoredWorkloadProfile } from "./managed-startup/stored-profile";
import { readManagedWorkloadAuthority } from "./workload/authority";

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

type ManagedReceipt = Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;

function receiptFor(encodedProfile: string): ManagedReceipt {
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64",
    release: "v0.0.130",
    sourceRevision: "d".repeat(40),
    sourceCohort: "ghrun-100-1",
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile,
    startupProfileSha256: sha256(encodedProfile),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("stored Teams managed startup profiles (#14540)", () => {
  it("converts a profile written before the webhook port moved to the current form", () => {
    const encoded = encodeWithRender(PRE_10_5_VALUE);
    const current = encodeManagedStartupProfile(currentProfile());
    expect(readStoredWorkloadProfile(encoded)).toMatchObject({
      encodedProfile: current,
      agent: "openclaw",
    });
    // The validators that managed startup runs stay strict.
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/credential-shaped field name/);
    expect(() => readStoredManagedStartupProfileMetadata(encoded)).toThrow(
      /credential-shaped field name/,
    );
  });

  it("loads the old receipt as a current-form receipt with a matching digest", () => {
    const encoded = encodeWithRender(PRE_10_5_VALUE);
    const current = encodeManagedStartupProfile(currentProfile());
    const loaded = cloneSandboxWorkloadReceipt(receiptFor(encoded));
    expect(loaded).toMatchObject({
      kind: "managed-image",
      encodedProfile: current,
      startupProfileSha256: sha256(current),
    });
    // Saving and loading again keeps the converted form.
    expect(cloneSandboxWorkloadReceipt(loaded)).toEqual(loaded);
  });

  it("lets managed workload authority read the old receipt for rebuild, clone and snapshot", () => {
    const encoded = encodeWithRender(PRE_10_5_VALUE);
    const current = encodeManagedStartupProfile(currentProfile());
    const receipt = receiptFor(encoded);
    const authority = readManagedWorkloadAuthority({
      agent: "openclaw",
      fromDockerfile: null,
      imageTag: receipt.reference,
      workload: receipt,
    });
    expect(authority?.receipt).toMatchObject({
      encodedProfile: current,
      startupProfileSha256: sha256(current),
    });
    expect(authority?.profile).toEqual(decodeManagedStartupProfile(current));
    expect(() => decodeManagedStartupProfile(encoded)).toThrow(/credential-shaped field name/);
  });

  it("still reads the current render unchanged", () => {
    const encoded = encodeManagedStartupProfile(currentProfile());
    expect(decodeManagedStartupProfile(encoded).agent).toBe("openclaw");
    expect(readStoredWorkloadProfile(encoded)).toEqual({
      encodedProfile: encoded,
      ...readStoredManagedStartupProfileMetadata(encoded),
    });
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
    expect(() => readStoredWorkloadProfile(encoded)).toThrow(/credential-shaped field name/);
    expect(cloneSandboxWorkloadReceipt(receiptFor(encoded))).toBeUndefined();
  });
});
