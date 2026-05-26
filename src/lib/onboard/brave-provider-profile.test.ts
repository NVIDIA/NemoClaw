// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  BRAVE_PROVIDER_PROFILE_ID,
  braveProviderProfilePath,
  ensureBraveProviderProfile,
} from "./brave-provider-profile";

function makeDeps(
  runOpenshell: ReturnType<typeof vi.fn>,
  overrides: Record<string, unknown> = {},
) {
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
    ensureBraveProviderProfile(
      [{ providerType: "generic", token: "tok" }],
      makeDeps(runOpenshell),
    );
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
