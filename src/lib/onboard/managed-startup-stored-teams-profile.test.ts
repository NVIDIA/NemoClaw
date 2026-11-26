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
  MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES,
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

  it("rejects the old receipt when its stored digest does not match the stored profile", () => {
    const encoded = encodeWithRender(PRE_10_5_VALUE);
    const convertedDigest = sha256(encodeManagedStartupProfile(currentProfile()));
    const withDigest = (startupProfileSha256: string) => ({
      ...receiptFor(encoded),
      startupProfileSha256,
    });
    expect(cloneSandboxWorkloadReceipt(withDigest(convertedDigest))).toBeUndefined();
    expect(cloneSandboxWorkloadReceipt(withDigest(sha256("another profile")))).toBeUndefined();
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

  describe("noncanonical encodings of the old profile", () => {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    /** The old profile's canonical JSON text, with an app id long enough to leave spare base64 bits. */
    function legacyTextWith(appIdSuffix: string): string {
      return Buffer.from(
        encodeWithRender({ ...PRE_10_5_VALUE, appId: `teams-app${appIdSuffix}` }),
        "base64url",
      ).toString("utf8");
    }

    function legacyText(): string {
      const plain = legacyTextWith("");
      // One extra character moves a multiple-of-three byte length off the boundary.
      return legacyTextWith("x".repeat(Number(Buffer.byteLength(plain, "utf8") % 3 === 0)));
    }

    const encode = (bytes: Buffer): string => bytes.toString("base64url");

    function variants(): Array<[string, string]> {
      const text = legacyText();
      const canonical = encode(Buffer.from(text, "utf8"));
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const last = canonical[canonical.length - 1];
      const spareBitsAlias = canonical.slice(0, -1) + ALPHABET[ALPHABET.indexOf(last) ^ 1];
      return [
        ["padding", canonical + "=".repeat((4 - (canonical.length % 4)) % 4 || 1)],
        ["the standard alphabet", canonical.slice(0, 8) + "+/" + canonical.slice(10)],
        [
          "a remainder of one character",
          canonical + "A".repeat((((1 - canonical.length) % 4) + 4) % 4 || 4),
        ],
        ["spare trailing bits", spareBitsAlias],
        ["whitespace in the JSON", encode(Buffer.from(JSON.stringify(parsed, null, 1), "utf8"))],
        [
          "unsorted keys",
          encode(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())))),
        ],
        [
          "a duplicate key",
          encode(Buffer.from(text.replace('"agent":', '"agent":"hermes","agent":'), "utf8")),
        ],
        [
          "invalid UTF-8 inside a string",
          encode(
            Buffer.concat([
              Buffer.from(text.slice(0, text.indexOf("teams-app")), "utf8"),
              Buffer.from([0xff]),
              Buffer.from(text.slice(text.indexOf("teams-app")), "utf8"),
            ]),
          ),
        ],
      ];
    }

    it("builds a canonical legacy profile that converts, so each variant below is the only change", () => {
      const text = legacyText();
      expect(Buffer.byteLength(text, "utf8") % 3).not.toBe(0);
      expect(readStoredWorkloadProfile(encode(Buffer.from(text, "utf8"))).agent).toBe("openclaw");
    });

    it.each(variants())(
      "rejects %s in the profile reader and in the receipt loader",
      (_label, encoded) => {
        expect(() => readStoredWorkloadProfile(encoded)).toThrow();
        expect(cloneSandboxWorkloadReceipt(receiptFor(encoded))).toBeUndefined();
      },
    );

    it("rejects an encoded profile past the size limit", () => {
      const encoded = "A".repeat(MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES + 4);
      expect(() => readStoredWorkloadProfile(encoded)).toThrow();
      expect(cloneSandboxWorkloadReceipt(receiptFor(encoded))).toBeUndefined();
    });
  });
});
