// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CUA_LIFECYCLE_SCHEMA_VERSION } from "./contract";
import { parseCuaTargetManifest } from "./schema";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;

function targetManifest(): Record<string, unknown> {
  return {
    schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
    kind: "target-manifest",
    identityDigest: digest("1"),
    platform: "fixture-linux-amd64",
    image: {
      name: "fixture-image",
      version: "1.0.0",
      digest: digest("2"),
      owner: "fixture",
    },
    serviceBundle: {
      name: "fixture-services",
      version: "1.0.0",
      digest: digest("3"),
      owner: "fixture",
    },
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
  };
}

describe("CUA target manifest schema (#7751)", () => {
  it("accepts only immutable target and capability identities", () => {
    expect(parseCuaTargetManifest(targetManifest())).toEqual(targetManifest());
  });

  it("rejects credential-shaped or transport fields", () => {
    expect(() =>
      parseCuaTargetManifest({ ...targetManifest(), serviceToken: "not-public" }),
    ).toThrow("does not match its schema");
    expect(() =>
      parseCuaTargetManifest({ ...targetManifest(), endpoint: "https://target.invalid" }),
    ).toThrow("does not match its schema");

    const unsafePlatform = targetManifest();
    unsafePlatform.platform = "target.invalid";
    expect(() => parseCuaTargetManifest(unsafePlatform)).toThrow(/coordinate- and credential-free/);

    const unsafeComponent = targetManifest();
    (unsafeComponent.serviceBundle as Record<string, unknown>).owner = "operator@target.invalid";
    expect(() => parseCuaTargetManifest(unsafeComponent)).toThrow(
      /coordinate- and credential-free/,
    );
  });

  it("requires browser, computer, and terminal exactly once", () => {
    const duplicate = targetManifest();
    duplicate.capabilities = [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ];
    expect(() => parseCuaTargetManifest(duplicate)).toThrow(
      "must declare browser, computer, and terminal once",
    );
  });
});
