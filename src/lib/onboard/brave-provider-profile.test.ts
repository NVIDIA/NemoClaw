// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { parseCheckedInProviderProfileContract } from "../adapters/openshell/provider-profile";
import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  BRAVE_PROVIDER_PROFILE_ID,
  braveProviderProfilePath,
  ensureBraveProviderProfile,
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
  shouldEnableBraveWebSearch,
  TAVILY_PROVIDER_PROFILE_ID,
  type WebSearchProviderProfileId,
  webSearchProviderProfilePath,
} from "./brave-provider-profile";

function makeDeps(runOpenshell: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) {
  return {
    root: REPOSITORY_ROOT,
    runOpenshell,
    redact: (s: string) => s,
    log: vi.fn(),
    exit: vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }),
    ...overrides,
  } as Parameters<typeof ensureBraveProviderProfile>[1];
}

function exactExport(provider: WebSearchProviderProfileId) {
  const source = fs.readFileSync(webSearchProviderProfilePath(REPOSITORY_ROOT, provider), "utf8");
  const contract = parseCheckedInProviderProfileContract(source);
  expect(contract, `invalid test profile: ${provider}`).not.toBeNull();
  return {
    status: 0,
    stderr: "",
    stdout: JSON.stringify(contract!.boundary, (_key, value) =>
      value === null ? undefined : value,
    ),
  };
}

function exactProfileRunner() {
  return vi.fn((args: string[]) => exactExport(args[3] as WebSearchProviderProfileId));
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

  it("accepts an exact existing Brave profile without importing it", () => {
    const runOpenshell = exactProfileRunner();
    ensureBraveProviderProfile(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", BRAVE_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("validates Tavily and Brave profiles when both have tokens", () => {
    const runOpenshell = exactProfileRunner();
    ensureWebSearchProviderProfiles(
      [
        { providerType: TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" },
        { providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" },
      ],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "profile", "export", TAVILY_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "export", BRAVE_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("uses a versioned Hermes profile instead of accepting a stale Tavily profile", () => {
    const runOpenshell = exactProfileRunner();

    ensureWebSearchProviderProfiles(
      [{ providerType: HERMES_TAVILY_PROVIDER_PROFILE_ID, token: "tvly-test" }],
      makeDeps(runOpenshell),
    );

    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", HERMES_TAVILY_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("imports and verifies a missing Brave profile", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile 'brave' not found", stdout: "" })
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "" })
      .mockReturnValueOnce(exactExport(BRAVE_PROVIDER_PROFILE_ID));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).not.toThrow();
    expect(deps.exit).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "profile", "import", "--file", braveProviderProfilePath(REPOSITORY_ROOT)],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(runOpenshell).toHaveBeenNthCalledWith(
      3,
      ["provider", "profile", "export", BRAVE_PROVIDER_PROFILE_ID, "--output", "json"],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
  });

  it("rejects an incompatible existing Brave profile without importing it", () => {
    const incompatible = exactExport(BRAVE_PROVIDER_PROFILE_ID);
    const runOpenshell = vi.fn(() => ({
      ...incompatible,
      stdout: JSON.stringify({ ...JSON.parse(incompatible.stdout), endpoints: [] }),
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:1/);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(runOpenshell).toHaveBeenCalledOnce();
  });

  it("preserves the OpenShell status when a missing profile cannot be imported", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile 'brave' not found", stdout: "" })
      .mockReturnValueOnce({
        status: 2,
        stderr: "schema validation error: missing endpoints",
        stdout: "",
      });
    const deps = makeDeps(runOpenshell);

    expect(() =>
      ensureBraveProviderProfile(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:2/u);
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
