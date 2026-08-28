// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { strictEqual } from "node:assert";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
} from "../managed-startup/profile";
import {
  createManagedStartupRootApplyRequest,
  MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES,
  serializeManagedStartupRootApplyRequest,
} from "../managed-startup/root-apply";
import {
  MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES,
  MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
  MANAGED_BOOTSTRAP_REQUEST_TAR_PATH,
  parseManagedBootstrapEnvelope,
  parseManagedBootstrapImageCompletion,
  serializeManagedBootstrapEnvelope,
  serializeManagedBootstrapEnvelopeTar,
  serializeManagedBootstrapImageCompletion,
} from "./envelope";

function requestFor(agent: ManagedStartupAgent) {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, false)),
  });
}

describe("managed bootstrap envelope", () => {
  it.each(MANAGED_STARTUP_AGENTS)(
    "round-trips one canonical identity-bound %s root request",
    (agent) => {
      const request = requestFor(agent);
      const identity = "a".repeat(64);
      const serialized = serializeManagedBootstrapEnvelope({
        bootstrapIdentity: identity,
        rootApplyRequest: request,
      });

      expect(parseManagedBootstrapEnvelope(serialized)).toEqual({
        schemaVersion: 1,
        bootstrapIdentity: identity,
        rootApplyRequest: request,
      });
    },
  );

  it("rejects malformed identities and non-canonical transport", () => {
    const request = requestFor("openclaw");
    const identity = "a".repeat(64);
    const serialized = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: identity,
      rootApplyRequest: request,
    });

    expect(parseManagedBootstrapEnvelope(serialized)).toEqual({
      schemaVersion: 1,
      bootstrapIdentity: identity,
      rootApplyRequest: request,
    });
    expect(() => parseManagedBootstrapEnvelope(` ${serialized}`)).toThrow(/canonical/u);
    expect(() => parseManagedBootstrapEnvelope(`${serialized}\0`)).toThrow(/contains NUL/u);
    expect(() =>
      serializeManagedBootstrapEnvelope({
        bootstrapIdentity: "not-an-identity",
        rootApplyRequest: request,
      }),
    ).toThrow(/bootstrap identity/u);
  });

  it("serializes a root-owned mode 0400 ustar request for stopped-container staging", () => {
    const rootApplyRequest = requestFor("openclaw");
    const bootstrapIdentity = "d".repeat(64);
    const payload = Buffer.from(
      serializeManagedBootstrapEnvelope({ bootstrapIdentity, rootApplyRequest }),
      "utf8",
    );
    const archive = serializeManagedBootstrapEnvelopeTar({ bootstrapIdentity, rootApplyRequest });
    const header = archive.subarray(0, 512);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);

    expect(header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "")).toBe(
      MANAGED_BOOTSTRAP_REQUEST_TAR_PATH,
    );
    expect(header.subarray(100, 108).toString("ascii")).toBe("0000400\0");
    expect(header.subarray(108, 116).toString("ascii")).toBe("0000000\0");
    expect(header.subarray(116, 124).toString("ascii")).toBe("0000000\0");
    expect(Number.parseInt(header.subarray(124, 136).toString("ascii"), 8)).toBe(payload.length);
    expect(header.subarray(156, 157).toString("ascii")).toBe("0");
    expect(header.subarray(257, 263).toString("ascii")).toBe("ustar\0");
    expect(Number.parseInt(header.subarray(148, 154).toString("ascii"), 8)).toBe(
      checksumHeader.reduce((sum, byte) => sum + byte, 0),
    );
    expect(archive.subarray(512, 512 + payload.length)).toEqual(payload);
    expect(archive.subarray(-1024)).toEqual(Buffer.alloc(1024));
  });

  it("round-trips a valid near-limit request after base64 expansion", () => {
    const corporateCa = Buffer.alloc(128 * 1024, 0x61);
    const profile = managedStartupE2eProfile("openclaw", false, false);
    strictEqual(profile.agentConfig.agent, "openclaw");
    const agentConfig = profile.agentConfig;
    const encodedProfile = encodeManagedStartupProfile({
      ...profile,
      agentConfig: {
        ...agentConfig,
        extraAgents: {
          ...agentConfig.extraAgents,
          defaults: Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [
              `padding-${String(index).padStart(3, "0")}`,
              "x".repeat(220),
            ]),
          ),
        },
      },
      corporateCa: {
        bundleSha256: createHash("sha256").update(corporateCa).digest("hex"),
      },
    });
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile,
      corporateCaB64: corporateCa.toString("base64"),
    });
    const rootRequestBytes = Buffer.byteLength(
      serializeManagedStartupRootApplyRequest(request),
      "utf8",
    );
    const serialized = serializeManagedBootstrapEnvelope({
      bootstrapIdentity: "c".repeat(64),
      rootApplyRequest: request,
    });

    expect(Math.ceil(rootRequestBytes / 3) * 4).toBeGreaterThan(
      MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES + 1024,
    );
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES,
    );
    expect(parseManagedBootstrapEnvelope(serialized).rootApplyRequest).toEqual(request);
  });

  it.each(MANAGED_STARTUP_AGENTS)(
    "round-trips a canonical identity-bound %s image completion receipt",
    (agent) => {
      const request = requestFor(agent);
      const completion = {
        agent: request.agent,
        bootstrapIdentity: "b".repeat(64),
        profileFingerprint: request.profileFingerprint,
        transactionPending: true,
      } as const;
      expect(
        parseManagedBootstrapImageCompletion(serializeManagedBootstrapImageCompletion(completion)),
      ).toEqual({ schemaVersion: 1, ...completion });
    },
  );

  it("reports image completion field failures precisely", () => {
    const completion = {
      agent: "openclaw",
      bootstrapIdentity: "b".repeat(64),
      profileFingerprint: requestFor("openclaw").profileFingerprint,
      transactionPending: true,
    } as const;
    expect(() =>
      serializeManagedBootstrapImageCompletion({ ...completion, bootstrapIdentity: "invalid" }),
    ).toThrow(/identity is invalid/u);
    expect(() =>
      serializeManagedBootstrapImageCompletion({ ...completion, agent: "invalid" as never }),
    ).toThrow(/agent is invalid/u);
    expect(() =>
      serializeManagedBootstrapImageCompletion({
        ...completion,
        transactionPending: "invalid" as never,
      }),
    ).toThrow(/transaction state is invalid/u);
  });

  it("bounds image-owned completion input before parsing", () => {
    expect(() =>
      parseManagedBootstrapImageCompletion(" ".repeat(MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES + 1)),
    ).toThrow(/too large/u);
    expect(() => parseManagedBootstrapImageCompletion("{}\0")).toThrow(/contains NUL/u);
  });
});
