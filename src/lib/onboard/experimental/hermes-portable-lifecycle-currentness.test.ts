// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { hermesPortableLifecycleInternals } from "./hermes-portable-lifecycle";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    path: "/state/active.json",
    identity: { dev: 1n, ino: 2n },
    sha256: "a".repeat(64),
    bytes: Buffer.from("active"),
    receipt: { policy: { intendedSemanticSha256: "b".repeat(64) } },
    successor: {
      path: "/state/authority.json",
      identity: { dev: 1n, ino: 3n },
      sha256: "c".repeat(64),
      bytes: Buffer.from("authority"),
    },
    ...overrides,
  };
}

describe("Hermes portable requalified authority currentness", () => {
  it("retains the exact receipt and operation-local authority generation", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => published) as never,
    );

    expect(() => assertCurrent()).not.toThrow();
    expect(assertOperatingAuthority).toHaveBeenCalledOnce();
  });

  it("rejects receipt replacement before checking operation-local authority", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => snapshot({ identity: { dev: 1n, ino: 4n } })) as never,
    );

    expect(() => assertCurrent()).toThrow(
      "receipt authority changed after schema-6 requalification",
    );
    expect(assertOperatingAuthority).not.toHaveBeenCalled();
  });

  it("rejects same-content successor inode replacement", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const replacement = snapshot({
      successor: {
        path: "/state/authority.json",
        identity: { dev: 1n, ino: 4n },
        sha256: "c".repeat(64),
        bytes: Buffer.from("authority"),
      },
    });
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => replacement) as never,
    );

    expect(() => assertCurrent()).toThrow(
      "receipt authority changed after schema-6 requalification",
    );
    expect(assertOperatingAuthority).not.toHaveBeenCalled();
  });

  it("propagates socket or executable drift after the receipt remains current", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn(() => {
      throw new Error("operation-local filesystem or runtime identity changed");
    });
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => published) as never,
    );

    expect(() => assertCurrent()).toThrow("operation-local filesystem or runtime identity changed");
  });
});
