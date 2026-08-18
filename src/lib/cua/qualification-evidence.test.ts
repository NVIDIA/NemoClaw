// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseCuaQualificationEnvironment } from "./qualification-evidence";

const candidate = {
  schemaVersion: "1.0.0",
  kind: "cua-candidate-environment",
  nemoclawCommit: "a".repeat(40),
  bundleReceiptSha256: "b".repeat(64),
  runtimeManifestSha256: "c".repeat(64),
};

describe("CUA candidate environment", () => {
  it("accepts only the narrow content-free install authority", () => {
    expect(parseCuaQualificationEnvironment(candidate)).toEqual(candidate);
  });

  it.each([
    { gpu: { count: 1 } },
    { scenarios: ["browser"] },
    { receipt: { status: "passed" } },
    { targetChannel: { endpoint: "private.invalid" } },
  ])("rejects later-slice qualification and lifecycle evidence [case %#]", (extra) => {
    expect(() => parseCuaQualificationEnvironment({ ...candidate, ...extra })).toThrow(
      /contain exactly/,
    );
  });

  it("rejects malformed build and receipt identities", () => {
    expect(() =>
      parseCuaQualificationEnvironment({ ...candidate, nemoclawCommit: "main" }),
    ).toThrow(/invalid identity/);
    expect(() =>
      parseCuaQualificationEnvironment({ ...candidate, bundleReceiptSha256: "sha256:bad" }),
    ).toThrow(/invalid identity/);
  });
});
