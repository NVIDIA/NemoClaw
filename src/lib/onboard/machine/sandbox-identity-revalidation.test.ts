// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createRegisteredSandboxIdentityRevalidation,
  fingerprintSandboxRecreateValue,
} from "../sandbox-recreate-transaction";

const TARGET_ID = fingerprintSandboxRecreateValue("target-id");
const FOREIGN_ID = fingerprintSandboxRecreateValue("foreign-id");

function registration() {
  return {
    name: "alpha",
    gatewayName: "owner-gateway",
    lifecycleGeneration: "22222222-2222-4222-8222-222222222222",
    lifecycleLiveIdentityFingerprint: TARGET_ID,
  };
}

describe("registered sandbox identity revalidation", () => {
  it("revalidates registered and live identity at a mutation edge (#12033)", () => {
    const expected = registration();
    const readRegistration = vi.fn(() => expected);
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: TARGET_ID,
    }));
    const revalidate = createRegisteredSandboxIdentityRevalidation(expected, {
      readRegistration,
      observe,
    });

    revalidate?.("update sandbox config");

    expect(readRegistration).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledExactlyOnceWith("alpha", "owner-gateway");
  });

  it("rejects registered or live identity drift before a mutation (#12033)", () => {
    const expected = registration();
    const current = { ...expected };
    const observe = vi.fn(() => ({
      state: "ready" as const,
      liveIdentityFingerprint: TARGET_ID,
    }));
    const revalidate = createRegisteredSandboxIdentityRevalidation(expected, {
      readRegistration: () => current,
      observe,
    })!;

    current.lifecycleGeneration = "33333333-3333-4333-8333-333333333333";
    expect(() => revalidate("update sandbox config")).toThrow(/registered identity.*changed/u);
    expect(observe).not.toHaveBeenCalled();

    current.lifecycleGeneration = expected.lifecycleGeneration;
    observe.mockReturnValue({ state: "ready", liveIdentityFingerprint: FOREIGN_ID });
    expect(() => revalidate("update sandbox config")).toThrow(/live identity.*changed/u);
  });

  it("withholds authority when the durable identity is incomplete (#12033)", () => {
    expect(
      createRegisteredSandboxIdentityRevalidation(
        { ...registration(), lifecycleLiveIdentityFingerprint: undefined },
        { readRegistration: vi.fn(), observe: vi.fn() },
      ),
    ).toBeUndefined();
  });
});
