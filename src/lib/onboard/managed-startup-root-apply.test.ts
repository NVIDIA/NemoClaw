// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import {
  createManagedStartupRootApplyRequest,
  MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES,
  parseManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "./managed-startup/root-apply";

function requestFor(
  agent: "openclaw" | "hermes" | "langchain-deepagents-code",
  withCorporateCa = false,
) {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(
      managedStartupE2eProfile(agent, false, withCorporateCa),
    ),
    ...(withCorporateCa
      ? { corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).toString("base64") }
      : {}),
  });
}

describe("managed startup root-application envelope", () => {
  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("round-trips one canonical bounded %s request", (agent) => {
    const request = requestFor(agent, true);
    const serialized = serializeManagedStartupRootApplyRequest(request);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(
      MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES,
    );
    expect(parseManagedStartupRootApplyRequest(serialized)).toEqual(request);
  });

  it("rejects non-canonical JSON and unknown fields", () => {
    const request = requestFor("openclaw");
    const reordered = `${JSON.stringify({
      schemaVersion: request.schemaVersion,
      profileFingerprint: request.profileFingerprint,
      encodedProfile: request.encodedProfile,
      corporateCaB64: request.corporateCaB64,
      agent: request.agent,
    })}\n`;
    const withUnknownField = `${JSON.stringify({
      ...JSON.parse(serializeManagedStartupRootApplyRequest(request)),
      surprise: true,
    })}\n`;

    expect(() => parseManagedStartupRootApplyRequest(reordered)).toThrow(/not canonical/u);
    expect(() => parseManagedStartupRootApplyRequest(withUnknownField)).toThrow(/invalid schema/u);
  });

  it("rejects a tampered profile fingerprint", () => {
    const request = requestFor("hermes");
    const parsed = JSON.parse(serializeManagedStartupRootApplyRequest(request)) as Record<
      string,
      unknown
    >;
    parsed.profileFingerprint = "f".repeat(64);

    expect(() => parseManagedStartupRootApplyRequest(`${JSON.stringify(parsed)}\n`)).toThrow(
      /fingerprint does not match/u,
    );
  });

  it("rejects a canonical CA payload that does not match the profile digest", () => {
    const profile = managedStartupE2eProfile("langchain-deepagents-code", false, true);

    expect(() =>
      createManagedStartupRootApplyRequest({
        agent: profile.agent,
        encodedProfile: encodeManagedStartupProfile(profile),
        corporateCaB64: Buffer.from("different-ca").toString("base64"),
      }),
    ).toThrow(/does not match the profile digest/u);
  });

  it("rejects an oversized serialized transport before parsing JSON", () => {
    expect(() =>
      parseManagedStartupRootApplyRequest("x".repeat(MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES + 1)),
    ).toThrow(/empty or too large/u);
  });
});
