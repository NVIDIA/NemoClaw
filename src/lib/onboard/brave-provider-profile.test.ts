// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  BRAVE_PROVIDER_PROFILE_ID,
  braveProviderProfilePath,
  ensureBraveProviderProfile,
  shouldEnableBraveWebSearch,
} from "./brave-provider-profile";

function makeDeps(runOpenshell: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    root: "/repo",
    runOpenshell,
    redact: (s: string) => s,
    log: vi.fn(),
    exit: vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }),
    ...overrides,
  } as Parameters<typeof ensureBraveProviderProfile>[1];
}

describe("ensureBraveProviderProfile", () => {
  it("does nothing when no token def is brave-typed", () => {
    const runOpenshell = vi.fn();
    ensureBraveProviderProfile([{ providerType: "generic", token: "tok" }], makeDeps(runOpenshell));
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does nothing when the brave token def has no token", () => {
    const runOpenshell = vi.fn();
    ensureBraveProviderProfile(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: null }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("imports the Brave profile from the blueprint path on first run", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));
    ensureBraveProviderProfile(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "import", "--file", braveProviderProfilePath("/repo")],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("treats an existing-profile diagnostic as success on re-onboard", () => {
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stderr: "custom provider profile 'brave' already exists",
      stdout: "",
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).not.toThrow();
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("exits with the OpenShell status when import fails for a non-idempotent reason", () => {
    const runOpenshell = vi.fn(() => ({
      status: 2,
      stderr: "schema validation error: missing endpoints",
      stdout: "",
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:2/);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });
});

describe("shouldEnableBraveWebSearch", () => {
  it("returns false for null/undefined web search config", () => {
    expect(shouldEnableBraveWebSearch(null)).toBe(false);
    expect(shouldEnableBraveWebSearch(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is missing or falsy", () => {
    // Regression for #3626: a `{ fetchEnabled: false }` config previously
    // tripped `if (webSearchConfig)` in createSandbox and pushed a Brave
    // provider/token plus the BRAVE_API_KEY abort even though the runtime
    // gate downstream is `fetchEnabled`.
    expect(shouldEnableBraveWebSearch({})).toBe(false);
    expect(shouldEnableBraveWebSearch({ fetchEnabled: false })).toBe(false);
    expect(shouldEnableBraveWebSearch({ fetchEnabled: null })).toBe(false);
  });

  it("returns true only when fetchEnabled is explicitly true", () => {
    expect(shouldEnableBraveWebSearch({ fetchEnabled: true })).toBe(true);
  });
});
