// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  BRAVE_PROVIDER_PROFILE_ID,
  braveProviderProfilePath,
  ensureWebSearchProviderProfiles,
  HERMES_TAVILY_PROVIDER_PROFILE_ID,
  shouldEnableWebSearch,
  TAVILY_PROVIDER_PROFILE_ID,
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
  } as Parameters<typeof ensureWebSearchProviderProfiles>[1];
}

const MATCHING_BRAVE_EXPORT = {
  status: 0,
  stderr: "",
  stdout: JSON.stringify({
    id: "brave",
    credentials: [
      {
        name: "api_key",
        env_vars: ["BRAVE_API_KEY"],
        required: true,
        auth_style: "header",
        header_name: "x-subscription-token",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host: "api.search.brave.com",
        port: 443,
        protocol: "rest",
        access: "read-write",
        enforcement: "enforce",
      },
    ],
    binaries: ["/usr/local/bin/node", "/usr/bin/node", "/usr/local/bin/curl", "/usr/bin/curl"],
    inference_capable: false,
  }),
};

const MATCHING_TAVILY_EXPORT = {
  status: 0,
  stderr: "",
  stdout: JSON.stringify({
    id: "tavily",
    credentials: [
      {
        name: "api_key",
        env_vars: ["TAVILY_API_KEY"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host: "api.tavily.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: true,
        rules: [
          { allow: { method: "POST", path: "/search" } },
          { allow: { method: "POST", path: "/extract" } },
        ],
      },
    ],
    binaries: [
      "/opt/venv/bin/python3*",
      "/usr/local/bin/node",
      "/usr/bin/node",
      "/usr/local/bin/curl",
      "/usr/bin/curl",
    ],
    inference_capable: false,
  }),
};

const MATCHING_HERMES_TAVILY_EXPORT = {
  status: 0,
  stderr: "",
  stdout: JSON.stringify({
    id: "tavily-hermes-v1",
    credentials: [
      {
        name: "api_key",
        env_vars: ["TAVILY_API_KEY"],
        required: true,
        auth_style: "bearer",
        header_name: "authorization",
        query_param: "",
      },
    ],
    endpoints: [
      {
        host: "api.tavily.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        request_body_credential_rewrite: true,
        rules: [
          { allow: { method: "POST", path: "/search" } },
          { allow: { method: "POST", path: "/extract" } },
        ],
      },
    ],
    binaries: ["/opt/hermes/.venv/bin/python", "/usr/local/bin/curl", "/usr/bin/curl"],
    inference_capable: false,
  }),
};

function matchingProfileRunner() {
  const exportsById = {
    [BRAVE_PROVIDER_PROFILE_ID]: MATCHING_BRAVE_EXPORT,
    [TAVILY_PROVIDER_PROFILE_ID]: MATCHING_TAVILY_EXPORT,
    [HERMES_TAVILY_PROVIDER_PROFILE_ID]: MATCHING_HERMES_TAVILY_EXPORT,
  };
  return vi.fn((args: string[]) => exportsById[args[3] as keyof typeof exportsById]);
}

describe("ensureWebSearchProviderProfiles", () => {
  it("does nothing when no token def is brave-typed", () => {
    const runOpenshell = vi.fn();
    ensureWebSearchProviderProfiles(
      [{ providerType: "generic", token: "tok" }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does nothing when the brave token def has no token", () => {
    const runOpenshell = vi.fn();
    ensureWebSearchProviderProfiles(
      [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: null }],
      makeDeps(runOpenshell),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("accepts an exact existing Brave profile without importing it", () => {
    const runOpenshell = matchingProfileRunner();
    ensureWebSearchProviderProfiles(
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
    const runOpenshell = matchingProfileRunner();
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
    const runOpenshell = matchingProfileRunner();

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
      .mockReturnValueOnce(MATCHING_BRAVE_EXPORT);
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
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
    const incompatible = MATCHING_BRAVE_EXPORT;
    const runOpenshell = vi.fn(() => ({
      ...incompatible,
      stdout: JSON.stringify({ ...JSON.parse(incompatible.stdout), endpoints: [] }),
    }));
    const deps = makeDeps(runOpenshell);
    expect(() =>
      ensureWebSearchProviderProfiles(
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
      ensureWebSearchProviderProfiles(
        [{ providerType: BRAVE_PROVIDER_PROFILE_ID, token: "brv-test" }],
        deps,
      ),
    ).toThrow(/exit:2/u);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });
});

describe("shouldEnableWebSearch", () => {
  it("returns false for null/undefined web search config", () => {
    expect(shouldEnableWebSearch(null)).toBe(false);
    expect(shouldEnableWebSearch(undefined)).toBe(false);
  });

  it("returns false when fetchEnabled is missing or falsy", () => {
    // Regression for #3626: a `{ fetchEnabled: false }` config previously
    // tripped `if (webSearchConfig)` in createSandbox and pushed a Brave
    // provider/token plus the BRAVE_API_KEY abort even though the runtime
    // gate downstream is `fetchEnabled`.
    expect(shouldEnableWebSearch({})).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: false })).toBe(false);
    expect(shouldEnableWebSearch({ fetchEnabled: null })).toBe(false);
  });

  it("returns true only when fetchEnabled is explicitly true", () => {
    expect(shouldEnableWebSearch({ fetchEnabled: true })).toBe(true);
  });
});
